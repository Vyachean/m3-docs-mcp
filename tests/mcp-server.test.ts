import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import type { CacheStatus, MaterialIndex, RefreshOptions, SearchResult } from '../src/types.js';

type ToolSchema = Record<string, ZodTypeAny>;

const mocks = vi.hoisted(() => {
  const toolHandlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const toolDefinitions: Array<{ name: string; description: string; schema: ToolSchema }> = [];
  const serverConfigs: Array<{ name: string; version: string }> = [];
  const connect = vi.fn(async (_transport: unknown) => undefined);
  const createdStores: MockStore[] = [];
  const nextStores: MockStore[] = [];

  type MockStore = {
    cacheDir?: string;
    getStatus: ReturnType<typeof vi.fn<(maxAgeHours?: number) => Promise<CacheStatus>>>;
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
    capturedAt: '2026-05-18T00:00:00.000Z',
    pageCount: 1,
    attemptedPageCount: 1,
    failedPageCount: 0,
    failedUrls: [],
    ageMs: 60_000,
    isFresh: true,
    logDir: '/cache/logs',
    currentLogFile: '/cache/logs/mcp.log.jsonl',
    ...overrides
  });

  const makeStore = (status: CacheStatus = makeStatus()): MockStore => ({
    getStatus: vi.fn(async () => status),
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
    constructor(config: { name: string; version: string }) {
      mocks.serverConfigs.push(config);
    }

    tool(name: string, description: string, schema: ToolSchema, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>) {
      mocks.toolDefinitions.push({ name, description, schema });
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

function parseToolResult(result: { content: Array<{ type: 'text'; text: string }> }) {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const handler = mocks.toolHandlers.get(name);
  expect(handler).toBeDefined();
  const definition = mocks.toolDefinitions.find((tool) => tool.name === name);
  expect(definition).toBeDefined();
  const parsedArgs = Object.fromEntries(
    Object.entries(definition!.schema).map(([key, schema]) => [key, schema.parse(args[key])])
  );
  return parseToolResult(await handler!(parsedArgs));
}

function schemaFor(toolName: string): ToolSchema {
  const definition = mocks.toolDefinitions.find((tool) => tool.name === toolName);
  expect(definition).toBeDefined();
  return definition!.schema;
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

  it('registers the server metadata, expected tools, and default cache directory', async () => {
    const store = mocks.makeStore();
    mocks.nextStores.push(store);

    await serveMcp({ autoUpdate: false });

    expect(mocks.serverConfigs).toEqual([{ name: 'm3-docs-mcp', version: '0.1.0' }]);
    expect(store.cacheDir).toBe('/default-cache');
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.toolDefinitions.map((tool) => tool.name)).toEqual([
      'search_material_docs',
      'get_material_page',
      'get_component_docs',
      'list_material_components',
      'material_docs_cache_status',
      'refresh_material_docs'
    ]);
    expect(mocks.toolDefinitions.every((tool) => tool.description.length > 10)).toBe(true);
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

    const refreshSchema = schemaFor('refresh_material_docs');
    expect(refreshSchema.maxPages.safeParse(1).success).toBe(true);
    expect(refreshSchema.maxPages.safeParse(1000).success).toBe(true);
    expect(refreshSchema.maxPages.safeParse(1001).success).toBe(false);
    expect(refreshSchema.concurrency.safeParse(undefined).data).toBe(1);
    expect(refreshSchema.concurrency.safeParse(1).success).toBe(true);
    expect(refreshSchema.concurrency.safeParse(8).success).toBe(true);
    expect(refreshSchema.concurrency.safeParse(9).success).toBe(false);
    expect(refreshSchema.force.safeParse(true).success).toBe(true);
  });

  it('starts a missing-cache refresh in the background and does not block search tools', async () => {
    let resolveRefresh: (index: MaterialIndex) => void = () => undefined;
    const store = mocks.makeStore(mocks.makeStatus({ hasCache: false, capturedAt: null, pageCount: 0, attemptedPageCount: 0, ageMs: null, isFresh: false }));
    store.refresh.mockImplementation(() => new Promise<MaterialIndex>((resolve) => { resolveRefresh = resolve; }));
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', startupMaxPages: 125 });
    await vi.waitFor(() => expect(store.refresh).toHaveBeenCalledWith(expect.objectContaining({ maxPages: 125, concurrency: 1 })));
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

  it('serves stale cache while startup refresh runs in the background', async () => {
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
    store.refresh.mockImplementation(() => new Promise<MaterialIndex>(() => undefined));
    store.searchDocs.mockResolvedValue([searchResult]);
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', startupMaxPages: 250 });
    await vi.waitFor(() => expect(store.refresh).toHaveBeenCalledWith(expect.objectContaining({ maxPages: 250, concurrency: 1 })));
    expect(store.refresh.mock.calls[0]?.[0]?.onProgress).toEqual(expect.any(Function));

    const result = await callTool('search_material_docs', { query: 'dialogs', limit: 10 });

    expect(result).toMatchObject({
      results: [searchResult],
      refresh: { running: true, completedAt: null, error: null }
    });
    expect(store.getStatus).toHaveBeenCalledTimes(2);
    expect(store.searchDocs).toHaveBeenCalledWith('dialogs', 10);
  });

  it('uses the same store refresh path for explicit long-running refresh requests', async () => {
    const index = mocks.makeIndex();
    const store = mocks.makeStore();
    store.refresh.mockResolvedValue(index);
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    const result = await callTool('refresh_material_docs', { maxPages: 77 });

    expect(store.refresh).toHaveBeenCalledWith({ maxPages: 77, concurrency: 1, force: false });
    expect(result).toMatchObject({ pageCount: 1, source: 'https://m3.material.io' });
  });

  it('passes explicit forced refresh requests to the store', async () => {
    const index = mocks.makeIndex();
    const store = mocks.makeStore();
    store.refresh.mockResolvedValue(index);
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    await callTool('refresh_material_docs', { maxPages: 77, force: true });

    expect(store.refresh).toHaveBeenCalledWith({ maxPages: 77, concurrency: 1, force: true });
  });
});
