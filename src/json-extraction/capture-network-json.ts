import type { Page, Response } from 'playwright';
import { extractPageDataMetadata, fallbackPageCanonId } from './extract-page-data.js';
import { classifyJsonResponse } from './classify-json-response.js';
import { createJsonPageBundle, type JsonCapturedResponse, type JsonPageBundle } from './json-bundle.js';

const RELEVANT_JSON_PATTERNS = [
  /\/page-data\/.+\.json$/i,
  /\/_dsm\/content\/m3\/.+\.json$/i,
  /\/_dsm\/data\/dsdb-m3\/.+\.json$/i,
  /TOKEN_TABLE\.[^/]+\.json$/i,
  /STATUS_TABLE/i
];

export function createNetworkJsonCapture(page: Page): {
  stop: () => void;
  getResponses: () => JsonCapturedResponse[];
  buildBundle: () => JsonPageBundle;
} {
  const responses: JsonCapturedResponse[] = [];
  const listener = async (response: Response) => {
    const url = response.url();
    if (!RELEVANT_JSON_PATTERNS.some((pattern) => pattern.test(url))) return;
    if (!response.ok()) return;

    try {
      const payload = await response.json();
      responses.push(classifyJsonResponse({ url, payload }));
    } catch {
      // ignore non-JSON or truncated responses
    }
  };

  page.on('response', listener);

  return {
    stop: () => {
      page.off('response', listener);
    },
    getResponses: () => responses.slice(),
    buildBundle: () => buildBundleFromCapturedResponses(responses)
  };
}

export function buildBundleFromCapturedResponses(responses: JsonCapturedResponse[]): JsonPageBundle {
  const pageData = responses.find((response) => response.type === 'page-metadata')?.payload ?? null;
  const contentPage = responses.find((response) => response.type === 'content-page')?.payload ?? null;
  const pageCanonId = extractPageDataMetadata(pageData).pageCanonId
    ?? fallbackPageCanonId(pageData)
    ?? null;
  return createJsonPageBundle({ pageData, contentPage, pageCanonId, responses });
}
