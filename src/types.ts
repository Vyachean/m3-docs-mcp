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
export type ExtractionSource = 'direct-json' | 'network-json' | 'dom-fallback' | 'failed';
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
};

export type ExtractionRouteDiagnostic = {
  url: string;
  path: string;
  sourceUsed: ExtractionSource;
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

export type MaterialIndex = {
  source: string;
  capturedAt: string;
  pageCount: number;
  attemptedPageCount: number;
  failedPageCount: number;
  failedUrls: string[];
  qualityReport?: CrawlQualityReport;
  extractionDiagnostics?: ExtractionDiagnostics;
  coverageDiagnostics?: CoverageDiagnostics;
  pages: Omit<MaterialPage, 'text' | 'markdown'>[];
};

export type DsdbConfigSource = 'site-meta' | 'bundle' | 'browser-network' | null;

export type CacheStatus = {
  cacheDir: string;
  hasCache: boolean;
  capturedAt: string | null;
  pageCount: number;
  attemptedPageCount: number;
  failedPageCount: number;
  failedUrls: string[];
  ageMs: number | null;
  isFresh: boolean;
  coverageHealth?: CoverageHealth;
  extractionDiagnostics?: ExtractionDiagnostics;
  coverageDiagnostics?: CoverageDiagnostics;
  latestLogFile: string | null;
  latestDiagnosticsFile: string | null;
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
  maxPages?: number;
  minPageCount?: number;
  cacheDir?: string;
  headless?: boolean;
  force?: boolean;
  concurrency?: number;
  includeBlog?: boolean;
  signal?: AbortSignal;
  onProgress?: CrawlProgressHandler;
  /** Called immediately before any diagnostic/error line is written to stderr during an active crawl.
   *  Use this to clear a TTY progress line so error messages are not interleaved with it. */
  onBeforeLog?: () => void;
  /** Called once the update logger is ready with the log file path and diagnostics file path. */
  onLoggerReady?: (logFile: string, diagnosticsFile: string) => void;
  logDir?: string;
  verbose?: boolean;
};

export type RefreshOptions = {
  maxPages?: number;
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
