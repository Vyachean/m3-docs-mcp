import { describe, expect, it } from 'vitest';
import { captureRequiredRoutesFromContext, type OracleBrowserContextLike, type OraclePageLike, type OracleResponseLike } from '../src/browser-oracle/capture-required-routes.js';

/**
 * Exercises captureRequiredRoutesFromContext's plumbing against a minimal fake Playwright
 * BrowserContext/Page (no real browser launch), following the same hand-rolled-fake convention
 * tests/crawler-flow.test.ts uses for its `vi.mock('playwright', ...)` fixture, but scoped down to
 * just the methods this module calls (goto/url/on/off/locator/close), since
 * captureRequiredRoutesFromContext depends on the OracleBrowserContextLike/OraclePageLike
 * structural interfaces rather than Playwright's full Page type.
 */

type FakeRouteFixture = {
  finalUrl: string;
  headings: string[];
  tableLabels: string[];
  networkResponses: Array<{ url: string; status: number }>;
  throwOnGoto?: boolean;
};

function createFakeContext(fixturesByRequestedUrl: Record<string, FakeRouteFixture>): {
  context: OracleBrowserContextLike;
  getPagesCreated: () => number;
  getClosedPages: () => number;
} {
  let pagesCreated = 0;
  let closedPages = 0;

  const context: OracleBrowserContextLike = {
    newPage: async (): Promise<OraclePageLike> => {
      pagesCreated += 1;
      let currentFixture: FakeRouteFixture | null = null;
      let currentUrl = '';
      const listeners = new Set<(response: OracleResponseLike) => void | Promise<void>>();

      const page: OraclePageLike = {
        goto: async (url) => {
          currentUrl = url;
          const fixture = fixturesByRequestedUrl[url];
          if (!fixture) throw new Error(`no fixture for ${url}`);
          if (fixture.throwOnGoto) throw new Error('simulated navigation failure');
          currentFixture = fixture;
          for (const response of fixture.networkResponses) {
            const responseLike: OracleResponseLike = {
              url: () => response.url,
              ok: () => response.status < 400,
              status: () => response.status,
              json: async () => ({}),
            };
            for (const listener of listeners) await listener(responseLike);
          }
        },
        url: () => currentFixture?.finalUrl ?? currentUrl,
        on: (event, listener) => {
          if (event === 'response') listeners.add(listener);
        },
        off: (event, listener) => {
          if (event === 'response') listeners.delete(listener);
        },
        locator: (selector: string) => ({
          allTextContents: async () => {
            if (!currentFixture) return [];
            if (selector.includes('h1')) return currentFixture.headings;
            return currentFixture.tableLabels;
          },
        }),
        close: async () => {
          closedPages += 1;
        },
      };
      return page;
    },
  };

  return { context, getPagesCreated: () => pagesCreated, getClosedPages: () => closedPages };
}

describe('captureRequiredRoutesFromContext', () => {
  it('captures network resources and DOM headings/table labels for each requested route', async () => {
    const fixturesByRequestedUrl: Record<string, FakeRouteFixture> = {
      'https://m3.material.io/components/switch/overview': {
        finalUrl: 'https://m3.material.io/components/switch/overview',
        headings: ['Switch', 'Usage'],
        tableLabels: ['Enabled', 'Disabled'],
        networkResponses: [
          { url: 'https://m3.material.io/page-data/components/switch/overview/page-data.json', status: 200 },
          { url: 'https://m3.material.io/_dsm/content/m3/abc.json', status: 200 },
          { url: 'https://m3.material.io/static/logo.png', status: 200 }
        ]
      },
      'https://m3.material.io/components/switch/specs': {
        finalUrl: 'https://m3.material.io/components/switch/specs',
        headings: ['Switch specs'],
        tableLabels: [],
        networkResponses: []
      }
    };

    const { context } = createFakeContext(fixturesByRequestedUrl);

    const report = await captureRequiredRoutesFromContext(context, {
      routes: ['/components/switch/overview', '/components/switch/specs']
    });

    expect(report.routes).toHaveLength(2);
    const overview = report.routes.find((r) => r.route === '/components/switch/overview');
    expect(overview?.navigationError).toBeNull();
    expect(overview?.finalUrl).toBe('https://m3.material.io/components/switch/overview');
    expect(overview?.dom?.headings).toEqual(['Switch', 'Usage']);
    expect(overview?.dom?.visibleTableLabels).toEqual(['Enabled', 'Disabled']);
    // Only JSON resources matching the relevant patterns are captured; the unrelated static asset
    // (logo.png) must be filtered out.
    expect(overview?.networkResources.map((r) => r.url).sort()).toEqual([
      'https://m3.material.io/_dsm/content/m3/abc.json',
      'https://m3.material.io/page-data/components/switch/overview/page-data.json'
    ]);
    expect(overview?.networkResources.find((r) => r.url.includes('page-data'))?.kind).toBe('page-data');
    expect(overview?.networkResources.find((r) => r.url.includes('_dsm/content'))?.kind).toBe('dsm-content');

    const specs = report.routes.find((r) => r.route === '/components/switch/specs');
    expect(specs?.dom?.headings).toEqual(['Switch specs']);
    expect(specs?.networkResources).toEqual([]);
  });

  it('records a navigationError and continues to the next route when one route fails to load', async () => {
    const fixturesByRequestedUrl: Record<string, FakeRouteFixture> = {
      'https://m3.material.io/components/buttons/overview': {
        finalUrl: '',
        headings: [],
        tableLabels: [],
        networkResponses: [],
        throwOnGoto: true
      },
      'https://m3.material.io/components/buttons/specs': {
        finalUrl: 'https://m3.material.io/components/buttons/specs',
        headings: ['Buttons specs'],
        tableLabels: [],
        networkResponses: []
      }
    };

    const { context } = createFakeContext(fixturesByRequestedUrl);

    const report = await captureRequiredRoutesFromContext(context, {
      routes: ['/components/buttons/overview', '/components/buttons/specs']
    });

    const failedRoute = report.routes.find((r) => r.route === '/components/buttons/overview');
    expect(failedRoute?.navigationError).toContain('simulated navigation failure');
    expect(failedRoute?.dom).toBeNull();

    const passedRoute = report.routes.find((r) => r.route === '/components/buttons/specs');
    expect(passedRoute?.navigationError).toBeNull();
    expect(passedRoute?.dom?.headings).toEqual(['Buttons specs']);
  });

  it('closes every page it opens, even when navigation fails', async () => {
    const fixturesByRequestedUrl: Record<string, FakeRouteFixture> = {
      'https://m3.material.io/styles/color/roles': {
        finalUrl: 'https://m3.material.io/styles/color/roles',
        headings: ['Color roles'],
        tableLabels: [],
        networkResponses: []
      }
    };
    const fixture = createFakeContext(fixturesByRequestedUrl);

    await captureRequiredRoutesFromContext(fixture.context, { routes: ['/styles/color/roles'] });

    expect(fixture.getPagesCreated()).toBe(1);
    expect(fixture.getClosedPages()).toBe(1);
  });
});
