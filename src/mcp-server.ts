import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDefaultCacheDir } from './cache.js';
import { DEFAULT_CACHE_MAX_AGE_HOURS, MAX_CRAWL_CONCURRENCY } from './constants.js';
import { RouteCoverageStatusSchema } from './graph/graph-types.js';
import { loadGraphToolContext } from './mcp-tools/context.js';
import { explainResourceResolution } from './mcp-tools/explain-resource-resolution.js';
import { explainRouteCoverage } from './mcp-tools/explain-route-coverage.js';
import { getComponentResources } from './mcp-tools/get-component-resources.js';
import { getComponentTabs } from './mcp-tools/get-component-tabs.js';
import { getComponentTokens } from './mcp-tools/get-component-tokens.js';
import { getPage } from './mcp-tools/get-page.js';
import { DEFAULT_PREVIEW_CHARS, getRawArtifact } from './mcp-tools/get-raw-artifact.js';
import { getRoute } from './mcp-tools/get-route.js';
import { getRouteArtifacts } from './mcp-tools/get-route-artifacts.js';
import { listRoutes } from './mcp-tools/list-routes.js';
import { parseBoundedPositiveIntegerOption, parsePositiveIntegerOption, parsePositiveNumberOption } from './options.js';
import { MaterialDocsStore } from './store.js';
import type { CacheDiagnostics, CacheStatus, CrawlProgress, SearchResult } from './types.js';

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
  progress: CrawlProgress | null;
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
    return jsonText({ cache: status, refresh: startupRefresh.state(), results: (await store.searchDocs(query, limit)).map(toSearchResultPayload) });
  });

  server.tool('get_material_page', 'Return one cached Material 3 documentation page by cache path or source URL. Does not block on long cache refreshes.', {
    pathOrUrl: z.string().trim().min(1)
  }, async ({ pathOrUrl }) => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'page', null);
    if (unavailable) return unavailable;
    return jsonText({ cache: status, refresh: startupRefresh.state(), page: toPagePayload(await store.getPage(pathOrUrl)) });
  });

  server.tool('get_component_docs', 'Return all cached Material 3 documentation pages matching a component name. Does not block on long cache refreshes.', {
    componentName: z.string().trim().min(1),
    includeMarkdown: z.boolean().default(false),
    maxPages: z.number().int().min(1).max(25).default(10),
    maxMarkdownChars: z.number().int().min(200).max(100_000).default(20_000)
  }, async ({ componentName, includeMarkdown, maxPages, maxMarkdownChars }) => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'pages', []);
    if (unavailable) return unavailable;
    return jsonText({
      cache: status,
      refresh: startupRefresh.state(),
      component: componentName,
      pages: (await store.getComponentDocs(componentName, { includeMarkdown, maxPages, maxMarkdownChars })).map(toComponentPagePayload)
    });
  });

  server.tool('list_material_components', 'List component slugs discovered in the cached Material 3 documentation. Does not block on long cache refreshes.', {}, async () => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'components', []);
    if (unavailable) return unavailable;
    return jsonText({ cache: status, refresh: startupRefresh.state(), components: await store.listComponents() });
  });

  server.tool('material_docs_cache_status', 'Return local Material 3 documentation cache and background refresh status.', {}, async () => {
    return jsonText({ status: await store.getStatus(maxAgeHours), refresh: startupRefresh.state(), autoUpdate });
  });

  server.tool('material_docs_cache_diagnostics', 'Return explicit Material 3 cache diagnostics from diagnostics/latest-update.json. Summary-only by default.', {
    summaryOnly: z.boolean().default(true),
    route: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1).optional(),
    failedOnly: z.boolean().default(false),
    skippedOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(25),
    includeFullDiagnostics: z.boolean().default(false)
  }, async ({ summaryOnly, route, path, failedOnly, skippedOnly, limit, includeFullDiagnostics }) => {
    return jsonText({
      cache: await store.getStatus(maxAgeHours),
      refresh: startupRefresh.state(),
      diagnostics: filterDiagnostics(await store.getDiagnostics(), { summaryOnly, route, path, failedOnly, skippedOnly, limit, includeFullDiagnostics })
    });
  });

  server.tool('refresh_material_docs', 'Refresh the local Material 3 documentation cache from m3.material.io using the deterministic JSON-based pipeline. Browser fallback is disabled by default. This is an explicit long-running operation. Set force only when intentionally replacing an existing cache despite safety checks.', {
    maxPages: z.number().int().min(1).max(1000).optional(),
    concurrency: z.number().int().min(1).max(MAX_CRAWL_CONCURRENCY).default(1),
    promotePartial: z.boolean().default(false),
    force: z.boolean().default(false)
  }, async ({ maxPages, concurrency, promotePartial, force }) => {
    return jsonText(await store.refresh({
      maxPages,
      maxPagesExplicit: maxPages !== undefined,
      concurrency,
      promotePartial: promotePartial ?? false,
      force: force ?? false
    }));
  });

  server.tool('list_routes', 'List the Material 3 documentation route catalog from the documentation graph (graph/routes.json), with optional section/coverage/search filters. Compact by default; does not dump raw page content.', {
    section: z.string().trim().min(1).optional(),
    coverageStatus: RouteCoverageStatusSchema.optional(),
    search: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(500).default(100)
  }, async ({ section, coverageStatus, search, limit }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonText(listRoutes(context, { section, coverageStatus, search, limit }));
  });

  server.tool('get_route', 'Return route metadata (canonicalRoute, aliases, references, tabs, source artifacts, coverage status/originalStatus/sharedCoverageGroup) from the documentation graph (graph/routes.json) for a single route.', {
    route: z.string().trim().min(1)
  }, async ({ route }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonText(getRoute(context, route));
  });

  server.tool('get_page', 'Return one documentation page in a chosen view: "structured" (sections/chunks/resources/tokens from graph/pages.json), "markdown" (the existing Markdown-compatible view), or "raw-summary" (artifact/provenance metadata, no raw content).', {
    route: z.string().trim().min(1),
    view: z.union([z.literal('structured'), z.literal('markdown'), z.literal('raw-summary')]).default('structured'),
    maxMarkdownChars: z.number().int().min(200).max(100_000).default(20_000)
  }, async ({ route, view, maxMarkdownChars }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonText(await getPage(context, store, { route, view, maxMarkdownChars }));
  });

  server.tool('get_component_tokens', 'Return token/status tables (real token names, values, roles, source artifacts) for a Material 3 component from the documentation graph (graph/token-tables.json).', {
    componentName: z.string().trim().min(1)
  }, async ({ componentName }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonText(getComponentTokens(context, componentName));
  });

  server.tool('get_component_tabs', 'Return tabs per route for a Material 3 component from the documentation graph (graph/routes.json).', {
    componentName: z.string().trim().min(1)
  }, async ({ componentName }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonText(getComponentTabs(context, componentName));
  });

  server.tool('get_component_resources', 'Return resources (images, videos, token tables, status tables) referenced by a Material 3 component\'s routes from the documentation graph (graph/resources.json).', {
    componentName: z.string().trim().min(1)
  }, async ({ componentName }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonText(getComponentResources(context, componentName));
  });

  server.tool('get_route_artifacts', 'Return the list of raw artifact ids/kinds/source URLs/hashes associated with a route (metadata only, not content).', {
    route: z.string().trim().min(1)
  }, async ({ route }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonText(getRouteArtifacts(context, route));
  });

  server.tool('get_raw_artifact', `Debug/provenance tool. Returns metadata for one raw artifact plus a truncated content preview (default ${DEFAULT_PREVIEW_CHARS} chars) with truncated:true, unless fullContent:true is passed and the artifact is below the size cap. Never dumps large raw JSON by default — use get_page/get_component_tokens for normal documentation tasks.`, {
    artifactId: z.string().trim().min(1),
    fullContent: z.boolean().default(false),
    previewChars: z.number().int().min(100).max(20_000).default(DEFAULT_PREVIEW_CHARS)
  }, async ({ artifactId, fullContent, previewChars }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonText(await getRawArtifact(context, { artifactId, fullContent, previewChars }));
  });

  server.tool('explain_route_coverage', 'Explain why a route has its current coverage status: reasons, shared coverage group members, original per-route status, and any policy-skip reason, from the documentation graph (graph/routes.json).', {
    route: z.string().trim().min(1)
  }, async ({ route }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonText(explainRouteCoverage(context, route));
  });

  server.tool('explain_resource_resolution', 'Explain a resource\'s resolved/unresolved status and which routes/chunks reference it, from the documentation graph (graph/resources.json).', {
    resourceId: z.string().trim().min(1)
  }, async ({ resourceId }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonText(explainResourceResolution(context, resourceId));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function toSearchResultPayload(result: SearchResult) {
  return {
    title: result.title,
    path: result.path,
    sourceUrl: result.url,
    section: result.section,
    headings: result.headings,
    excerpt: result.excerpt,
    score: result.score
  };
}

function toPagePayload(page: Awaited<ReturnType<MaterialDocsStore['getPage']>>) {
  return {
    meta: {
      ...page.meta,
      sourceUrl: page.meta.url
    },
    markdown: page.markdown
  };
}

function toComponentPagePayload(page: Awaited<ReturnType<MaterialDocsStore['getComponentDocs']>>[number]) {
  return {
    title: page.title,
    path: page.path,
    sourceUrl: page.url,
    section: page.section,
    headings: page.headings,
    ...(page.markdown !== undefined ? { markdown: page.markdown } : {})
  };
}

function filterDiagnostics(
  cacheDiagnostics: CacheDiagnostics,
  options: {
    summaryOnly: boolean;
    route?: string;
    path?: string;
    failedOnly: boolean;
    skippedOnly: boolean;
    limit: number;
    includeFullDiagnostics: boolean;
  }
) {
  const raw = cacheDiagnostics.diagnostics;
  if (!raw) {
    return {
      latestDiagnosticsFile: cacheDiagnostics.latestDiagnosticsFile,
      latestLogFile: cacheDiagnostics.latestLogFile,
      summary: null
    };
  }
  const extractionDiagnostics = asRecord(raw.extractionDiagnostics);
  const routeDiagnostics = asArray(extractionDiagnostics?.routeDiagnostics).filter(isRecord);
  const hasRouteDiagnostics = extractionDiagnostics !== null && Array.isArray(extractionDiagnostics.routeDiagnostics);
  const normalizedRoute = normalizeFilterValue(options.route);
  const normalizedPath = normalizeFilterValue(options.path);
  const includeRouteLevelData = options.includeFullDiagnostics
    || options.summaryOnly === false
    || options.failedOnly
    || options.skippedOnly
    || normalizedPath !== null
    || normalizedRoute !== null;
  const filteredRoutes = routeDiagnostics
    .filter((entry) => !normalizedRoute || matchesRouteFilter(entry, normalizedRoute))
    .filter((entry) => !normalizedPath || matchesPathFilter(entry, normalizedPath))
    .filter((entry) => !options.failedOnly || isFailedRouteDiagnostic(entry))
    .filter((entry) => !options.skippedOnly || isSkippedRouteDiagnostic(entry))
    .slice(0, options.limit);

  const qualitySummary = asRecord(raw.qualitySummary);
  const coverageDiagnostics = asRecord(raw.coverageDiagnostics);
  const summary = {
    runId: raw.runId ?? null,
    startedAt: raw.startedAt ?? null,
    finishedAt: raw.finishedAt ?? null,
    elapsedMs: raw.elapsedMs ?? null,
    promotionDecision: raw.promotionDecision ?? null,
    hasPreviousCache: raw.hasPreviousCache ?? null,
    previousPageCount: raw.previousPageCount ?? null,
    generatedPageCount: raw.generatedPageCount ?? raw.savedPages ?? null,
    promotionFailureReason: raw.promotionFailureReason ?? null,
    commandSummary: asRecord(raw.commandSummary),
    compactSummary: {
      pageCount: raw.generatedPageCount ?? raw.savedPages ?? null,
      attemptedPageCount: raw.attemptedPages ?? null,
      failedPageCount: raw.failedPages ?? null,
      failedUrls: asArray(raw.failedRoutes),
      qualitySummary,
      coverageHealth: raw.coverageHealth ?? coverageDiagnostics?.coverageHealth ?? null
    },
    latestDiagnosticsFile: cacheDiagnostics.latestDiagnosticsFile,
    latestLogFile: cacheDiagnostics.latestLogFile,
    routeDiagnosticsAvailable: hasRouteDiagnostics,
    routeDiagnosticsMessage: hasRouteDiagnostics ? null : 'Route diagnostics are not present in diagnostics/latest-update.json.',
    routeDiagnosticsCount: routeDiagnostics.length,
    ...(includeRouteLevelData ? { filteredRouteDiagnostics: filteredRoutes } : {})
  };

  if (options.includeFullDiagnostics) {
    return { ...summary, fullDiagnostics: raw };
  }
  return summary;
}

function normalizeFilterValue(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^\/+|\/+$/g, '').toLowerCase();
}

function normalizeRouteDiagnosticUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/g, '').toLowerCase();
}

function normalizeRouteDiagnosticPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function matchesRouteFilter(entry: Record<string, unknown>, route: string): boolean {
  const candidates = [
    normalizeRouteDiagnosticUrl(entry.url),
    normalizeRouteDiagnosticUrl(entry.sourceRoute),
    normalizeRouteDiagnosticPath(entry.sourceRoute),
    normalizeRouteDiagnosticPath(entry.virtualRoute),
    normalizeRouteDiagnosticPath(entry.path)
  ].filter((value): value is string => value !== null);
  return candidates.includes(route);
}

function matchesPathFilter(entry: Record<string, unknown>, pathValue: string): boolean {
  const candidates = [
    normalizeRouteDiagnosticPath(entry.path),
    normalizeRouteDiagnosticPath(entry.virtualRoute),
    normalizeRouteDiagnosticPath(entry.sourceRoute)
  ].filter((value): value is string => value !== null);
  return candidates.includes(pathValue);
}

function isFailedRouteDiagnostic(entry: Record<string, unknown>): boolean {
  if (isSkippedRouteDiagnostic(entry)) return false;
  return entry.sourceUsed === 'failed'
    || entry.finalMethod === null
    || typeof entry.fallbackReason === 'string'
    || (Array.isArray(entry.fallbackReasons) && entry.fallbackReasons.length > 0);
}

function isSkippedRouteDiagnostic(entry: Record<string, unknown>): boolean {
  return entry.sourceUsed === 'skipped' || typeof entry.skippedReason === 'string';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createStartupRefreshController(store: MaterialDocsStore, maxPages: number, concurrency: number) {
  let refreshPromise: Promise<void> | null = null;
  const state: Omit<StartupRefreshState, 'elapsedMs'> = {
    startedAt: null,
    completedAt: null,
    running: false,
    error: null,
    maxPages,
    concurrency,
    progress: null
  };

  async function refreshIfNeeded(maxAgeHours: number): Promise<void> {
    const status = await store.getStatus(maxAgeHours);
    if (status.hasCache) return;
    start();
  }

  function start(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    state.startedAt = new Date().toISOString();
    state.completedAt = null;
    state.running = true;
    state.error = null;
    state.progress = null;
    refreshPromise = store.refresh({
      maxPages,
      maxPagesExplicit: true,
      concurrency,
      promotePartial: false,
      onProgress: (progress) => {
        state.progress = progress;
        state.startedAt = progress.startedAt;
        state.completedAt = progress.completedAt;
        state.running = progress.running;
        state.error = progress.error;
      }
    })
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
    const elapsedMs = state.progress
      ? Date.parse(state.progress.updatedAt) - Date.parse(state.progress.startedAt)
      : state.startedAt && state.running ? Date.now() - Date.parse(state.startedAt) : null;
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
