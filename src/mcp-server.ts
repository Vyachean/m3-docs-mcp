import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDefaultCacheDir } from './cache.js';
import { parseBoundedPositiveIntegerOption, parsePositiveIntegerOption, parsePositiveNumberOption } from './options.js';
import { MaterialDocsStore } from './store.js';
import type { CacheStatus } from './types.js';

const MAX_CRAWL_CONCURRENCY = 8;
const DEFAULT_CACHE_MAX_AGE_HOURS = 168;

function jsonText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

type StartupRefreshState = {
  startedAt: string | null;
  completedAt: string | null;
  running: boolean;
  error: string | null;
  elapsedMs: number | null;
  maxPages: number;
  concurrency: number;
};

type CacheAvailability = {
  status: CacheStatus;
  unavailable: ReturnType<typeof jsonText> | null;
};

export async function serveMcp(options: { cacheDir?: string; maxAgeHours?: number; autoUpdate?: boolean; startupMaxPages?: number; startupConcurrency?: number } = {}): Promise<void> {
  const cacheDir = options.cacheDir ?? getDefaultCacheDir();
  const maxAgeHours = parsePositiveNumberOption('M3_DOCS_MAX_AGE_HOURS', options.maxAgeHours ?? process.env.M3_DOCS_MAX_AGE_HOURS, DEFAULT_CACHE_MAX_AGE_HOURS);
  const autoUpdate = options.autoUpdate ?? process.env.M3_DOCS_AUTO_UPDATE !== 'false';
  const startupMaxPages = parsePositiveIntegerOption('M3_DOCS_STARTUP_MAX_PAGES', options.startupMaxPages ?? process.env.M3_DOCS_STARTUP_MAX_PAGES, 250);
  const startupConcurrency = parseBoundedPositiveIntegerOption('M3_DOCS_STARTUP_CONCURRENCY', options.startupConcurrency ?? process.env.M3_DOCS_STARTUP_CONCURRENCY, 1, MAX_CRAWL_CONCURRENCY);
  const store = new MaterialDocsStore(cacheDir);
  const startupRefresh = createStartupRefreshController(store, startupMaxPages, startupConcurrency);
  const server = new McpServer({ name: 'm3-docs-mcp', version: '0.1.0' });

  if (autoUpdate) {
    startupRefresh.refreshIfNeeded(maxAgeHours).catch((error: unknown) => {
      console.error('Failed to check Material 3 docs cache freshness:', error instanceof Error ? error.message : String(error));
    });
  }

  server.tool('search_material_docs', 'Search locally cached official Material 3 documentation from m3.material.io. If the cache is missing or stale, the server starts a refresh in the background instead of blocking this tool call.', {
    query: z.string().trim().min(1),
    limit: z.number().int().min(1).max(25).default(10)
  }, async ({ query, limit }) => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'results', []);
    if (unavailable) return unavailable;
    return jsonText({ status, refresh: startupRefresh.state(), results: await store.searchDocs(query, limit) });
  });

  server.tool('get_material_page', 'Return one cached Material 3 documentation page by cache path or source URL. Does not block on long cache refreshes.', {
    pathOrUrl: z.string().trim().min(1)
  }, async ({ pathOrUrl }) => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'page', null);
    if (unavailable) return unavailable;
    return jsonText({ status, refresh: startupRefresh.state(), page: await store.getPage(pathOrUrl) });
  });

  server.tool('get_component_docs', 'Return all cached Material 3 documentation pages matching a component name. Does not block on long cache refreshes.', {
    componentName: z.string().trim().min(1)
  }, async ({ componentName }) => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'pages', []);
    if (unavailable) return unavailable;
    return jsonText({ status, refresh: startupRefresh.state(), pages: await store.getComponentDocs(componentName) });
  });

  server.tool('list_material_components', 'List component slugs discovered in the cached Material 3 documentation. Does not block on long cache refreshes.', {}, async () => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'components', []);
    if (unavailable) return unavailable;
    return jsonText({ status, refresh: startupRefresh.state(), components: await store.listComponents() });
  });

  server.tool('material_docs_cache_status', 'Return local Material 3 documentation cache and background refresh status.', {}, async () => {
    return jsonText({ status: await store.getStatus(maxAgeHours), refresh: startupRefresh.state(), autoUpdate });
  });

  server.tool('refresh_material_docs', 'Refresh the local Material 3 documentation cache from m3.material.io using Playwright. This is an explicit long-running operation. Set force only when intentionally replacing an existing cache despite safety checks.', {
    maxPages: z.number().int().min(1).max(1000).optional(),
    concurrency: z.number().int().min(1).max(MAX_CRAWL_CONCURRENCY).default(1),
    force: z.boolean().default(false)
  }, async ({ maxPages, concurrency, force }) => {
    return jsonText(await store.refresh({ maxPages, concurrency, force: force ?? false }));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function createStartupRefreshController(store: MaterialDocsStore, maxPages: number, concurrency: number) {
  let refreshPromise: Promise<void> | null = null;
  const state: Omit<StartupRefreshState, 'elapsedMs'> = {
    startedAt: null,
    completedAt: null,
    running: false,
    error: null,
    maxPages,
    concurrency
  };

  async function refreshIfNeeded(maxAgeHours: number): Promise<void> {
    const status = await store.getStatus(maxAgeHours);
    if (status.hasCache && status.isFresh) return;
    start();
  }

  function start(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    state.startedAt = new Date().toISOString();
    state.completedAt = null;
    state.running = true;
    state.error = null;
    refreshPromise = store.refresh({ maxPages, concurrency })
      .then(() => {
        state.completedAt = new Date().toISOString();
      })
      .catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
        console.error('Failed to refresh Material 3 docs cache:', state.error);
      })
      .finally(() => {
        state.running = false;
        refreshPromise = null;
      });
    return refreshPromise;
  }

  function snapshot(): StartupRefreshState {
    const elapsedMs = state.startedAt && state.running ? Date.now() - Date.parse(state.startedAt) : null;
    return { ...state, elapsedMs };
  }

  return {
    refreshIfNeeded,
    state: snapshot
  };
}

async function cacheAvailability(store: MaterialDocsStore, refresh: StartupRefreshState, maxAgeHours: number, key: string, fallback: unknown): Promise<CacheAvailability> {
  const status = await store.getStatus(maxAgeHours);
  if (status.hasCache) return { status, unavailable: null };
  return {
    status,
    unavailable: jsonText({
      status,
      refresh,
      message: refresh.running
        ? 'Material 3 docs cache is being built. Retry this tool after the background refresh completes.'
        : 'Material 3 docs cache is not available. Run refresh_material_docs or m3-docs-mcp update.',
      [key]: fallback
    })
  };
}
