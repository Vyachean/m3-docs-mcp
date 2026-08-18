import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDefaultCacheDir } from './cache.js';
import { DEFAULT_CACHE_MAX_AGE_HOURS, MAX_CRAWL_CONCURRENCY } from './constants.js';
import { RouteCoverageStatusSchema } from './graph/graph-types.js';
import { loadGraphToolContext } from './mcp-tools/context.js';
import { explainResourceResolution } from './mcp-tools/explain-resource-resolution.js';
import { explainRouteCoverage } from './mcp-tools/explain-route-coverage.js';
import { getComponentOverview } from './mcp-tools/get-component-overview.js';
import { getComponentResources } from './mcp-tools/get-component-resources.js';
import { getComponentTabs } from './mcp-tools/get-component-tabs.js';
import { getComponentTokens } from './mcp-tools/get-component-tokens.js';
import { getPage } from './mcp-tools/get-page.js';
import { DEFAULT_PREVIEW_CHARS, getRawArtifact } from './mcp-tools/get-raw-artifact.js';
import { getRoute } from './mcp-tools/get-route.js';
import { getRouteArtifacts } from './mcp-tools/get-route-artifacts.js';
import { listRoutes } from './mcp-tools/list-routes.js';
import {
  CompatibilityObjectOutputSchema,
  ExplainObjectOutputSchema,
  GetComponentOverviewOutputSchema,
  GetComponentResourcesOutputSchema,
  GetComponentTabsOutputSchema,
  GetComponentTokensOutputSchema,
  GetPageOutputSchema,
  GetRawArtifactOutputSchema,
  GetRouteArtifactsOutputSchema,
  GetRouteOutputSchema,
  ListRoutesOutputSchema,
  SearchStructuredDocsOutputSchema,
} from './mcp-tools/output-schemas.js';
import { searchStructuredDocs } from './mcp-tools/search-structured-docs.js';
import { parseBoundedPositiveIntegerOption, parsePositiveIntegerOption, parsePositiveNumberOption } from './options.js';
import { MaterialDocsStore } from './store.js';
import type { CacheDiagnostics, CacheStatus, CrawlProgress, SearchResult } from './types.js';

const MCP_SERVER_INSTRUCTIONS = [
  'Use graph-oriented tools as the primary Material 3 documentation interface.',
  'For a specific component, start with get_component_overview, then call only the focused follow-up tools you need, such as get_page or get_component_tokens.',
  'Use search_structured_docs for route, section, token, and resource discovery. Use search_material_docs only for broad full-text compatibility search.',
  'Use get_page for normal page guidance. Use get_raw_artifact, explain_route_coverage, explain_resource_resolution, and material_docs_cache_diagnostics only for troubleshooting or provenance.',
  'Read tools report cache/graph availability explicitly; do not guess Material guidance when the requested data is unavailable.',
].join(' ');

function jsonResult<T extends object>(value: T) {
  const structuredContent = { ...value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
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
  unavailable: ReturnType<typeof jsonResult> | null;
};

export async function serveMcp(options: { cacheDir?: string; maxAgeHours?: number; autoUpdate?: boolean; startupMaxPages?: number; startupConcurrency?: number } = {}): Promise<void> {
  const cacheDir = options.cacheDir ?? getDefaultCacheDir();
  const maxAgeHours = parsePositiveNumberOption('M3_DOCS_MAX_AGE_HOURS', options.maxAgeHours ?? process.env.M3_DOCS_MAX_AGE_HOURS, DEFAULT_CACHE_MAX_AGE_HOURS);
  const autoUpdate = options.autoUpdate ?? process.env.M3_DOCS_AUTO_UPDATE !== 'false';
  const startupMaxPages = parsePositiveIntegerOption('M3_DOCS_STARTUP_MAX_PAGES', options.startupMaxPages ?? process.env.M3_DOCS_STARTUP_MAX_PAGES, 250);
  const startupConcurrency = parseBoundedPositiveIntegerOption('M3_DOCS_STARTUP_CONCURRENCY', options.startupConcurrency ?? process.env.M3_DOCS_STARTUP_CONCURRENCY, 1, MAX_CRAWL_CONCURRENCY);
  const store = new MaterialDocsStore(cacheDir);
  const startupRefresh = createStartupRefreshController(store, startupMaxPages, startupConcurrency);
  const server = new McpServer(
    { name: 'm3-docs-mcp', version: '0.1.0' },
    { instructions: MCP_SERVER_INSTRUCTIONS }
  );

  if (autoUpdate) {
    startupRefresh.refreshIfNeeded(maxAgeHours).catch((error: unknown) => {
      console.error('Failed to check Material 3 docs cache freshness:', error instanceof Error ? error.message : String(error));
    });
  }

  server.registerTool('get_component_overview', {
    description: 'Primary component entry point. Return a compact Material 3 component summary with available routes, tabs, token-table counts, resource counts, and recommended follow-up routes. Start here for component-specific tasks before requesting full page/token/resource payloads.',
    inputSchema: {
      componentName: z.string().trim().min(1)
    },
    outputSchema: GetComponentOverviewOutputSchema
  }, async ({ componentName }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(getComponentOverview(context, componentName));
  });

  server.registerTool('search_structured_docs', {
    description: 'Primary structured discovery tool. Search routes, page sections/chunks, token names/display names/aliases, and resource names from the Material 3 documentation graph. Prefer this over Markdown full-text search for component/spec/token/resource questions.',
    inputSchema: {
      query: z.string().trim().min(1),
      limit: z.number().int().min(1).max(100).default(20)
    },
    outputSchema: SearchStructuredDocsOutputSchema
  }, async ({ query, limit }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(searchStructuredDocs(context, query, limit));
  });

  server.registerTool('list_routes', {
    description: 'Primary route catalog. List Material 3 documentation routes with optional section/coverage/search filters. Compact by default and suitable for choosing a get_page target.',
    inputSchema: {
      section: z.string().trim().min(1).optional(),
      coverageStatus: RouteCoverageStatusSchema.optional(),
      search: z.string().trim().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(100)
    },
    outputSchema: ListRoutesOutputSchema
  }, async ({ section, coverageStatus, search, limit }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(listRoutes(context, { section, coverageStatus, search, limit }));
  });

  server.registerTool('get_route', {
    description: 'Return one route\'s canonical route, aliases, references, tabs, source artifacts, and coverage metadata from the structured documentation graph.',
    inputSchema: {
      route: z.string().trim().min(1)
    },
    outputSchema: GetRouteOutputSchema
  }, async ({ route }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(getRoute(context, route));
  });

  server.registerTool('get_page', {
    description: 'Primary exact-page tool. Return one Material 3 documentation page as compact structured sections/chunks/resources/tokens by default, Markdown when explicitly requested, or raw provenance metadata without raw content.',
    inputSchema: {
      route: z.string().trim().min(1),
      view: z.union([z.literal('structured'), z.literal('markdown'), z.literal('raw-summary')]).default('structured'),
      maxMarkdownChars: z.number().int().min(200).max(100_000).default(20_000)
    },
    outputSchema: GetPageOutputSchema
  }, async ({ route, view, maxMarkdownChars }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(await getPage(context, store, { route, view, maxMarkdownChars }));
  });

  server.registerTool('get_component_tokens', {
    description: 'Return full decoded token/status tables for a Material 3 component, including real token names, aliases, resolved values, roles, and unresolved counts. Use get_component_overview first when you only need to know whether token data exists.',
    inputSchema: {
      componentName: z.string().trim().min(1)
    },
    outputSchema: GetComponentTokensOutputSchema
  }, async ({ componentName }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(getComponentTokens(context, componentName));
  });

  server.registerTool('get_component_tabs', {
    description: 'Return tabs per route for a Material 3 component. Use when tab/virtual-route structure matters; get_component_overview already returns a compact tab summary.',
    inputSchema: {
      componentName: z.string().trim().min(1)
    },
    outputSchema: GetComponentTabsOutputSchema
  }, async ({ componentName }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(getComponentTabs(context, componentName));
  });

  server.registerTool('get_component_resources', {
    description: 'Return full resources (images, videos, token tables, status tables) referenced by a Material 3 component. Use get_component_overview first when counts are sufficient.',
    inputSchema: {
      componentName: z.string().trim().min(1)
    },
    outputSchema: GetComponentResourcesOutputSchema
  }, async ({ componentName }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(getComponentResources(context, componentName));
  });

  server.registerTool('material_docs_cache_status', {
    description: 'Return local Material 3 documentation cache and background refresh status. Use when cache readiness/freshness itself matters; normal read tools already report unavailable data explicitly.',
    inputSchema: {},
    outputSchema: CompatibilityObjectOutputSchema
  }, async () => {
    return jsonResult({ status: await store.getStatus(maxAgeHours), refresh: startupRefresh.state(), autoUpdate });
  });

  server.registerTool('search_material_docs', {
    description: 'Compatibility/full-text tool. Search rendered Markdown from the local Material 3 cache. Use for broad prose discovery when search_structured_docs is insufficient; prefer structured graph tools for component/spec/token/resource facts.',
    inputSchema: {
      query: z.string().trim().min(1),
      limit: z.number().int().min(1).max(25).default(10)
    },
    outputSchema: CompatibilityObjectOutputSchema
  }, async ({ query, limit }) => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'results', []);
    if (unavailable) return unavailable;
    return jsonResult({ cache: status, refresh: startupRefresh.state(), results: (await store.searchDocs(query, limit)).map(toSearchResultPayload) });
  });

  server.registerTool('get_material_page', {
    description: 'Compatibility/Markdown tool. Return one cached rendered Material 3 page by cache path or source URL. Prefer get_page for route-based structured guidance and provenance-aware access.',
    inputSchema: {
      pathOrUrl: z.string().trim().min(1)
    },
    outputSchema: CompatibilityObjectOutputSchema
  }, async ({ pathOrUrl }) => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'page', null);
    if (unavailable) return unavailable;
    return jsonResult({ cache: status, refresh: startupRefresh.state(), page: toPagePayload(await store.getPage(pathOrUrl)) });
  });

  server.registerTool('get_component_docs', {
    description: 'Compatibility/Markdown component tool. Return cached rendered pages matching a component name. Prefer get_component_overview plus focused graph tools for new agent workflows.',
    inputSchema: {
      componentName: z.string().trim().min(1),
      includeMarkdown: z.boolean().default(false),
      maxPages: z.number().int().min(1).max(25).default(10),
      maxMarkdownChars: z.number().int().min(200).max(100_000).default(20_000)
    },
    outputSchema: CompatibilityObjectOutputSchema
  }, async ({ componentName, includeMarkdown, maxPages, maxMarkdownChars }) => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'pages', []);
    if (unavailable) return unavailable;
    return jsonResult({
      cache: status,
      refresh: startupRefresh.state(),
      component: componentName,
      pages: (await store.getComponentDocs(componentName, { includeMarkdown, maxPages, maxMarkdownChars })).map(toComponentPagePayload)
    });
  });

  server.registerTool('list_material_components', {
    description: 'Compatibility helper. List component slugs discovered in rendered Markdown. Prefer get_component_overview when you already know the component and list_routes/search_structured_docs for structured discovery.',
    inputSchema: {},
    outputSchema: CompatibilityObjectOutputSchema
  }, async () => {
    const { status, unavailable } = await cacheAvailability(store, startupRefresh.state(), maxAgeHours, 'components', []);
    if (unavailable) return unavailable;
    return jsonResult({ cache: status, refresh: startupRefresh.state(), components: await store.listComponents() });
  });

  server.registerTool('refresh_material_docs', {
    description: 'Maintenance tool. Refresh the local Material 3 documentation cache using the deterministic JSON-based pipeline. Browser fallback is disabled by default. This is an explicit long-running operation; set force only when intentionally replacing an existing cache despite safety checks.',
    inputSchema: {
      maxPages: z.number().int().min(1).max(1000).optional(),
      concurrency: z.number().int().min(1).max(MAX_CRAWL_CONCURRENCY).default(1),
      promotePartial: z.boolean().default(false),
      force: z.boolean().default(false)
    },
    outputSchema: CompatibilityObjectOutputSchema
  }, async ({ maxPages, concurrency, promotePartial, force }) => {
    return jsonResult(await store.refresh({
      maxPages,
      maxPagesExplicit: maxPages !== undefined,
      concurrency,
      promotePartial: promotePartial ?? false,
      force: force ?? false
    }));
  });

  server.registerTool('material_docs_cache_diagnostics', {
    description: 'Troubleshooting tool. Return explicit cache/update diagnostics from diagnostics/latest-update.json. Summary-only by default; do not use for ordinary Material guidance.',
    inputSchema: {
      summaryOnly: z.boolean().default(true),
      route: z.string().trim().min(1).optional(),
      path: z.string().trim().min(1).optional(),
      failedOnly: z.boolean().default(false),
      skippedOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(25),
      includeFullDiagnostics: z.boolean().default(false)
    },
    outputSchema: CompatibilityObjectOutputSchema
  }, async ({ summaryOnly, route, path, failedOnly, skippedOnly, limit, includeFullDiagnostics }) => {
    return jsonResult({
      cache: await store.getStatus(maxAgeHours),
      refresh: startupRefresh.state(),
      diagnostics: filterDiagnostics(await store.getDiagnostics(), { summaryOnly, route, path, failedOnly, skippedOnly, limit, includeFullDiagnostics })
    });
  });

  server.registerTool('get_route_artifacts', {
    description: 'Troubleshooting/provenance tool. Return raw artifact ids, kinds, source URLs, hashes, and timestamps associated with a route; metadata only, not content.',
    inputSchema: {
      route: z.string().trim().min(1)
    },
    outputSchema: GetRouteArtifactsOutputSchema
  }, async ({ route }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(getRouteArtifacts(context, route));
  });

  server.registerTool('get_raw_artifact', {
    description: `Troubleshooting/provenance tool. Return metadata for one raw artifact plus a truncated content preview (default ${DEFAULT_PREVIEW_CHARS} chars). Never dumps large raw JSON by default; use get_page/get_component_tokens for ordinary documentation tasks.`,
    inputSchema: {
      artifactId: z.string().trim().min(1),
      fullContent: z.boolean().default(false),
      previewChars: z.number().int().min(100).max(20_000).default(DEFAULT_PREVIEW_CHARS)
    },
    outputSchema: GetRawArtifactOutputSchema
  }, async ({ artifactId, fullContent, previewChars }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(await getRawArtifact(context, { artifactId, fullContent, previewChars }));
  });

  server.registerTool('explain_route_coverage', {
    description: 'Troubleshooting tool. Explain why a route has its current coverage status, including shared coverage groups and original per-route status. Do not use for ordinary page reading.',
    inputSchema: {
      route: z.string().trim().min(1)
    },
    outputSchema: ExplainObjectOutputSchema
  }, async ({ route }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(explainRouteCoverage(context, route));
  });

  server.registerTool('explain_resource_resolution', {
    description: 'Troubleshooting tool. Explain a resource\'s resolved/unresolved status and which routes/chunks reference it. Do not use for ordinary component/resource discovery.',
    inputSchema: {
      resourceId: z.string().trim().min(1)
    },
    outputSchema: ExplainObjectOutputSchema
  }, async ({ resourceId }) => {
    const context = await loadGraphToolContext(cacheDir);
    return jsonResult(explainResourceResolution(context, resourceId));
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
    if (status.hasCache && status.isFresh) return;
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
    unavailable: jsonResult({
      status,
      refresh,
      message: refresh.running
        ? 'Material 3 docs cache is being built. Retry this tool after the background refresh completes.'
        : 'Material 3 docs cache is not available. Run refresh_material_docs or m3-docs-mcp update.',
      [key]: fallback
    })
  };
}
