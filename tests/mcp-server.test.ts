import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import type { CacheStatus, MaterialIndex, RefreshOptions, SearchResult } from '../src/types.js';

type ToolSchema = Record<string, ZodTypeAny>;
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  outputSchema?: ZodTypeAny;
};

const mocks = vi.hoisted(() => {
  const toolHandlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  const toolDefinitions: ToolDefinition[] = [];
  const serverConfigs: Array<{
    config: { name: string; version: string };
    options?: { instructions?: string };
  }> = [];
  const connect = vi.fn(async (_transport: unknown) => undefined);
  const createdStores: MockStore[] = [];
  const nextStores: MockStore[] = [];

  type MockStore = {
    cacheDir?: string;
    getStatus: ReturnType<typeof vi.fn<(maxAgeHours?: number) => Promise<CacheStatus>>>;
    getDiagnostics: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn<(options?: RefreshOptions) => Promise<MaterialIndex>>>;
    searchDocs: ReturnType<typeof vi.fn<(query: string, limit: number) => Promise<SearchResult[]>>>;
    getPage: ReturnType<typeof vi.fn>;
    getComponentDocs: ReturnType<typeof vi.fn>;
    listComponents: ReturnType<typeof vi.fn>;
  };

  const makeIndex = (): MaterialIndex => ({
    source: 'https://m3.material.io',
    capturedAt: '2026-05-18T00:00:00.000Z',
    pageCount: 1,
    attemptedPageCount: 1,
    failedPageCount: 0,
    failedUrls: [],
    pages: [{
      id: 'dialogs',
      title: 'Dialogs',
      url: 'https://m3.material.io/components/dialogs/overview',
      path: 'components/dialogs/overview.md',
      section: 'components/dialogs',
      headings: ['Dialogs'],
      capturedAt: '2026-05-18T00:00:00.000Z'
    }]
  });

  const makeStatus = (overrides: Partial<CacheStatus> = {}): CacheStatus => ({
    cacheDir: '/cache',
    hasCache: true,
    source: 'https://m3.material.io',
    capturedAt: '2026-05-18T00:00:00.000Z',
    pageCount: 1,
    attemptedPageCount: 1,
    failedPageCount: 0,
    failedUrls: [],
    ageMs: 60_000,
    ttlMs: 24 * 60 * 60 * 1000,
    isFresh: true,
    ...overrides
  });

  const makeStore = (status: CacheStatus = makeStatus()): MockStore => ({
    getStatus: vi.fn(async () => status),
    getDiagnostics: vi.fn(async () => ({ cacheDir: '/cache', latestDiagnosticsFile: null, latestLogFile: null, diagnostics: null })),
    refresh: vi.fn(async () => makeIndex()),
    searchDocs: vi.fn(async () => []),
    getPage: vi.fn(async () => null),
    getComponentDocs: vi.fn(async () => []),
    listComponents: vi.fn(async () => [])
  });

  return { toolHandlers, toolDefinitions, serverConfigs, connect, createdStores, nextStores, makeIndex, makeStatus, makeStore };
});

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    constructor(config: { name: string; version: string }, options?: { instructions?: string }) {
      mocks.serverConfigs.push({ config, options });
    }

    registerTool(
      name: string,
      config: { description: string; inputSchema: ToolSchema; outputSchema?: ZodTypeAny },
      handler: (args: Record<string, unknown>) => Promise<ToolResult>
    ) {
      mocks.toolDefinitions.push({ name, ...config });
      mocks.toolHandlers.set(name, handler);
    }

    async connect(transport: unknown) {
      return mocks.connect(transport);
    }
  }
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {}
}));

vi.mock('../src/cache.js', () => ({
  getDefaultCacheDir: () => '/default-cache'
}));

vi.mock('../src/store.js', () => ({
  MaterialDocsStore: class {
    constructor(cacheDir: string) {
      const store = mocks.nextStores.shift() ?? mocks.makeStore();
      store.cacheDir = cacheDir;
      mocks.createdStores.push(store);
      Object.assign(this, store);
    }
  }
}));

const { serveMcp } = await import('../src/mcp-server.js');

function parseToolResult(result: ToolResult) {
  const textPayload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
  expect(result.structuredContent).toEqual(textPayload);
  return textPayload;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const handler = mocks.toolHandlers.get(name);
  expect(handler).toBeDefined();
  const definition = mocks.toolDefinitions.find((tool) => tool.name === name);
  expect(definition).toBeDefined();
  const parsedArgs = Object.fromEntries(
    Object.entries(definition!.inputSchema).map(([key, schema]) => [key, schema.parse(args[key])])
  );
  return parseToolResult(await handler!(parsedArgs));
}

function schemaFor(toolName: string): ToolSchema {
  const definition = mocks.toolDefinitions.find((tool) => tool.name === toolName);
  expect(definition).toBeDefined();
  return definition!.inputSchema;
}

describe('serveMcp', () => {
  beforeEach(() => {
    mocks.toolHandlers.clear();
    mocks.toolDefinitions.length = 0;
    mocks.serverConfigs.length = 0;
    mocks.connect.mockClear();
    mocks.createdStores.length = 0;
    mocks.nextStores.length = 0;
    delete process.env.M3_DOCS_AUTO_UPDATE;
    delete process.env.M3_DOCS_MAX_AGE_HOURS;
    delete process.env.M3_DOCS_STARTUP_MAX_PAGES;
    delete process.env.M3_DOCS_STARTUP_CONCURRENCY;
  });

  it('registers agent guidance, primary tools first, output schemas, and the default cache directory', async () => {
    const store = mocks.makeStore();
    mocks.nextStores.push(store);

    await serveMcp({ autoUpdate: false });

    expect(mocks.serverConfigs).toHaveLength(1);
    expect(mocks.serverConfigs[0]?.config).toEqual({ name: 'm3-docs-mcp', version: '0.1.0' });
    expect(mocks.serverConfigs[0]?.options?.instructions).toContain('graph-oriented tools as the primary');
    expect(mocks.serverConfigs[0]?.options?.instructions).toContain('get_component_overview');
    expect(mocks.serverConfigs[0]?.options?.instructions).toContain('troubleshooting');
    expect(store.cacheDir).toBe('/default-cache');
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.toolDefinitions.map((tool) => tool.name)).toEqual([
      'get_component_overview',
      'search_structured_docs',
      'list_routes',
      'get_route',
      'get_page',
      'get_component_tokens',
      'get_component_tabs',
      'get_component_resources',
      'material_docs_cache_status',
      'search_material_docs',
      'get_material_page',
      'get_component_docs',
      'list_material_components',
      'refresh_material_docs',
      'material_docs_cache_diagnostics',
      'get_route_artifacts',
      'get_raw_artifact',
      'explain_route_coverage',
      'explain_resource_resolution'
    ]);
    expect(mocks.toolDefinitions.every((tool) => tool.description.length > 10)).toBe(true);
    expect(mocks.toolDefinitions.every((tool) => tool.outputSchema !== undefined)).toBe(true);
    expect(mocks.toolDefinitions.find((tool) => tool.name === 'search_material_docs')?.description).toContain('Compatibility/full-text tool');
    expect(mocks.toolDefinitions.find((tool) => tool.name === 'get_raw_artifact')?.description).toContain('Troubleshooting/provenance tool');
  });

  it('uses environment options for startup refresh and disables it through M3_DOCS_AUTO_UPDATE', async () => {
    process.env.M3_DOCS_AUTO_UPDATE = 'false';
    process.env.M3_DOCS_MAX_AGE_HOURS = '12';
    process.env.M3_DOCS_STARTUP_MAX_PAGES = '33';
    const store = mocks.makeStore(mocks.makeStatus({ isFresh: false }));
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache' });
    const status = await callTool('material_docs_cache_status', {});

    expect(store.refresh).not.toHaveBeenCalled();
    expect(store.getStatus).toHaveBeenCalledWith(12);
    expect(status).toMatchObject({ autoUpdate: false, refresh: { running: false, error: null } });
  });

  it('trims tool string inputs and validates tool bounds', async () => {
    await serveMcp({ cacheDir: '/cache', autoUpdate: false });

    const searchSchema = schemaFor('search_material_docs');
    expect(searchSchema.query.safeParse(' dialogs ').data).toBe('dialogs');
    expect(searchSchema.query.safeParse('   ').success).toBe(false);
    expect(searchSchema.limit.safeParse(0).success).toBe(false);
    expect(searchSchema.limit.safeParse(26).success).toBe(false);
    expect(searchSchema.limit.safeParse(10).success).toBe(true);

    const pageSchema = schemaFor('get_material_page');
    expect(pageSchema.pathOrUrl.safeParse(' /components/dialogs/overview.md ').data).toBe('/components/dialogs/overview.md');
    expect(pageSchema.pathOrUrl.safeParse('').success).toBe(false);

    const componentSchema = schemaFor('get_component_docs');
    expect(componentSchema.componentName.safeParse(' Dialogs ').data).toBe('Dialogs');
    expect(componentSchema.componentName.safeParse('  ').success).toBe(false);
    expect(componentSchema.includeMarkdown.safeParse(undefined).data).toBe(false);
    expect(componentSchema.maxPages.safeParse(undefined).data).toBe(10);
    expect(componentSchema.maxMarkdownChars.safeParse(undefined).data).toBe(20_000);

    const refreshSchema = schemaFor('refresh_material_docs');
    expect(refreshSchema.maxPages.safeParse(1).success).toBe(true);
    expect(refreshSchema.maxPages.safeParse(1000).success).toBe(true);
    expect(refreshSchema.maxPages.safeParse(1001).success).toBe(false);
    expect(refreshSchema.concurrency.safeParse(undefined).data).toBe(1);
    expect(refreshSchema.concurrency.safeParse(1).success).toBe(true);
    expect(refreshSchema.concurrency.safeParse(8).success).toBe(true);
    expect(refreshSchema.concurrency.safeParse(9).success).toBe(false);
    expect(refreshSchema.promotePartial.safeParse(undefined).data).toBe(false);
    expect(refreshSchema.force.safeParse(true).success).toBe(true);
  });

  it('starts a missing-cache refresh in the background and does not block search tools', async () => {
    let resolveRefresh: (index: MaterialIndex) => void = () => undefined;
    const store = mocks.makeStore(mocks.makeStatus({ hasCache: false, capturedAt: null, pageCount: 0, attemptedPageCount: 0, ageMs: null, isFresh: false }));
    store.refresh.mockImplementation(() => new Promise<MaterialIndex>((resolve) => { resolveRefresh = resolve; }));
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', startupMaxPages: 125 });
    await vi.waitFor(() => expect(store.refresh).toHaveBeenCalledWith(expect.objectContaining({
      maxPages: 125,
      concurrency: 1,
      maxPagesExplicit: true,
      promotePartial: false
    })));
    expect(store.refresh.mock.calls[0]?.[0]?.onProgress).toEqual(expect.any(Function));

    const result = await callTool('search_material_docs', { query: 'dialogs', limit: 5 });

    expect(result).toMatchObject({
      message: 'Material 3 docs cache is being built. Retry this tool after the background refresh completes.',
      results: [],
      refresh: { running: true, completedAt: null, error: null }
    });
    expect(store.getStatus).toHaveBeenCalledTimes(2);
    expect(store.searchDocs).not.toHaveBeenCalled();

    resolveRefresh(mocks.makeIndex());
    await vi.waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(1));
  });

  it('does not refresh a fresh existing cache on startup', async () => {
    const store = mocks.makeStore(mocks.makeStatus({ isFresh: true }));
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache' });
    await vi.waitFor(() => expect(store.getStatus).toHaveBeenCalledWith(168));

    expect(store.refresh).not.toHaveBeenCalled();
  });

  it('refreshes a stale cache in the background while continuing to serve it', async () => {
    let resolveRefresh: (index: MaterialIndex) => void = () => undefined;
    const searchResult: SearchResult = {
      title: 'Dialogs',
      url: 'https://m3.material.io/components/dialogs/overview',
      path: 'components/dialogs/overview.md',
      section: 'components/dialogs',
      headings: ['Dialogs'],
      score: 1,
      excerpt: 'Dialogs provide guidance.'
    };
    const store = mocks.makeStore(mocks.makeStatus({ isFresh: false, ageMs: 48 * 60 * 60 * 1000 }));
    store.refresh.mockImplementation(() => new Promise<MaterialIndex>((resolve) => { resolveRefresh = resolve; }));
    store.searchDocs.mockResolvedValue([searchResult]);
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', startupMaxPages: 250 });
    await vi.waitFor(() => expect(store.refresh).toHaveBeenCalledWith(expect.objectContaining({
      maxPages: 250,
      concurrency: 1,
      maxPagesExplicit: true,
      promotePartial: false
    })));

    const result = await callTool('search_material_docs', { query: 'dialogs', limit: 10 });
    expect(result).toMatchObject({
      cache: { hasCache: true, isFresh: false },
      results: [{
        title: searchResult.title,
        path: searchResult.path,
        sourceUrl: searchResult.url,
        section: searchResult.section,
        headings: searchResult.headings,
        excerpt: searchResult.excerpt,
        score: searchResult.score
      }],
      refresh: { running: true, completedAt: null, error: null }
    });
    expect(store.searchDocs).toHaveBeenCalledWith('dialogs', 10);

    resolveRefresh(mocks.makeIndex());
  });

  it('keeps a stale cache readable and reports a failed background refresh', async () => {
    const store = mocks.makeStore(mocks.makeStatus({ isFresh: false, ageMs: 48 * 60 * 60 * 1000 }));
    store.refresh.mockRejectedValue(new Error('refresh failed'));
    store.searchDocs.mockResolvedValue([]);
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache' });
    await vi.waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const status = await callTool('material_docs_cache_status', {});
      expect(status).toMatchObject({ refresh: { running: false, error: 'refresh failed' } });
    });

    const result = await callTool('search_material_docs', { query: 'dialogs', limit: 10 });
    expect(result).toMatchObject({
      cache: { hasCache: true, isFresh: false },
      results: [],
      refresh: { running: false, error: 'refresh failed' }
    });
    expect(store.searchDocs).toHaveBeenCalledWith('dialogs', 10);
  });

  it('uses the same store refresh path for explicit long-running refresh requests', async () => {
    const index = mocks.makeIndex();
    const store = mocks.makeStore();
    store.refresh.mockResolvedValue(index);
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    const result = await callTool('refresh_material_docs', { maxPages: 77 });

    expect(store.refresh).toHaveBeenCalledWith({ maxPages: 77, maxPagesExplicit: true, concurrency: 1, promotePartial: false, force: false });
    expect(result).toMatchObject({ pageCount: 1, source: 'https://m3.material.io' });
  });

  it('passes explicit forced refresh requests to the store', async () => {
    const index = mocks.makeIndex();
    const store = mocks.makeStore();
    store.refresh.mockResolvedValue(index);
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    await callTool('refresh_material_docs', { maxPages: 77, force: true });

    expect(store.refresh).toHaveBeenCalledWith({ maxPages: 77, maxPagesExplicit: true, concurrency: 1, promotePartial: false, force: true });
  });

  it('describes refresh_material_docs as deterministic JSON-first refresh with browser fallback disabled by default', async () => {
    const store = mocks.makeStore();
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });

    const refreshTool = mocks.toolDefinitions.find((tool) => tool.name === 'refresh_material_docs');
    expect(refreshTool?.description).toContain('deterministic JSON-based pipeline');
    expect(refreshTool?.description).toContain('Browser fallback is disabled by default');
    expect(refreshTool?.description).not.toContain('using Playwright');
  });

  it('returns summary-only diagnostics by default', async () => {
    const store = mocks.makeStore();
    store.getDiagnostics.mockResolvedValue({
      cacheDir: '/cache',
      latestDiagnosticsFile: '/cache/diagnostics/latest-update.json',
      latestLogFile: '/cache/logs/latest.jsonl',
      diagnostics: {
        runId: 'run-1',
        startedAt: '2026-06-18T00:00:00.000Z',
        finishedAt: '2026-06-18T00:00:05.000Z',
        promotionDecision: 'promoted',
        hasPreviousCache: true,
        previousPageCount: 9,
        generatedPageCount: 3,
        attemptedPages: 4,
        failedPages: 1,
        failedRoutes: ['https://m3.material.io/components/missing'],
        qualitySummary: { suspiciousPageCount: 0, rejectedRouteCount: 1, duplicateContentGroupCount: 0, shortPageCount: 0, duplicateTitleGroupCount: 0 },
        extractionDiagnostics: {
          routeDiagnostics: [
            { path: 'components/button/specs.md', url: 'https://m3.material.io/components/button/specs', sourceUsed: 'direct-json' },
            { path: 'components/missing.md', url: 'https://m3.material.io/components/missing', sourceUsed: 'failed', fallbackReason: 'json-fetch-failed' }
          ],
          pagesFailed: 1
        },
        coverageDiagnostics: { coverageHealth: 'partial', uncrawledDiscoveredUrls: ['/missing'] }
      }
    });
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    const result = await callTool('material_docs_cache_diagnostics', {});
    const diagnostics = result.diagnostics as Record<string, unknown>;

    expect(diagnostics.routeDiagnosticsAvailable).toBe(true);
    expect(diagnostics.routeDiagnosticsCount).toBe(2);
    expect(diagnostics).not.toHaveProperty('fullDiagnostics');
    expect(diagnostics).not.toHaveProperty('filteredRouteDiagnostics');
    expect(diagnostics.compactSummary).toMatchObject({
      pageCount: 3,
      attemptedPageCount: 4,
      failedPageCount: 1,
      failedUrls: ['https://m3.material.io/components/missing'],
      coverageHealth: 'partial'
    });
  });

  it('filters route diagnostics by failed/skipped/path/route and respects limit', async () => {
    const store = mocks.makeStore();
    store.getDiagnostics.mockResolvedValue({
      cacheDir: '/cache',
      latestDiagnosticsFile: '/cache/diagnostics/latest-update.json',
      latestLogFile: '/cache/logs/latest.jsonl',
      diagnostics: {
        extractionDiagnostics: {
          routeDiagnostics: [
            { path: 'components/buttons/specs.md', virtualRoute: 'components/buttons/specs.md', url: 'https://m3.material.io/components/buttons/specs', sourceUsed: 'direct-json', finalMethod: 'direct-json' },
            { path: 'components/failed.md', sourceRoute: 'components/failed', url: 'https://m3.material.io/components/failed', sourceUsed: 'failed', finalMethod: null, fallbackReasons: ['json-fetch-failed'] },
            { path: 'components/skipped.md', sourceRoute: 'components/skipped', virtualRoute: 'components/skipped.md', url: 'https://m3.material.io/components/skipped', sourceUsed: 'skipped', skippedReason: 'missing-page-reference', finalMethod: null, fallbackReasons: ['json-fetch-failed'] }
          ]
        }
      }
    });
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });

    const summaryOnly = await callTool('material_docs_cache_diagnostics', { summaryOnly: true });
    expect(summaryOnly.diagnostics as Record<string, unknown>).not.toHaveProperty('filteredRouteDiagnostics');

    const expandedSummary = await callTool('material_docs_cache_diagnostics', { summaryOnly: false });
    expect((expandedSummary.diagnostics as Record<string, unknown>).filteredRouteDiagnostics).toEqual([
      { path: 'components/buttons/specs.md', virtualRoute: 'components/buttons/specs.md', url: 'https://m3.material.io/components/buttons/specs', sourceUsed: 'direct-json', finalMethod: 'direct-json' },
      { path: 'components/failed.md', sourceRoute: 'components/failed', url: 'https://m3.material.io/components/failed', sourceUsed: 'failed', finalMethod: null, fallbackReasons: ['json-fetch-failed'] },
      { path: 'components/skipped.md', sourceRoute: 'components/skipped', virtualRoute: 'components/skipped.md', url: 'https://m3.material.io/components/skipped', sourceUsed: 'skipped', skippedReason: 'missing-page-reference', finalMethod: null, fallbackReasons: ['json-fetch-failed'] }
    ]);

    const failedOnly = await callTool('material_docs_cache_diagnostics', { failedOnly: true });
    expect((failedOnly.diagnostics as Record<string, unknown>).filteredRouteDiagnostics).toEqual([
      { path: 'components/failed.md', sourceRoute: 'components/failed', url: 'https://m3.material.io/components/failed', sourceUsed: 'failed', finalMethod: null, fallbackReasons: ['json-fetch-failed'] }
    ]);

    const skippedOnly = await callTool('material_docs_cache_diagnostics', { skippedOnly: true });
    expect((skippedOnly.diagnostics as Record<string, unknown>).filteredRouteDiagnostics).toEqual([
      { path: 'components/skipped.md', sourceRoute: 'components/skipped', virtualRoute: 'components/skipped.md', url: 'https://m3.material.io/components/skipped', sourceUsed: 'skipped', skippedReason: 'missing-page-reference', finalMethod: null, fallbackReasons: ['json-fetch-failed'] }
    ]);

    const byPath = await callTool('material_docs_cache_diagnostics', { path: '/components/skipped.md' });
    expect((byPath.diagnostics as Record<string, unknown>).filteredRouteDiagnostics).toEqual([
      { path: 'components/skipped.md', sourceRoute: 'components/skipped', virtualRoute: 'components/skipped.md', url: 'https://m3.material.io/components/skipped', sourceUsed: 'skipped', skippedReason: 'missing-page-reference', finalMethod: null, fallbackReasons: ['json-fetch-failed'] }
    ]);

    const byRoute = await callTool('material_docs_cache_diagnostics', { route: 'https://m3.material.io/components/failed' });
    expect((byRoute.diagnostics as Record<string, unknown>).filteredRouteDiagnostics).toEqual([
      { path: 'components/failed.md', sourceRoute: 'components/failed', url: 'https://m3.material.io/components/failed', sourceUsed: 'failed', finalMethod: null, fallbackReasons: ['json-fetch-failed'] }
    ]);

    const limited = await callTool('material_docs_cache_diagnostics', { summaryOnly: false, limit: 1 });
    expect(((limited.diagnostics as Record<string, unknown>).filteredRouteDiagnostics as unknown[])).toHaveLength(1);
  });

  it('keeps normal MCP tool responses compact and free of diagnostics dumps', async () => {
    const status = mocks.makeStatus({ coverageHealth: 'partial' });
    const store = mocks.makeStore(status);
    store.searchDocs.mockResolvedValue([{
      title: 'Buttons',
      url: 'https://m3.material.io/components/buttons/specs',
      path: 'components/buttons/specs.md',
      section: 'components/buttons',
      headings: ['Buttons'],
      score: 1,
      excerpt: 'Buttons docs'
    }]);
    store.getPage.mockResolvedValue({
      meta: {
        id: 'buttons',
        title: 'Buttons',
        url: 'https://m3.material.io/components/buttons/specs',
        path: 'components/buttons/specs.md',
        section: 'components/buttons',
        headings: ['Buttons'],
        capturedAt: '2026-05-18T00:00:00.000Z'
      },
      markdown: '# Buttons'
    });
    store.getComponentDocs.mockResolvedValue([{
      path: 'components/buttons/specs.md',
      title: 'Buttons',
      url: 'https://m3.material.io/components/buttons/specs',
      section: 'components/buttons',
      headings: ['Buttons'],
      markdown: '# Buttons'
    }]);
    store.listComponents.mockResolvedValue([{ component: 'buttons', section: 'components/buttons', path: 'components/buttons/specs.md' }]);
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });

    const responses = await Promise.all([
      callTool('search_material_docs', { query: 'buttons', limit: 5 }),
      callTool('get_material_page', { pathOrUrl: 'components/buttons/specs.md' }),
      callTool('get_component_docs', { componentName: 'Buttons', includeMarkdown: true, maxPages: 5, maxMarkdownChars: 2000 }),
      callTool('list_material_components', {}),
      callTool('material_docs_cache_status', {})
    ]);

    for (const response of responses) {
      const json = JSON.stringify(response);
      expect(json).not.toContain('extractionDiagnostics');
      expect(json).not.toContain('coverageDiagnostics');
      expect(json).not.toContain('routeDiagnostics');
      expect(json).not.toContain('tokenContextDiagnostics');
      expect(json).not.toContain('statusTableDiagnostics');
      expect(json).not.toContain('uncrawledDiscoveredUrls');
    }
  });

  it('returns full diagnostics only when explicitly requested', async () => {
    const diagnosticsPayload = {
      extractionDiagnostics: {
        routeDiagnostics: [{ path: 'components/button/specs.md', sourceUsed: 'direct-json' }]
      },
      coverageDiagnostics: {
        coverageHealth: 'verified'
      }
    };
    const store = mocks.makeStore();
    store.getDiagnostics.mockResolvedValue({
      cacheDir: '/cache',
      latestDiagnosticsFile: '/cache/diagnostics/latest-update.json',
      latestLogFile: '/cache/logs/latest.jsonl',
      diagnostics: diagnosticsPayload
    });
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    const result = await callTool('material_docs_cache_diagnostics', { includeFullDiagnostics: true });

    expect((result.diagnostics as Record<string, unknown>).fullDiagnostics).toEqual(diagnosticsPayload);
  });

  it('reports when route diagnostics are absent instead of pretending there are none', async () => {
    const store = mocks.makeStore();
    store.getDiagnostics.mockResolvedValue({
      cacheDir: '/cache',
      latestDiagnosticsFile: '/cache/diagnostics/latest-update.json',
      latestLogFile: '/cache/logs/latest.jsonl',
      diagnostics: {
        extractionDiagnostics: {},
        coverageDiagnostics: { coverageHealth: 'unverified' }
      }
    });
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    const result = await callTool('material_docs_cache_diagnostics', {});
    const diagnostics = result.diagnostics as Record<string, unknown>;

    expect(diagnostics.routeDiagnosticsAvailable).toBe(false);
    expect(diagnostics.routeDiagnosticsMessage).toBe('Route diagnostics are not present in diagnostics/latest-update.json.');
    expect(diagnostics).not.toHaveProperty('filteredRouteDiagnostics');
  });
});
