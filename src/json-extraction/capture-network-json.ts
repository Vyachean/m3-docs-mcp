import type { Page, Response } from 'playwright';
import { classifyJsonResponse } from './classify-json-response.js';
import { buildJsonPageBundleFromResponses, type JsonCapturedResponse, type JsonPageBundle, type JsonSelectionContext } from './json-bundle.js';

export function createNetworkJsonCapture(page: Page): {
  stop: () => void;
  stopAndDrain: () => Promise<void>;
  getResponses: () => JsonCapturedResponse[];
  buildBundle: (context?: JsonSelectionContext) => JsonPageBundle;
} {
  const responses: JsonCapturedResponse[] = [];
  const pending = new Set<Promise<void>>();
  const listener = async (response: Response) => {
    const url = response.url();
    if (!isRelevantJsonResponse(url)) return;
    const parsePromise = (async () => {
      if (!response.ok()) return;
      try {
        const payload = await response.json();
        responses.push(classifyJsonResponse({ url, payload }));
      } catch {
        // ignore non-JSON or truncated responses
      }
    })();
    pending.add(parsePromise);
    void parsePromise.finally(() => {
      pending.delete(parsePromise);
    });
  };

  page.on('response', listener);

  return {
    stop: () => {
      page.off('response', listener);
    },
    stopAndDrain: async () => {
      page.off('response', listener);
      await Promise.allSettled(Array.from(pending));
    },
    getResponses: () => responses.slice(),
    buildBundle: (context?: JsonSelectionContext) => buildBundleFromCapturedResponses(responses, context)
  };
}

export function buildBundleFromCapturedResponses(
  responses: JsonCapturedResponse[],
  context?: JsonSelectionContext
): JsonPageBundle {
  return buildJsonPageBundleFromResponses(responses, context);
}

function isRelevantJsonResponse(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return pathname.endsWith('.json')
      || pathname.includes('/page-data/')
      || pathname.includes('/_dsm/content/')
      || pathname.includes('/_dsm/data/');
  } catch {
    return /\.json(?:$|\?)/i.test(url);
  }
}
