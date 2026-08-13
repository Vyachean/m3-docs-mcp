export type MaterialPage = {
  id: string;
  title: string;
  url: string;
  path: string;
  section: string;
  headings: string[];
  text: string;
  markdown: string;
  capturedAt: string;
  publishedYear?: number;
};

export type ExtractionMethod = 'json' | 'dom';
export type ExtractionSource = 'direct-json' | 'network-json' | 'dom-fallback' | 'failed' | 'skipped';
export type JsonResponseType = 'page-metadata' | 'content-page' | 'dsdb-resource' | 'token-table' | 'status-table' | 'unknown-json-resource';

export type ExtractionFallbackReason =
  | 'json-fetch-failed'
  | 'json-title-missing'
  | 'json-low-quality'
  | 'json-no-sections'
  | 'json-no-headings'
  | 'json-short-markdown'
  | 'json-suspicious-content'
  | 'json-missing-token-tables'
  | 'json-route-mismatch'
  | 'playwright-unavailable'
  | 'network-json-failed'
  | 'dom-fallback-failed'
  | 'max-pages-reached'
  | 'route-not-selected';

export type TokenContextDiagnostic = {
  resourceName: string | null;
  requestedTokenSets: string[];
  renderedTokenSets: string[];
  selectedContextKeys: string[];
  skippedContextKeys: string[];
  availableContextKeys: string[];
  unresolvedTokenCount: number;
  missingRequestedTokenSetCount: number;
  usedFallbackContext: boolean;
  multipleContextVariantsAvailable: boolean;
};

export type StatusTableDiagnostic = {
  resourceName: string | null;
  requested: boolean;
  resolved: boolean;
  rendered: boolean;
  renderedAsPlaceholder: boolean;
  unsupportedSchema: boolean;
};

export type ExtractionPageDiagnostic = {
  url: string;
  path: string;
  method: ExtractionMethod;
  source?: ExtractionSource;
  fallbackReason?: ExtractionFallbackReason;
  unknownChunkTypes: string[];
  unknownResourceTypes: string[];
  tokenTables: number;
  tokenTablesRendered: number;
  tokenTablesResolved?: number;
  tokenTablesDecoded?: number;
  tokenTablesRenderedAsPlaceholder?: number;
  tokenTablesUnsupportedSchema?: number;
  tokenTablePlaceholderReasons?: string[];
  tokenTablesRenderedFromInline?: number;
  tokenContextDiagnostics: TokenContextDiagnostic[];
  statusTablesRequested?: number;
  statusTablesResolved?: number;
  statusTablesDecoded?: number;
  statusTablesRendered?: number;
  statusTablesRenderedAsPlaceholder?: number;
  unsupportedStatusTableSchemaCount?: number;
  statusTableDiagnostics?: StatusTableDiagnostic[];
  resourceChunksRequested?: number;
  resourceChunksResolved?: number;
  resourceChunksDecoded?: number;
  resourceChunksRendered?: number;
  resourceChunksPlaceholder?: number;
  missingRequestedTokenSets: string[];
  suspiciousReasons: string[];
  imageCount: number;
  videoCount: number;
  unresolvedResourceCount: number;
  noSections: boolean;
  noHeadings: boolean;
  markdownLength: number;
  hasTitle?: boolean;
  qualityScore?: number;
  routeTitlePathMismatch?: boolean;
  expectedRoute?: string;
  actualRoute?: string | null;
  sourceRoute?: string;
  canonicalRoute?: string;
  virtualRoute?: string;
  pageCanonId?: string | null;
  exportedCarbonFileId?: string | null;
};

export type ExtractionRouteDiagnostic = {
  url: string;
  path: string;
  sourceUsed: ExtractionSource;
  siteMetaRoute?: string;
  normalizedRoute?: string;
  bundleMatchedRoute?: string;
  finalMethod: ExtractionMethod | null;
  jsonAttempted: boolean;
  jsonSucceeded: boolean;
  fallbackReason?: ExtractionFallbackReason;
  fallbackReasons?: ExtractionFallbackReason[];
  fallbackSkippedReasons?: ExtractionFallbackReason[];
  browserFallbackAttempted: boolean;
  browserFallbackSucceeded: boolean;
  directJsonAttempted?: boolean;
  directJsonSucceeded?: boolean;
  networkJsonAttempted?: boolean;
  networkJsonSucceeded?: boolean;
  domFallbackAttempted?: boolean;
  domFallbackSucceeded?: boolean;
  unknownChunkTypes: string[];
  unknownResourceTypes: string[];
  tokenTables: number;
  tokenTablesRendered: number;
  tokenTablesRequested?: number;
  tokenTablesResolved?: number;
  tokenTablesDecoded?: number;
  tokenTablesRenderedAsPlaceholder?: number;
  tokenTablesUnsupportedSchema?: number;
  tokenTablePlaceholderReasons?: string[];
  tokenContextDiagnostics?: TokenContextDiagnostic[];
  statusTablesRequested?: number;
  statusTablesResolved?: number;
  statusTablesDecoded?: number;
  statusTablesRendered?: number;
  statusTablesRenderedAsPlaceholder?: number;
  unsupportedStatusTableSchemaCount?: number;
  statusTableDiagnostics?: StatusTableDiagnostic[];
  resourceChunksRequested?: number;
  resourceChunksResolved?: number;
  resourceChunksDecoded?: number;
  resourceChunksRendered?: number;
  resourceChunksPlaceholder?: number;
  missingRequestedTokenSets: string[];
  unknownJsonResourceCount?: number;
  capturedJsonResponseCounts?: Partial<Record<JsonResponseType, number>>;
  rawJsonDebugFilesWritten?: number;
  routeMetadataWarnings?: string[];
  candidateSelectionReasons?: string[];
  /** Where this route's path came from: site_meta.routes, or a bundle-supplement subtree. */
  navigationSource?: 'site-meta' | 'sitemap' | 'rendered-nav' | 'bundle-supplement';
  /** Where collectionId/documentId were resolved from for the page-data fetch. */
  pageReferenceSource?: 'bundle-table' | 'site-meta-reference' | 'missing';
  /** How the resolved bundle route was matched when it did not win by exact route equality. */
  aliasMatchedBy?: 'bundle-alternate-slug';
  reconciliationStatus?: RouteReconciliationStatus;
  /** Set when this route/virtual page was never attempted — distinct from sourceUsed:"failed",
   *  which is reserved for routes that were actually attempted and errored. Excluded from
   *  failedPages/virtualPagesFailed/failedPageCount. */
  skippedReason?: 'missing-page-reference' | 'not-selected' | 'non-content-index' | 'alias-only' | 'redirect' | 'private' | 'blog' | 'legacy-route' | 'platform-specific-unmapped';
  /** Tables rendered via the inline decode pipeline (extractContentPageToMaterialPage), which does
   *  not track a separate resolved/decoded stage. Distinguishes "rendered without that granularity"
   *  from a genuine resolved:0/decoded:0 with tables actually rendered, which would look impossible. */
  tokenTablesRenderedFromInline?: number;
  /** What was actually fetched to build this page's content. */
  contentSource?: 'page-data' | 'page-data+carbon' | 'carbon';
  /** Whether this cached page came from splitting a tab out of a parent route's content. */
  virtualSource?: 'tab' | null;
  /** The real site_meta/bundle route this page was derived from, when it differs from `path` (tabs). */
  sourceRoute?: string;
  /** This page's own URL path when it's a virtual tab page (same as `path`, kept for clarity in logs). */
  virtualRoute?: string;
  canonicalRoute?: string;
  tabName?: string;
  tabSlug?: string;
  /** How this tab was matched to a decoded content-page section (page-reference-resolver.ts's
   *  matchTabToSection) — 'slug' | 'label' | 'position'. Absent/undefined for non-tab pages. */
  tabMatchedBy?: 'slug' | 'label' | 'position';
  /** Index of the matched section within the *decoded* content page (before any tab splitting) —
   *  used by graph/route-graph.ts to backfill RouteNode.tabs[].matchedSectionId with the section
   *  id of the resulting tab PageNode (see buildPageGraph: each tab page has exactly one matched
   *  section, always reported at PageNode.sections[1] since sections[0] is the page title). */
  tabMatchedSectionIndex?: number;
  pageDataFetchedOnce?: boolean;
  pageDataUrl?: string;
  pageDataStatus?: number | string;
  carbonUrl?: string;
  carbonStatus?: number | string;
  collectionId?: string;
  documentId?: string;
  expectedRoute?: string;
  actualRoute?: string | null;
  pageCanonId?: string | null;
  exportedCarbonFileId?: string | null;
  selectedBecause?: 'budget' | 'required-validation';
};

export type ExtractionDiagnostics = {
  totalPages: number;
  totalRoutes: number;
  pagesExtractedThroughJson: number;
  pagesExtractedThroughDomFallback: number;
  pagesWhereJsonFailed: number;
  jsonFallbackRoutes: number;
  pagesAcceptedFromDirectJson: number;
  pagesAcceptedFromNetworkJson: number;
  pagesAcceptedFromDomFallback: number;
  pagesFailed: number;
  routesWhereDirectJsonFailed: number;
  routesWhereNetworkJsonFailed: number;
  routesWhereDomFallbackFailed: number;
  pagesWithUnknownChunkTypes: number;
  pagesWithUnknownResourceTypes: number;
  unknownChunkCount: number;
  unknownResourceTypeCount: number;
  unknownJsonResourceCount: number;
  pagesWithTokenTables: number;
  tokenTablesRequested: number;
  tokenTablesResolved: number;
  tokenTablesDecoded: number;
  tokenTablesSuccessfullyRendered: number;
  tokenTablesRenderedAsPlaceholder: number;
  tokenTablesUnsupportedSchema: number;
  tokenTablesFailedToRender: number;
  /** Tables rendered via the inline decode pipeline, where resolved/decoded weren't tracked as a
   *  separate stage. See ExtractionRouteDiagnostic.tokenTablesRenderedFromInline. */
  tokenTablesRenderedFromInline: number;
  tokenTablesMissingRequestedTokenSets: number;
  tokenContextDiagnosticsRecorded: number;
  tokenTablesUsingFallbackContext: number;
  tokenTablesWithMultipleContextVariants: number;
  tokenTablesWithUnresolvedTokens: number;
  statusTablesRequested: number;
  statusTablesResolved: number;
  statusTablesDecoded: number;
  statusTablesRendered: number;
  statusTablesRenderedAsPlaceholder: number;
  unsupportedStatusTableSchemaCount: number;
  resourceChunksRequested: number;
  resourceChunksResolved: number;
  resourceChunksDecoded: number;
  resourceChunksRendered: number;
  resourceChunksPlaceholder: number;
  pagesWithSuspiciouslyShortMarkdown: number;
  pagesWithNoSections: number;
  pagesWithNoHeadings: number;
  imageCount: number;
  videoCount: number;
  unresolvedResourceCount: number;
  rawJsonDebugFilesWritten: number;
  /** Distinct site routes selected for extraction (before tab expansion). */
  sourcePagesSelected: number;
  /** Distinct site routes actually attempted (fetched). */
  sourcePagesAttempted: number;
  /** Distinct attempted source routes that produced at least one saved cache page. */
  sourcePagesSucceeded: number;
  /** Distinct attempted source routes that produced zero saved cache pages. */
  sourcePagesFailed: number;
  /** Expected cache pages across attempted source routes (1 per route, or len(tabs) for tab routes). */
  virtualPagesPlanned: number;
  /** Cache pages actually written. Same quantity as cachePagesSaved, viewed at the virtual-page level. */
  virtualPagesSaved: number;
  /** Cache pages that were attempted (selected, not skipped) but failed to save. */
  virtualPagesFailed: number;
  /** Cache pages actually written (cache-file-level count; equals virtualPagesSaved). */
  cachePagesSaved: number;
  routeDiagnostics: ExtractionRouteDiagnostic[];
  pageDiagnostics: ExtractionPageDiagnostic[];
};

export type CoverageHealth = 'verified' | 'partial' | 'unverified' | 'failed' | 'broken';

export type CoverageDiagnostics = {
  discoveredPublicUrlCount: number;
  sitemapUrlCount: number;
  renderedNavUrlCount: number;
  angularRouteHintCount: number;
  previousCacheRouteHintCount: number;
  /** Routes discovered from site_meta.js (primary source). */
  siteMetaRouteCount?: number;
  /** Public, non-redirect routes from site_meta. */
  siteMetaPublicRouteCount?: number;
  /** Private routes skipped from site_meta. */
  siteMetaPrivateRouteCount?: number;
  /** External-redirect routes skipped from site_meta. */
  siteMetaRedirectRouteCount?: number;
  /** Alias (other_routes) entries from site_meta. */
  siteMetaAliasCount?: number;
  /** Routes added because a tracked subtree (e.g. styles, foundations) had zero site_meta coverage. */
  bundleSupplementRouteCount?: number;
  /** Which tracked subtrees actually triggered bundle-supplement (subset of tracked prefixes). */
  supplementedPrefixes?: string[];
  acceptedPageCount: number;
  uncrawledDiscoveredUrlCount: number;
  uncrawledDiscoveredUrls: string[];
  skippedBecauseMaxPagesCount: number;
  skippedBecauseJsonCoveredCount: number;
  skippedByPolicyCount: number;
  skippedBlogCount: number;
  skippedByPolicyUrls: string[];
  includeBlog: boolean;
  crawlPriorityPolicyVersion: string;
  coverageVerified: boolean;
  coverageWarnings: string[];
  coverageHealth?: CoverageHealth;
  /** True when this run intentionally limits scope (explicit --max-pages, or maxPages truncated
   *  route selection) — full-site discovered-vs-accepted coverage-gap checks are scoped down
   *  accordingly instead of being a hard promotion blocker. */
  isLimitedRun?: boolean;
  /** True when the CLI/caller explicitly passed --max-pages (as opposed to no flag at all). */
  maxPagesExplicit?: boolean;
  /** Routes dropped purely because maxPages truncated the candidate list. Diagnostic only. */
  skippedNotSelectedCount?: number;

  // ── Full-refresh coverage classification (diagnostic + the basis for hard validation) ──────
  // discoveredPublicUrlCount mixes canonical routes with aliases, tab URLs, legacy/static routes,
  // and platform-specific pages that don't map to extractable content — it stays diagnostic-only.
  // The fields below separate "site routes" from "cache/virtual pages" and classify every
  // discovered URL that isn't a selected/attempted canonical route, so the hard promotion target
  // (plannedVirtualPageCount vs savedVirtualPageCount + failedVirtualPageCount) never gets diluted
  // by URLs that were never expected to become content pages in the first place.
  canonicalSiteMetaRouteCount?: number;
  publicCanonicalRouteCount?: number;
  aliasUrlCount?: number;
  redirectedRouteCount?: number;
  privateRouteCount?: number;
  blogRouteCount?: number;
  resolvableSourceRouteCount?: number;
  unresolvedSourceRouteCount?: number;
  selectedSourceRouteCount?: number;
  attemptedSourceRouteCount?: number;
  plannedVirtualPageCount?: number;
  savedVirtualPageCount?: number;
  failedVirtualPageCount?: number;
  skippedAliasOnlyCount?: number;
  skippedMissingPageReferenceCount?: number;
  skippedNonContentIndexCount?: number;
  skippedLegacyRouteCount?: number;
  skippedPlatformSpecificUnmappedCount?: number;
  routeResolutionSummary?: RouteResolutionSummary;
  requiredRouteCoverage?: RequiredRouteCoverageEntry[];
  routePlanSummary?: CompactRoutePlanSummary;
  fullRoutePlanSummary?: RoutePlanSummary;
  routeCoverage?: RouteCoverageEntry[];
  routeCoverageSummary?: RouteCoverageSummary;
};

export type RouteResolutionSummaryEntry = {
  url: string;
  path: string;
  sourceUsed: ExtractionSource;
  siteMetaRoute?: string;
  normalizedRoute?: string;
  bundleMatchedRoute?: string;
  pageReferenceSource?: 'bundle-table' | 'site-meta-reference' | 'missing';
  aliasMatchedBy?: 'bundle-alternate-slug';
  reconciliationStatus?: RouteReconciliationStatus;
  skippedReason?: ExtractionRouteDiagnostic['skippedReason'];
  sourceRoute?: string;
  virtualRoute?: string;
  collectionId?: string;
  documentId?: string;
};

export type RequiredRouteCoverageEntry = {
  key: string;
  label: string;
  sourcePresent: boolean;
  saved: boolean;
  siteMetaRoutes: string[];
  bundleRoutes: string[];
  pagePaths: string[];
  missingReason?: 'missing-cache-output';
};

export type RouteResolutionSummary = {
  skippedRoutes: RouteResolutionSummaryEntry[];
  aliasResolvedRoutes: RouteResolutionSummaryEntry[];
  failedVirtualPages: RouteResolutionSummaryEntry[];
  requiredRouteCoverage: RequiredRouteCoverageEntry[];
};

export type RouteCandidateSource = 'site_meta' | 'nav_drawer' | 'bundle' | 'sitemap' | 'rendered_nav';

export type RouteReconciliationStatus =
  | 'exact'
  | 'alternateSlug'
  | 'contentIdentityMatch'
  | 'normalizedSlugMatch'
  | 'rejectedAmbiguous'
  | 'rejectedStale'
  | 'rejectedNonPublic'
  | 'extractionFailed';

export type PublicDocsClassification =
  | 'public-docs'
  | 'redirect'
  | 'go-link'
  | 'asset'
  | 'non-content-index'
  | 'unsupported-platform-or-policy'
  | 'outside-public-docs'
  | 'missing-extraction-metadata';

export type RoutePlanEntry = {
  route: string;
  canonicalRoute?: string;
  outputPath?: string;
  sources: RouteCandidateSource[];
  title?: string;
  public?: boolean;
  redirectExternalUrl?: string | null;
  collectionId?: string | null;
  documentId?: string | null;
  exportedCarbonFileId?: string | null;
  carbonPath?: string | null;
  pageCanonId?: string | null;
  tabs?: string[];
  tabSlugs?: string[];
  alternateSlugs?: string[];
  navTitle?: string;
  routeTitle?: string;
  publicDocsClassification: PublicDocsClassification;
  identityFieldsUsed?: string[];
  reconciliationStatus: RouteReconciliationStatus;
  skippedReason?: string;
  failureReason?: string;
};

export type RoutePlanSummary = {
  acceptedRoutes: RoutePlanEntry[];
  staleRoutes: RoutePlanEntry[];
  removedRoutes: RoutePlanEntry[];
  ambiguousRoutes: RoutePlanEntry[];
  nonPublicRoutes: RoutePlanEntry[];
  extractionCandidates: RoutePlanEntry[];
};

export type CompactRoutePlanBucketExample = Pick<
  RoutePlanEntry,
  'route' | 'canonicalRoute' | 'outputPath' | 'reconciliationStatus' | 'publicDocsClassification' | 'navTitle' | 'routeTitle' | 'skippedReason' | 'failureReason'
>;

export type CompactRoutePlanSummary = {
  acceptedRouteCount: number;
  staleRouteCount: number;
  ambiguousRouteCount: number;
  nonPublicRouteCount: number;
  extractionCandidateCount: number;
  reconciliationStatusCounts: Partial<Record<RouteReconciliationStatus, number>>;
  publicDocsClassificationCounts: Partial<Record<PublicDocsClassification, number>>;
  problematicExamples: {
    staleRoutes: CompactRoutePlanBucketExample[];
    ambiguousRoutes: CompactRoutePlanBucketExample[];
    nonPublicRoutes: CompactRoutePlanBucketExample[];
    unresolvedAcceptedRoutes: CompactRoutePlanBucketExample[];
  };
};

export type RouteCoverageStatus = 'covered' | 'partial' | 'failed' | 'skipped' | 'unresolved' | 'nonContent' | 'policySkipped';

export type RouteCoverageEntry = {
  sourceRoute: string;
  canonicalRoute: string;
  coverageGroupKey?: string;
  coverageSharedWithSourceRoutes?: string[];
  routeKey?: string;
  sources?: RouteCandidateSource[];
  reconciliationStatus?: RouteReconciliationStatus;
  publicDocsClassification?: PublicDocsClassification;
  navigationSource?: 'site-meta' | 'sitemap' | 'rendered-nav' | 'bundle-supplement';
  pageReferenceSource?: 'bundle-table' | 'site-meta-reference' | 'missing';
  expectedVirtualRoutes: string[];
  expectedOutputPaths: string[];
  savedOutputPaths: string[];
  failedOutputPaths: string[];
  skippedOutputPaths: string[];
  status: RouteCoverageStatus;
  failureReasons: string[];
};

export type CompactRouteCoverageExample = Pick<
  RouteCoverageEntry,
  'sourceRoute' | 'canonicalRoute' | 'status' | 'failureReasons'
> & {
  expectedOutputPathCount: number;
  savedOutputPathCount: number;
  failedOutputPathCount: number;
  skippedOutputPathCount: number;
  expectedOutputPathExamples: string[];
  savedOutputPathExamples: string[];
  failedOutputPathExamples: string[];
  skippedOutputPathExamples: string[];
};

export type RouteCoverageSummary = {
  totalAcceptedRoutes: number;
  coveredRoutes: number;
  partialRoutes: number;
  failedRoutes: number;
  unresolvedRoutes: number;
  skippedRoutes: number;
  policySkippedRoutes: number;
  nonContentRoutes: number;
  expectedOutputCount: number;
  savedOutputCount: number;
  failedOutputCount: number;
  problematicExamples: CompactRouteCoverageExample[];
};

export type SuspiciousCrawlPage = {
  url: string;
  path: string;
  title: string;
  reason: string;
};

export type RejectedCrawlRoute = SuspiciousCrawlPage & {
  classification: 'not-found' | 'route-mismatch';
  status: 'failed';
};

export type DuplicateContentGroup = {
  hash: string;
  title: string;
  paths: string[];
  urls: string[];
};

export type ShortCrawlPage = {
  url: string;
  path: string;
  title: string;
  textLength: number;
};

export type DuplicateTitleGroup = {
  title: string;
  count: number;
  paths: string[];
};

export type CrawlQualityReport = {
  suspiciousPages: SuspiciousCrawlPage[];
  rejectedRoutes: RejectedCrawlRoute[];
  duplicateContent: DuplicateContentGroup[];
  shortPages: ShortCrawlPage[];
  duplicateTitles: DuplicateTitleGroup[];
  pagesBySection: Record<string, number>;
};

export type QualitySummary = {
  suspiciousPageCount: number;
  rejectedRouteCount: number;
  duplicateContentGroupCount: number;
  shortPageCount: number;
  duplicateTitleGroupCount: number;
};

export type MaterialPageMeta = Omit<MaterialPage, 'text' | 'markdown'>;

export type MaterialPublicPageManifestEntry = {
  path: string;
  title: string;
  sourceUrl: string;
  section: string;
  headings: string[];
  publishedYear?: number;
  excerpt?: string;
  wordCount?: number;
};

export type MaterialIndex = {
  source: string;
  capturedAt: string;
  pageCount: number;
  attemptedPageCount: number;
  failedPageCount: number;
  failedUrls: string[];
  qualitySummary?: QualitySummary;
  qualityReport?: CrawlQualityReport;
  extractionDiagnostics?: ExtractionDiagnostics;
  coverageDiagnostics?: CoverageDiagnostics;
  pages: MaterialPageMeta[];
};

export type MaterialPublicIndex = {
  source: string;
  capturedAt: string;
  pageCount: number;
  attemptedPageCount: number;
  failedPageCount: number;
  failedUrls: string[];
  qualitySummary?: QualitySummary;
  coverageDiagnostics?: Pick<CoverageDiagnostics, 'coverageHealth' | 'routePlanSummary' | 'routeCoverageSummary'>;
  pages: MaterialPublicPageManifestEntry[];
};
export type DsdbConfigSource = 'site-meta' | 'bundle' | 'browser-network' | null;

export type CacheStatus = {
  cacheDir: string;
  hasCache: boolean;
  source: string | null;
  capturedAt: string | null;
  pageCount: number;
  attemptedPageCount: number;
  failedPageCount: number;
  failedUrls: string[];
  ageMs: number | null;
  ttlMs: number;
  isFresh: boolean;
  coverageHealth?: CoverageHealth;
  routeCoverageSummary?: RouteCoverageSummary;
  qualitySummary?: QualitySummary;
};

export type CacheDiagnostics = {
  cacheDir: string;
  latestDiagnosticsFile: string | null;
  latestLogFile: string | null;
  diagnostics: Record<string, unknown> | null;
  directJsonEnabled?: boolean;
  browserOnlyFallback?: boolean;
  directJsonDisabledReason?: string;
  dsdbConfigSource?: DsdbConfigSource;
  siteMetaFetched?: boolean;
  siteMetaFailed?: boolean;
  bundleDiscoveryFailed?: boolean;
  networkRecoveryAttempted?: boolean;
  networkRecoverySucceeded?: boolean;
  networkRecoveryFailureReason?: string | null;
};
export type CrawlPhase =
  | 'fetch-shell'
  | 'fetch-site-meta'
  | 'enumerate-routes'
  | 'normalize-routes'
  | 'filter-routes'
  | 'fetch-page-data'
  | 'fetch-carbon'
  | 'extract-markdown'
  | 'validate-cache'
  | 'browser-network-recovery'
  | 'browser-dom-fallback'
  | 'promoting'
  | 'complete'
  // Legacy aliases kept for backwards compatibility with existing diagnostics/logs
  | 'discovering'
  | 'direct-json'
  | 'browser-crawl'
  | 'finalizing';

export type CrawlProgress = {
  phase: CrawlPhase;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  running: boolean;
  maxPages: number;
  concurrency: number;
  elapsedMs: number;
  processedPageCount: number;
  targetPageCount: number | null;
  attemptedPageCount: number;
  directJsonAttemptedPageCount: number;
  browserAttemptedPageCount: number;
  savedPageCount: number;
  failedPageCount: number;
  queuedPageCount: number;
  activeWorkerCount: number;
  ratePagesPerSecond: number | null;
  estimatedRemainingMs: number | null;
  currentUrls: string[];
  lastSavedUrl: string | null;
  lastFailedUrl: string | null;
  error: string | null;
};

export type CrawlProgressHandler = (progress: CrawlProgress) => void;

export type CrawlOptions = {
  baseUrl?: string;
  /** null/undefined means a full refresh with no source-route truncation. */
  maxPages?: number | null;
  /** True when the caller explicitly requested a maxPages limit (vs. the default full refresh). */
  maxPagesExplicit?: boolean;
  minPageCount?: number;
  cacheDir?: string;
  headless?: boolean;
  force?: boolean;
  concurrency?: number;
  includeBlog?: boolean;
  /** Browser-based DOM fallback and network recovery are disabled by default — the default
   *  update path is deterministic direct-JSON extraction only. Set true to opt into the legacy
   *  Playwright-based fallback/recovery behavior. */
  allowBrowserFallback?: boolean;
  /** Allow a limited/partial refresh to replace an existing cache. Disabled by default for
   * explicit maxPages refreshes so diagnostic runs do not silently replace a verified full cache. */
  promotePartial?: boolean;
  signal?: AbortSignal;
  onProgress?: CrawlProgressHandler;
  /** Called immediately before any diagnostic/error line is written to stderr during an active crawl.
   *  Use this to clear a TTY progress line so error messages are not interleaved with it. */
  onBeforeLog?: () => void;
  /** Called once the update logger is ready with the log file path and diagnostics file path. */
  onLoggerReady?: (logFile: string, diagnosticsFile: string) => void;
  logDir?: string;
  verbose?: boolean;
  /** When true, a failure to build/write the documentation graph, renderer report, or manifest —
   *  or a failure of the always-on (no-network) raw-snapshot/structured-graph/rendered-output/
   *  coverage-summary validation stages — aborts promotion instead of being logged as non-fatal.
   *  Off by default (existing lenient behavior, used by most smoke/dev/test runs); the `update`
   *  CLI's `--strict-graph` flag and `verify:cache:full` turn this on for production promotion. */
  strictGraph?: boolean;
};

export type RefreshOptions = {
  maxPages?: number | null;
  maxPagesExplicit?: boolean;
  promotePartial?: boolean;
  force?: boolean;
  concurrency?: number;
  includeBlog?: boolean;
  signal?: AbortSignal;
  onProgress?: CrawlProgressHandler;
};

export type SearchResult = {
  title: string;
  url: string;
  path: string;
  section: string;
  headings: string[];
  score: number;
  excerpt: string;
};
