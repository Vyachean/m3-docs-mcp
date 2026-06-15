export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSource = 'direct-json' | 'network-json' | 'dom-fallback' | 'crawler' | 'cache' | 'mcp';

export type LogFields = {
  command?: string;
  toolName?: string;
  url?: string;
  path?: string;
  source?: LogSource;
  phase?: string;
  durationMs?: number;
  counters?: Record<string, number>;
  errorClass?: string;
  errorMessage?: string;
  errorStack?: string;
};

export type OperationalLogger = {
  info(event: string, message: string, fields?: LogFields): void;
  warn(event: string, message: string, fields?: LogFields): void;
  error(event: string, message: string, fields?: LogFields): void;
  debug(event: string, message: string, fields?: LogFields): void;
  readonly logDir: string;
  readonly currentLogFile: string;
  close(): Promise<void>;
};

export type CleanupDiagnostics = {
  staleStagingDirsFound: number;
  staleStagingDirsRemoved: number;
  stalePreviousBackupsFound: number;
  stalePreviousBackupsRemoved: number;
  cleanupWarnings: string[];
};

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
  tokenContextDiagnostics: TokenContextDiagnostic[];
  statusTablesRequested?: number;
  statusTablesResolved?: number;
  statusTablesRendered?: number;
  statusTablesRenderedAsPlaceholder?: number;
  unsupportedStatusTableSchemaCount?: number;
  statusTableDiagnostics?: StatusTableDiagnostic[];
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
  tokenContextDiagnostics?: TokenContextDiagnostic[];
  statusTablesRequested?: number;
  statusTablesResolved?: number;
  statusTablesRendered?: number;
  statusTablesRenderedAsPlaceholder?: number;
  unsupportedStatusTableSchemaCount?: number;
  statusTableDiagnostics?: StatusTableDiagnostic[];
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
  tokenTablesSuccessfullyRendered: number;
  tokenTablesFailedToRender: number;
  tokenTablesMissingRequestedTokenSets: number;
  tokenContextDiagnosticsRecorded: number;
  tokenTablesUsingFallbackContext: number;
  tokenTablesWithMultipleContextVariants: number;
  tokenTablesWithUnresolvedTokens: number;
  statusTablesRequested: number;
  statusTablesResolved: number;
  statusTablesRendered: number;
  statusTablesRenderedAsPlaceholder: number;
  unsupportedStatusTableSchemaCount: number;
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

export type CoverageHealth = 'verified' | 'partial' | 'unverified' | 'failed';

export type CoverageDiagnostics = {
  discoveredPublicUrlCount: number;
  sitemapUrlCount: number;
  renderedNavUrlCount: number;
  angularRouteHintCount: number;
  previousCacheRouteHintCount: number;
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
  logDir: string;
  currentLogFile: string;
  coverageHealth?: CoverageHealth;
  extractionDiagnostics?: ExtractionDiagnostics;
  coverageDiagnostics?: CoverageDiagnostics;
};

export type CrawlProgress = {
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  running: boolean;
  maxPages: number;
  concurrency: number;
  attemptedPageCount: number;
  savedPageCount: number;
  failedPageCount: number;
  queuedPageCount: number;
  activeWorkerCount: number;
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
  logger?: OperationalLogger;
  command?: string;
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
