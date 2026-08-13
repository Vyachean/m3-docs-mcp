import type { ExtractionFallbackReason, ExtractionPageDiagnostic, MaterialPage } from '../types.js';
import { decodeResourceChunk, renderDsdbResourceChunk, type CollectedTokenTable, type DsdbResourceFetcher } from './extract-dsdb-resource.js';
import { extractPageDataMetadata } from './extract-page-data.js';
import { compactJson, parseContentPage, type DecodedContentChunk } from './schemas.js';
import {
  createMaterialPageFromBody,
  renderHtmlToMarkdown,
  renderImageMarkdown,
  renderVideoMarkdown,
  renderResourcePlaceholder
} from './render-markdown.js';

const MIN_REASONABLE_MARKDOWN_LENGTH = 80;
const MIN_ACCEPTABLE_QUALITY_SCORE = 4;

export type JsonExtractionResult = {
  page: MaterialPage;
  pageDiagnostic: ExtractionPageDiagnostic;
  fallbackReason: ExtractionFallbackReason | null;
  /** Decoded token-table systems captured during rendering (see CollectedTokenTable's doc
   *  comment in extract-dsdb-resource.ts) — populated regardless of fallbackReason, so callers
   *  building the documentation graph can use them even for pages whose Markdown didn't pass
   *  quality checks. Empty when the page had no TOKEN_TABLE resource chunks. */
  collectedTokenTables: CollectedTokenTable[];
};

export async function extractContentPageToMaterialPage({
  url,
  pageData,
  contentPage,
  capturedAt,
  fetchResource,
  sectionIndices,
  titleOverride,
  routeValidation
}: {
  url: string;
  pageData: unknown | null;
  contentPage: unknown | null;
  capturedAt?: string;
  fetchResource: DsdbResourceFetcher;
  /** When provided, only these section indices (from the decoded content page) are rendered —
   *  used to split a single fetched content payload into one Markdown page per tab. */
  sectionIndices?: number[];
  /** When provided (tab splitting), used instead of the page-data/content-page title. */
  titleOverride?: string;
  routeValidation?: {
    sourceRoute?: string;
    canonicalRoute?: string;
    virtualRoute?: string;
    expectedPageCanonId?: string | null;
    exportedCarbonFileId?: string | null;
  };
}): Promise<JsonExtractionResult> {
  const decoded = parseContentPage(contentPage);
  const pageDataMeta = extractPageDataMetadata(pageData);
  const discoveredTitle = titleOverride ?? decoded.title ?? pageDataMeta.title;
  const title = discoveredTitle ?? 'Material 3 page';
  const sections = sectionIndices ? sectionIndices.map((i) => decoded.sections[i]).filter((s): s is typeof decoded.sections[number] => Boolean(s)) : decoded.sections;
  const headings = [discoveredTitle, ...sections.map((s) => s.title).filter(Boolean)].filter(
    (v): v is string => Boolean(v)
  );
  const routeIdentity = validateRouteIdentity({
    url,
    title,
    pageDataMeta,
    contentPage,
    routeValidation
  });
  const pageDiagnostic: ExtractionPageDiagnostic = {
    url,
    path: createMaterialPageFromBody({ url, title, headings, body: `# ${title}` }).path,
    method: 'json',
    source: 'direct-json',
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 0,
    tokenTablesRendered: 0,
    tokenTablePlaceholderReasons: [],
    tokenContextDiagnostics: [],
    statusTablesRequested: 0,
    statusTablesResolved: 0,
    statusTablesRendered: 0,
    statusTablesRenderedAsPlaceholder: 0,
    unsupportedStatusTableSchemaCount: 0,
    statusTableDiagnostics: [],
    missingRequestedTokenSets: [],
    suspiciousReasons: [],
    imageCount: 0,
    videoCount: 0,
    unresolvedResourceCount: 0,
    noSections: sections.length === 0,
    noHeadings: headings.length === 0,
    markdownLength: 0,
    hasTitle: Boolean(discoveredTitle?.trim()),
    qualityScore: 0,
    routeTitlePathMismatch: routeIdentity.routeTitlePathMismatch,
    expectedRoute: routeIdentity.expectedRoute,
    actualRoute: routeIdentity.actualRoute,
    sourceRoute: routeValidation?.sourceRoute,
    canonicalRoute: routeValidation?.canonicalRoute,
    virtualRoute: routeValidation?.virtualRoute,
    pageCanonId: routeIdentity.actualPageCanonId,
    exportedCarbonFileId: routeValidation?.exportedCarbonFileId ?? null
  };

  const collectedTokenTables: CollectedTokenTable[] = [];
  const bodyParts: string[] = [`# ${title}`];
  for (const section of sections) {
    if (section.title.trim()) bodyParts.push(`## ${section.title.trim()}`);
    for (const block of section.blocks) {
      if (block.title?.trim()) bodyParts.push(`### ${block.title.trim()}`);
      for (const chunk of block.chunks) {
        const rendered = await renderChunkMarkdown(chunk, fetchResource, pageDiagnostic, collectedTokenTables);
        if (rendered.trim()) bodyParts.push(rendered.trim());
      }
    }
  }

  if (sections.length === 0 && decoded.fallbackHtml) {
    bodyParts.push(decoded.fallbackHtml);
  }

  const page = createMaterialPageFromBody({
    url,
    capturedAt,
    title,
    headings,
    body: bodyParts.join('\n\n').trim()
  });
  pageDiagnostic.markdownLength = page.markdown.length;
  pageDiagnostic.path = page.path;
  pageDiagnostic.qualityScore = scoreJsonExtraction(page, pageDiagnostic);

  const fallbackReason = determineFallbackReason(page, pageDiagnostic);
  if (fallbackReason) pageDiagnostic.suspiciousReasons.push(fallbackReason);

  return { page, pageDiagnostic, fallbackReason, collectedTokenTables };
}

function validateRouteIdentity({
  url,
  title,
  pageDataMeta,
  contentPage,
  routeValidation
}: {
  url: string;
  title: string;
  pageDataMeta: ReturnType<typeof extractPageDataMetadata>;
  contentPage: unknown | null;
  routeValidation?: {
    sourceRoute?: string;
    canonicalRoute?: string;
    virtualRoute?: string;
    expectedPageCanonId?: string | null;
    exportedCarbonFileId?: string | null;
  };
}): {
  routeTitlePathMismatch: boolean;
  expectedRoute: string;
  actualRoute: string | null;
  actualPageCanonId: string | null;
} {
  const expectedRoute = normalizeRoutePath(new URL(url).pathname);
  const actualRoute = normalizeOptionalRoutePath(pageDataMeta.pathname);
  const actualPageCanonId = pageDataMeta.pageCanonId ?? firstStringPath(contentPage, ['pageCanonId'], ['pageCanonicalId']);
  const expectedPageCanonId = routeValidation?.expectedPageCanonId
    ?? routeValidation?.exportedCarbonFileId?.replace(/\.json$/i, '')
    ?? null;
  const acceptableRoutes = new Set([
    expectedRoute,
    normalizeOptionalRoutePath(routeValidation?.sourceRoute),
    normalizeOptionalRoutePath(routeValidation?.canonicalRoute),
    normalizeOptionalRoutePath(routeValidation?.virtualRoute)
  ].filter((value): value is string => Boolean(value)));
  const routeMatches = !actualRoute || acceptableRoutes.has(actualRoute);
  const normalizedActualPageCanonId = actualPageCanonId?.toLowerCase() ?? null;
  const normalizedExpectedPageCanonId = expectedPageCanonId?.toLowerCase() ?? null;
  const pageCanonMatches = Boolean(actualPageCanonId)
    && Boolean(expectedPageCanonId)
    && normalizedActualPageCanonId === normalizedExpectedPageCanonId;
  return {
    routeTitlePathMismatch: routeMatches || pageCanonMatches ? false : hasRouteTitlePathMismatch(url, title),
    expectedRoute,
    actualRoute,
    actualPageCanonId
  };
}

function normalizeRoutePath(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

function normalizeOptionalRoutePath(path: string | null | undefined): string | null {
  if (!path?.trim()) return null;
  return normalizeRoutePath(path);
}

function firstStringPath(root: unknown, ...paths: string[][]): string | null {
  for (const path of paths) {
    let current: unknown = root;
    for (const key of path) {
      if (!isRecord(current) || !(key in current)) {
        current = null;
        break;
      }
      current = current[key];
    }
    if (typeof current === 'string' && current.trim()) return current;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function determineFallbackReason(page: MaterialPage, pageDiagnostic: ExtractionPageDiagnostic): ExtractionFallbackReason | null {
  if (!pageDiagnostic.hasTitle) return 'json-title-missing';
  if (pageDiagnostic.routeTitlePathMismatch) return 'json-route-mismatch';
  if (pageDiagnostic.tokenTables > pageDiagnostic.tokenTablesRendered) return 'json-missing-token-tables';
  if (pageDiagnostic.noSections) return 'json-no-sections';
  if (page.headings.length === 0) return 'json-no-headings';
  if (page.markdown.length < MIN_REASONABLE_MARKDOWN_LENGTH) return 'json-short-markdown';
  if (page.text.length < MIN_REASONABLE_MARKDOWN_LENGTH) return 'json-suspicious-content';
  if ((pageDiagnostic.qualityScore ?? 0) < MIN_ACCEPTABLE_QUALITY_SCORE) return 'json-low-quality';
  return null;
}

function scoreJsonExtraction(page: MaterialPage, pageDiagnostic: ExtractionPageDiagnostic): number {
  let score = 0;
  if (pageDiagnostic.hasTitle) score += 2;
  if (!pageDiagnostic.noSections) score += 2;
  if (!pageDiagnostic.noHeadings) score += 1;
  if (page.text.length >= MIN_REASONABLE_MARKDOWN_LENGTH) score += 2;
  if (page.headings.length >= 2) score += 1;
  if (pageDiagnostic.imageCount > 0 || pageDiagnostic.videoCount > 0) score += 1;
  if (pageDiagnostic.tokenTables === 0 || pageDiagnostic.tokenTablesRendered === pageDiagnostic.tokenTables) score += 1;
  if (pageDiagnostic.statusTablesResolved && pageDiagnostic.statusTablesResolved > 0) score += 1;
  if (pageDiagnostic.unknownChunkTypes.length > 0) score -= 1;
  if (pageDiagnostic.unknownResourceTypes.length > 0) score -= 1;
  score -= pageDiagnostic.unresolvedResourceCount;
  score -= pageDiagnostic.missingRequestedTokenSets.length;
  if (pageDiagnostic.routeTitlePathMismatch) score -= 1;
  if (pageDiagnostic.markdownLength < MIN_REASONABLE_MARKDOWN_LENGTH) score -= 1;
  if (hasSuspiciousPlaceholderDensity(page.markdown)) score -= 2;
  return score;
}

function hasRouteTitlePathMismatch(url: string, title: string): boolean {
  const pathname = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'components' || segments.length < 2) return false;
  const expectedWords = segments[1]!.split('-').filter((word) => word.length > 1);
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return expectedWords.some((word) => !normalizedTitle.includes(word));
}

async function renderChunkMarkdown(
  chunk: DecodedContentChunk,
  fetchResource: DsdbResourceFetcher,
  pageDiagnostic: ExtractionPageDiagnostic,
  collectedTokenTables: CollectedTokenTable[] = []
): Promise<string> {
  const chunkType = chunk.contentChunkType
    ?? chunk.type
    ?? chunk.kind
    ?? inferChunkType(chunk);

  if (chunkType === 'TEXT') {
    const htmlValue = chunk.htmlValue ?? chunk.html ?? chunk.value ?? chunk.body ?? '';
    return renderHtmlToMarkdown(htmlValue);
  }

  if (chunkType === 'IMAGE') {
    pageDiagnostic.imageCount += 1;
    return renderImageMarkdown(
      chunk.imageUrl ?? chunk.url ?? chunk.src ?? null,
      chunk.altText ?? chunk.alt ?? chunk.title ?? null,
      chunk.footer ?? chunk.caption ?? chunk.captionText ?? null
    );
  }

  if (chunkType === 'VIDEO') {
    pageDiagnostic.videoCount += 1;
    return renderVideoMarkdown({
      url: chunk.url ?? chunk.videoUrl ?? chunk.embedUrl ?? null,
      title: chunk.title ?? null,
      altText: chunk.altText ?? chunk.alt ?? null,
      footer: chunk.footer ?? chunk.caption ?? chunk.description ?? null
    });
  }

  if (chunkType === 'RESOURCE') {
    return renderDsdbResourceChunk(decodeResourceChunk(chunk), fetchResource, pageDiagnostic, collectedTokenTables);
  }

  if (chunkType === 'EMPTY') return '';

  pageDiagnostic.unknownChunkTypes.push(chunkType);
  pageDiagnostic.unresolvedResourceCount += 1;
  return [
    `> Unsupported Material chunk: ${chunkType}`,
    `> ${compactJson(summarizeUnknownChunk(chunk)).slice(0, 280)}`
  ].join('\n');
}

function inferChunkType(chunk: DecodedContentChunk): string {
  if (chunk.htmlValue !== undefined || chunk.html !== undefined) return 'TEXT';
  if (chunk.imageUrl !== undefined || chunk.src !== undefined) return 'IMAGE';
  if (chunk.videoUrl !== undefined || chunk.embedUrl !== undefined) return 'VIDEO';
  if (chunk.libraryModuleType ?? chunk.resourceName ?? chunk.resourcePath) return 'RESOURCE';
  return 'UNKNOWN_CHUNK';
}

function summarizeUnknownChunk(chunk: DecodedContentChunk): Record<string, unknown> {
  return {
    contentChunkType: chunk.contentChunkType,
    type: chunk.type,
    kind: chunk.kind,
    libraryModuleType: chunk.libraryModuleType,
    keys: Object.keys(chunk).sort()
  };
}

function hasSuspiciousPlaceholderDensity(markdown: string): boolean {
  const placeholderMatches = markdown.match(/\[(?:unresolved|missing|unknown)[^\]]*\]|Unsupported Material chunk|Material resource placeholder/gi) ?? [];
  return placeholderMatches.length >= 3;
}
