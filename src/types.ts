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

export type ExtractionFallbackReason =
  | 'json-fetch-failed'
  | 'json-no-sections'
  | 'json-no-headings'
  | 'json-short-markdown'
  | 'json-suspicious-content';

export type ExtractionPageDiagnostic = {
  url: string;
  path: string;
  method: ExtractionMethod;
  fallbackReason?: ExtractionFallbackReason;
  unknownChunkTypes: string[];
  unknownResourceTypes: string[];
  tokenTables: number;
  tokenTablesRendered: number;
  missingRequestedTokenSets: string[];
  suspiciousReasons: string[];
  imageCount: number;
  videoCount: number;
  unresolvedResourceCount: number;
  noSections: boolean;
  noHeadings: boolean;
  markdownLength: number;
};

export type ExtractionDiagnostics = {
  totalPages: number;
  pagesExtractedThroughJson: number;
  pagesExtractedThroughDomFallback: number;
  pagesWhereJsonFailed: number;
  pagesWithUnknownChunkTypes: number;
  pagesWithUnknownResourceTypes: number;
  pagesWithTokenTables: number;
  tokenTablesSuccessfullyRendered: number;
  tokenTablesMissingRequestedTokenSets: number;
  pagesWithSuspiciouslyShortMarkdown: number;
  pagesWithNoSections: number;
  pagesWithNoHeadings: number;
  imageCount: number;
  videoCount: number;
  unresolvedResourceCount: number;
  pageDiagnostics: ExtractionPageDiagnostic[];
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
  extractionDiagnostics?: ExtractionDiagnostics;
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
  signal?: AbortSignal;
  onProgress?: CrawlProgressHandler;
};

export type RefreshOptions = {
  maxPages?: number;
  force?: boolean;
  concurrency?: number;
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
