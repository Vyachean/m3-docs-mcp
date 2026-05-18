import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheStatus, MaterialIndex, SearchResult } from '../src/types.js';

const mocks = vi.hoisted(() => {
  const toolHandlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const connect = vi.fn(async () => undefined);
  const createdStores: MockStore[] = [];
  const nextStores: MockStore[] = [];

  type MockStore = {
    getStatus: ReturnType<typeof vi.fn<() => Promise<CacheStatus>>>;
    refresh: ReturnType<typeof vi.fn<(maxPages?: number) => Promise<MaterialIndex>>>;
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

  return { toolHandlers, connect, createdStores, nextStores, makeIndex, makeStatus, makeStore };
});

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(name: string, _description: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>) {
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
      mocks.createdStores.push(store);
      Object.assign(this, store, { cacheDir });
    }
  }
}));

const { serveMcp } = await import('../src/mcp-server.js');

function parseToolResult(result: { content: Array<{ type: 'text'; text: string }> }) {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('serveMcp', () => {
  beforeEach(() => {
    mocks.toolHandlers.clear();
    mocks.connect.mockClear();
    mocks.createdStores.length = 0;
    mocks.nextStores.length = 0;
  });

  it('starts a missing-cache refresh in the background and does not block search tools', async () => {
    let resolveRefresh: (index: MaterialIndex) => void = () => undefined;
    const store = mocks.makeStore(mocks.makeStatus({ hasCache: false, capturedAt: null, pageCount: 0, attemptedPageCount: 0, ageMs: null, isFresh: false }));
    store.refresh.mockImplementation(() => new Promise<MaterialIndex>((resolve) => { resolveRefresh = resolve; }));
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', startupMaxPages: 125 });
    await vi.waitFor(() => expect(store.refresh).toHaveBeenCalledWith(125));

    const result = parseToolResult(await mocks.toolHandlers.get('search_material_docs')?.({ query: 'dialogs', limit: 5 })!);

    expect(result).toMatchObject({
      message: 'Material 3 docs cache is being built. Retry this tool after the background refresh completes.',
      results: [],
      refresh: { running: true, completedAt: null, error: null }
    });
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
    await vi.waitFor(() => expect(store.refresh).toHaveBeenCalledWith(250));

    const result = parseToolResult(await mocks.toolHandlers.get('search_material_docs')?.({ query: 'dialogs', limit: 10 })!);

    expect(result).toMatchObject({
      results: [searchResult],
      refresh: { running: true, completedAt: null, error: null }
    });
    expect(store.searchDocs).toHaveBeenCalledWith('dialogs', 10);
  });

  it('uses the same store refresh path for explicit long-running refresh requests', async () => {
    const index = mocks.makeIndex();
    const store = mocks.makeStore();
    store.refresh.mockResolvedValue(index);
    mocks.nextStores.push(store);

    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    const result = parseToolResult(await mocks.toolHandlers.get('refresh_material_docs')?.({ maxPages: 77 })!);

    expect(store.refresh).toHaveBeenCalledWith(77);
    expect(result).toMatchObject({ pageCount: 1, source: 'https://m3.material.io' });
  });
});
