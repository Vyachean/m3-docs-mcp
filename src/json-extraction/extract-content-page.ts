import type { ExtractionFallbackReason, ExtractionPageDiagnostic, MaterialPage } from '../types.js';
import { renderDsdbResourceChunk, type DsdbResourceFetcher } from './extract-dsdb-resource.js';
import { extractPageDataMetadata } from './extract-page-data.js';
import { asArray, asObject, compactJson, firstArray, firstString, getPath, readBoolean, readString, walkObjects } from './schemas.js';
import { createMaterialPageFromBody, renderHtmlToMarkdown, renderImageMarkdown, renderVideoMarkdown } from './render-markdown.js';

const MIN_REASONABLE_MARKDOWN_LENGTH = 80;
const MIN_ACCEPTABLE_QUALITY_SCORE = 4;

type ParsedSection = {
  title: string;
  blocks: ParsedBlock[];
};

type ParsedBlock = {
  title: string | null;
  chunks: Record<string, unknown>[];
};

export type JsonExtractionResult = {
  page: MaterialPage;
  pageDiagnostic: ExtractionPageDiagnostic;
  fallbackReason: ExtractionFallbackReason | null;
};

export async function extractContentPageToMaterialPage({
  url,
  pageData,
  contentPage,
  capturedAt,
  fetchResource
}: {
  url: string;
  pageData: unknown | null;
  contentPage: unknown | null;
  capturedAt?: string;
  fetchResource: DsdbResourceFetcher;
}): Promise<JsonExtractionResult> {
  const pageDataMeta = extractPageDataMetadata(pageData);
  const discoveredTitle = pageDataMeta.title ?? firstString(contentPage, [['title'], ['name']]);
  const title = discoveredTitle ?? 'Material 3 page';
  const sections = extractSections(contentPage);
  const headings = [discoveredTitle, ...sections.map((section) => section.title).filter(Boolean)].filter((value): value is string => Boolean(value));
  const routeTitlePathMismatch = hasRouteTitlePathMismatch(url, title);
  const pageDiagnostic: ExtractionPageDiagnostic = {
    url,
    path: createMaterialPageFromBody({ url, title, headings, body: `# ${title}` }).path,
    method: 'json',
    source: 'direct-json',
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 0,
    tokenTablesRendered: 0,
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
    routeTitlePathMismatch
  };

  const bodyParts: string[] = [`# ${title}`];
  for (const section of sections) {
    if (section.title.trim()) bodyParts.push(`## ${section.title.trim()}`);
    for (const block of section.blocks) {
      if (block.title?.trim()) bodyParts.push(`### ${block.title.trim()}`);
      for (const chunk of block.chunks) {
        const rendered = await renderChunkMarkdown(chunk, fetchResource, pageDiagnostic);
        if (rendered.trim()) bodyParts.push(rendered.trim());
      }
    }
  }

  if (sections.length === 0) {
    const fallbackText = firstString(contentPage, [['htmlValue'], ['body'], ['description']]);
    if (fallbackText) bodyParts.push(fallbackText);
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

  return { page, pageDiagnostic, fallbackReason };
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

function extractSections(contentPage: unknown): ParsedSection[] {
  const sections = firstArray(contentPage, [
    ['sections'],
    ['content', 'sections'],
    ['page', 'sections'],
    ['data', 'sections']
  ]);
  if (sections.length > 0) return sections.map(parseSection).filter((section): section is ParsedSection => Boolean(section));

  const discovered: ParsedSection[] = [];
  walkObjects(contentPage, (value) => {
    if (discovered.length > 0) return;
    const maybeSections = Object.values(value).find((entry) => Array.isArray(entry) && entry.some((item) => isSectionLike(item)));
    if (Array.isArray(maybeSections)) {
      discovered.push(...maybeSections.map(parseSection).filter((section): section is ParsedSection => Boolean(section)));
    }
  });
  return discovered;
}

function isSectionLike(value: unknown): boolean {
  const obj = asObject(value);
  if (!obj) return false;
  return Array.isArray(obj.contentBlocks) || Array.isArray(obj.blocks) || Array.isArray(obj.contentChunks) || Array.isArray(obj.chunks);
}

function parseSection(rawSection: unknown): ParsedSection | null {
  const section = asObject(rawSection);
  if (!section) return null;
  if (readBoolean(section.isVisible) === false || readBoolean(section.visible) === false) return null;
  const blocks = firstArray(section, [['contentBlocks'], ['blocks'], ['content'], ['items']])
    .map(parseBlock)
    .filter((block): block is ParsedBlock => Boolean(block));
  return {
    title: readString(section.name) ?? readString(section.title) ?? readString(section.heading) ?? 'Section',
    blocks
  };
}

function parseBlock(rawBlock: unknown): ParsedBlock | null {
  const block = asObject(rawBlock);
  if (!block) return null;
  if (readBoolean(block.isHidden) === true || readBoolean(block.hidden) === true) return null;
  const chunks = firstArray(block, [['contentChunks'], ['chunks'], ['content'], ['items']])
    .map(asObject)
    .filter((chunk): chunk is Record<string, unknown> => Boolean(chunk));
  return {
    title: readString(block.title) ?? readString(block.name) ?? readString(block.heading),
    chunks
  };
}

async function renderChunkMarkdown(
  chunk: Record<string, unknown>,
  fetchResource: DsdbResourceFetcher,
  pageDiagnostic: ExtractionPageDiagnostic
): Promise<string> {
  const chunkType = readString(chunk.contentChunkType)
    ?? readString(chunk.type)
    ?? readString(chunk.kind)
    ?? inferChunkType(chunk);

  if (chunkType === 'TEXT') {
    const htmlValue = readString(chunk.htmlValue)
      ?? readString(chunk.html)
      ?? readString(chunk.value)
      ?? readString(chunk.body)
      ?? '';
    return renderHtmlToMarkdown(htmlValue);
  }

  if (chunkType === 'IMAGE') {
    pageDiagnostic.imageCount += 1;
    return renderImageMarkdown(
      readString(chunk.imageUrl) ?? readString(chunk.url) ?? readString(chunk.src),
      readString(chunk.altText) ?? readString(chunk.alt) ?? readString(chunk.title),
      readString(chunk.footer) ?? readString(chunk.caption) ?? readString(chunk.captionText)
    );
  }

  if (chunkType === 'VIDEO') {
    pageDiagnostic.videoCount += 1;
    return renderVideoMarkdown({
      url: readString(chunk.url) ?? readString(chunk.videoUrl) ?? readString(chunk.embedUrl),
      title: readString(chunk.title),
      altText: readString(chunk.altText) ?? readString(chunk.alt),
      footer: readString(chunk.footer) ?? readString(chunk.caption) ?? readString(chunk.description)
    });
  }

  if (chunkType === 'RESOURCE') {
    return renderDsdbResourceChunk(chunk, fetchResource, pageDiagnostic);
  }

  pageDiagnostic.unknownChunkTypes.push(chunkType);
  pageDiagnostic.unresolvedResourceCount += 1;
  return [
    `> Unsupported Material chunk: ${chunkType}`,
    `> ${compactJson(summarizeUnknownChunk(chunk)).slice(0, 280)}`
  ].join('\n');
}

function inferChunkType(chunk: Record<string, unknown>): string {
  if (typeof chunk.htmlValue === 'string' || typeof chunk.html === 'string') return 'TEXT';
  if (typeof chunk.imageUrl === 'string' || typeof chunk.src === 'string') return 'IMAGE';
  if (typeof chunk.videoUrl === 'string' || typeof chunk.embedUrl === 'string') return 'VIDEO';
  if (chunk.libraryModuleType || chunk.resourceName || chunk.resourcePath) return 'RESOURCE';
  return 'UNKNOWN_CHUNK';
}

function summarizeUnknownChunk(chunk: Record<string, unknown>): Record<string, unknown> {
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
