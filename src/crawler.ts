import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import TurndownService from 'turndown';
import { assertSafeCachePromotion, assertValidIndex, createStagingCacheDir, getDefaultCacheDir, promoteStagingCache, readIndex, writeIndex, writePage } from './cache.js';
import { materialPageId, materialPagePath, normalizeMaterialUrl, sectionFromPagePath } from './crawler-utils.js';
import type { CrawlOptions, CrawlProgress, CrawlQualityReport, DuplicateContentGroup, DuplicateTitleGroup, MaterialIndex, MaterialPage, RejectedCrawlRoute, ShortCrawlPage, SuspiciousCrawlPage } from './types.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = 'https://m3.material.io';
const DEFAULT_MIN_PAGE_COUNT = 10;
const MIN_PAGE_TEXT_LENGTH = 80;
const SHORT_PAGE_TEXT_LENGTH = 160;
const CONTENT_PREVIEW_LENGTH = 800;
const COMPONENT_PATH_WITHOUT_OVERVIEW = /^\/components\/([^/]+)$/;
const MATERIAL_CONTENT_SELECTOR = 'main, [role="main"]';
const DEFAULT_CRAWL_CONCURRENCY = 1;
const MAX_DISCOVERED_LINK_FACTOR = 4;
const SITEMAP_FETCH_TIMEOUT_MS = 5_000;
const MIN_EMBEDDED_IMAGE_WIDTH = 800;
const PREFERRED_EMBEDDED_IMAGE_WIDTH = 1600;
const NOT_FOUND_TITLE_PATTERNS = [
  /\bpage cannot be found\b/i,
  /\bthis page cannot be found\b/i,
  /\bpage not found\b/i,
  /\b404\b/i
];
const NOT_FOUND_BODY_PATTERNS = [
  /\bthis page cannot be found\b/i,
  /\bpage cannot be found\b/i,
  /\bpage not found\b/i,
  /\brequested page was not found\b/i,
  /\bcould not find (that|this) page\b/i,
  /\btry a different destination\b/i,
  /\bhead back to the homepage\b/i
];

const NOISE_ONLY_MARKDOWN_LINES = new Set([
  'close',
  'link',
  'pause',
  'search',
  'resources',
  'folderenabled',
  'keyboard_arrow_down',
  'visibilitygrid_viewexpand_all',
  'copy linklink copied',
  'on this page',
  'token'
]);

const TOKEN_BROWSER_NOISE_PATTERNS = [
  /arrowdropdown/i,
  /keyboardarrowdown/i,
  /gridview/i,
  /folderenabled/i
];

const TOKEN_VIEWER_ROW_SELECTORS = [
  'tr',
  '[role="row"]',
  '[class*="token-row"]',
  '[class*="tokenRow"]',
  '[class*="table-row"]',
  '[class*="row"]'
].join(',');

const TOKEN_VIEWER_CELL_SELECTORS = [
  'th',
  'td',
  '[role="columnheader"]',
  '[role="cell"]',
  '[class*="cell"]',
  '[class*="column"]',
  '[class*="name"]',
  '[class*="value"]',
  '[class*="token"]'
].join(',');

type ExtractedContent = {
  html: string;
  title: string;
  headings: string[];
};

type StableSnapshot = {
  url: string;
  title: string;
  text: string;
};

type MaterialContentState = {
  title: string;
  text: string;
  pathname: string;
  renderedNotFound: boolean;
  expectedComponentSlug: string | null;
  pathMatches: boolean;
  contentMatches: boolean;
};

type SerializedPattern = {
  source: string;
  flags: string;
};

class CandidateRejectedError extends Error {
  readonly state: MaterialContentState;
  readonly classification: RejectedCrawlRoute['classification'];

  constructor(message: string, state: MaterialContentState, classification: RejectedCrawlRoute['classification']) {
    super(message);
    this.name = 'CandidateRejectedError';
    this.state = state;
    this.classification = classification;
  }
}

class RequestedRouteRejectedError extends Error {
  readonly rejectedRoute: RejectedCrawlRoute;

  constructor(rejectedRoute: RejectedCrawlRoute, details: string) {
    super(details);
    this.name = 'RequestedRouteRejectedError';
    this.rejectedRoute = rejectedRoute;
  }
}

export async function installPlaywrightChromium(withDependencies = false): Promise<void> {
  const playwrightCli = resolvePlaywrightCliPath();
  await execFileAsync(process.execPath, [playwrightCli, 'install', ...(withDependencies ? ['--with-deps'] : []), 'chromium']);
}

export function resolvePlaywrightCliPath(): string {
  const playwrightPackageJson = require.resolve('playwright/package.json');
  const playwrightPackage = require(playwrightPackageJson) as { bin?: string | Record<string, string> };
  const relativeCliPath = typeof playwrightPackage.bin === 'string'
    ? playwrightPackage.bin
    : playwrightPackage.bin?.playwright;

  if (!relativeCliPath) {
    throw new Error('Could not resolve the Playwright CLI entrypoint from playwright/package.json.');
  }

  return path.join(path.dirname(playwrightPackageJson), relativeCliPath);
}

async function launchChromium(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Executable doesn\'t exist') && !message.includes('browserType.launch')) {
      throw new Error(`Playwright Chromium failed to start. Run: npx -y github:Vyachean/m3-docs-mcp install-browser --with-deps. Original error: ${message}`, { cause: error });
    }

    throw new Error('Playwright Chromium browser is missing. Run: npx -y github:Vyachean/m3-docs-mcp install-browser. On Linux, use: npx -y github:Vyachean/m3-docs-mcp install-browser --with-deps', { cause: error });
  }
}

async function expandMainContent(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]');
    if (!root) return;

    for (const details of Array.from(root.querySelectorAll('details:not([open])'))) {
      details.setAttribute('open', 'true');
    }

    const isSafeContentExpander = (el: Element): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      if (!el.closest('main, [role="main"]')) return false;
      if (el.closest('nav, aside, header, footer, [role="navigation"]')) return false;
      if (el.closest('a')) return false;
      if (el.matches('[href], [role="link"], [role="tab"], [role="menuitem"]')) return false;
      const tag = el.tagName.toLowerCase();
      return tag === 'button' || el.getAttribute('role') === 'button';
    };

    for (let pass = 0; pass < 4; pass += 1) {
      const expandable = Array.from(root.querySelectorAll('[aria-expanded="false"]')).filter(isSafeContentExpander);
      if (expandable.length === 0) break;
      for (const el of expandable) {
        el.click();
        await wait(25);
      }
    }
    await wait(200);
  });
}

async function scrollPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let y = 0;
      const step = Math.max(500, Math.floor(window.innerHeight * 0.8));
      const timer = setInterval(() => {
        y += step;
        window.scrollTo(0, y);
        if (y >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  });
}

async function navigateToStableMaterialPage(page: Page, requestedUrl: string, baseUrl: string, signal?: AbortSignal): Promise<string> {
  const candidates = materialCrawlCandidates(requestedUrl, baseUrl);
  if (candidates.length === 0) throw new Error(`Unsupported Material URL: ${requestedUrl}`);

  let lastError: unknown;
  let lastRejectedCandidate: CandidateRejectedError | null = null;
  for (const loadUrl of candidates) {
    throwIfAborted(signal);
    try {
      await page.goto(loadUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector(MATERIAL_CONTENT_SELECTOR, { timeout: 15_000 });
      await waitForMaterialContent(page, loadUrl);
      await waitForStableMaterialSnapshot(page, signal);
      return normalizeMaterialUrl(page.url(), baseUrl) ?? loadUrl;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof CandidateRejectedError) lastRejectedCandidate = error;
      lastError = error;
    }
  }

  if (lastRejectedCandidate) {
    const normalizedRequestedUrl = normalizeMaterialUrl(requestedUrl, baseUrl) ?? requestedUrl;
    throw new RequestedRouteRejectedError({
      url: normalizedRequestedUrl,
      path: materialPagePath(normalizedRequestedUrl),
      title: lastRejectedCandidate.state.title || 'Untitled',
      reason: lastRejectedCandidate.message,
      classification: lastRejectedCandidate.classification,
      status: 'failed'
    }, `Material page rejected for ${requestedUrl}. Tried: ${candidates.join(', ')}. Last rejection: ${lastRejectedCandidate.message}`);
  }

  const details = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Material page did not render stable content for ${requestedUrl}. Tried: ${candidates.join(', ')}. Last error: ${details}`);
}

async function waitForMaterialContent(page: Page, requestedUrl: string): Promise<void> {
  const state = await readMaterialContentState(page, requestedUrl);
  if (state.renderedNotFound) {
    throw new CandidateRejectedError('route rendered a not found page', state, 'not-found');
  }
  if (state.expectedComponentSlug && (!state.pathMatches || !state.contentMatches)) {
    throw new CandidateRejectedError(`component route content did not match expected component slug ${state.expectedComponentSlug}`, state, 'route-mismatch');
  }
}

async function readMaterialContentState(page: Page, requestedUrl: string): Promise<MaterialContentState> {
  const expectedComponentSlug = componentSlugFromUrl(requestedUrl);
  const notFoundTitlePatterns = serializePatterns(NOT_FOUND_TITLE_PATTERNS);
  const notFoundBodyPatterns = serializePatterns(NOT_FOUND_BODY_PATTERNS);
  await page.waitForFunction(({ minPageTextLength, notFoundTitlePatterns, notFoundBodyPatterns }) => {
    const normalize = (value: string) => value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const matchesAnyPattern = (value: string, patterns: SerializedPattern[]) => patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(value));
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    const rawTitle = root.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const rawText = root.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const title = normalize(rawTitle);
    const text = normalize(rawText);
    const renderedNotFound = matchesAnyPattern(title, notFoundTitlePatterns)
      || matchesAnyPattern(text, notFoundBodyPatterns);

    return renderedNotFound || (rawText.length >= minPageTextLength && Boolean(rawTitle));
  }, {
    minPageTextLength: MIN_PAGE_TEXT_LENGTH,
    notFoundTitlePatterns,
    notFoundBodyPatterns
  }, { timeout: 20_000 });

  return page.evaluate(({ componentSlug, notFoundTitlePatterns, notFoundBodyPatterns }) => {
    const normalize = (value: string) => value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const matchesAnyPattern = (value: string, patterns: SerializedPattern[]) => patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(value));
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    const rawTitle = root.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const rawText = root.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const title = normalize(rawTitle);
    const text = normalize(rawText);
    const pathname = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const renderedNotFound = matchesAnyPattern(title, notFoundTitlePatterns)
      || matchesAnyPattern(text, notFoundBodyPatterns);
    if (!componentSlug) {
      return {
        title: rawTitle,
        text: rawText,
        pathname,
        renderedNotFound,
        expectedComponentSlug: null,
        pathMatches: true,
        contentMatches: true
      };
    }

    const componentName = normalize(componentSlug.replace(/-/g, ' '));
    const componentWords = componentName.split(' ').filter((word) => word.length > 1);
    const pathMatches = pathname === `components/${componentSlug}` || pathname === `components/${componentSlug}/overview` || pathname.startsWith(`components/${componentSlug}/`);
    const contentMatches = title !== 'components' && !renderedNotFound && componentWords.every((word) => text.includes(word));
    return {
      title: rawTitle,
      text: rawText,
      pathname,
      renderedNotFound,
      expectedComponentSlug: componentSlug,
      pathMatches,
      contentMatches
    };
  }, {
    componentSlug: expectedComponentSlug,
    notFoundTitlePatterns,
    notFoundBodyPatterns
  });
}

async function waitForStableMaterialSnapshot(page: Page, signal?: AbortSignal): Promise<void> {
  let previous: StableSnapshot | null = null;
  let stableReads = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    throwIfAborted(signal);
    const current = await materialSnapshot(page);
    if (previous && current.url === previous.url && current.title === previous.title && current.text === previous.text) {
      stableReads += 1;
      if (stableReads >= 2) return;
    } else {
      stableReads = 0;
    }
    previous = current;
    await delay(250, signal);
  }
  throw new Error('Material page content did not stabilize before extraction.');
}

async function materialSnapshot(page: Page): Promise<StableSnapshot> {
  return page.evaluate(() => {
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    return {
      url: window.location.href,
      title: root.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      text: root.textContent?.replace(/\s+/g, ' ').trim().slice(0, 5000) ?? ''
    };
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason ? String(signal.reason) : 'Material 3 crawl was interrupted.');
}

export function extractMaterialPageFromHtml(html: string, url: string, capturedAt = new Date().toISOString(), metadata?: Partial<Pick<ExtractedContent, 'title' | 'headings'>>): MaterialPage {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  addMaterialMarkdownRules(turndown);

  const relPath = materialPagePath(url);
  const sanitizedHtml = preserveBackgroundImageAttributes(preserveTokenViewerTextLines(stripUnsafeHtml(html)));
  const title = metadata?.title?.trim() || titleFromHtml(sanitizedHtml) || 'Material 3 page';
  const headings = metadata?.headings?.map((heading) => heading.trim()).filter(Boolean) ?? headingsFromHtml(sanitizedHtml);
  const rawBody = turndown.turndown(sanitizedHtml)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const body = postProcessMarkdown(rawBody);
  const text = stripMarkdown(body).replace(/\s+/g, ' ').trim();
  const markdown = `---\ntitle: ${JSON.stringify(title)}\nsourceUrl: ${url}\nsection: ${sectionFromPagePath(relPath)}\ncapturedAt: ${capturedAt}\n---\n\n${body}\n`;
  return {
    id: materialPageId(url),
    title,
    url,
    path: relPath,
    section: sectionFromPagePath(relPath),
    headings,
    text,
    markdown,
    capturedAt
  };
}

function addMaterialMarkdownRules(turndown: TurndownService): void {
  turndown.addRule('materialTables', {
    filter: (node) => isElementNode(node) && nodeName(node) === 'table',
    replacement: (_content, node) => tableElementToMarkdown(turndown, node as Element)
  });

  turndown.addRule('materialTokenViewer', {
    filter: (node) => isElementNode(node) && nodeName(node) === 'token-viewer',
    replacement: (_content, node) => tokenViewerElementToMarkdown(turndown, node as Element)
  });

  turndown.addRule('materialBackgroundImage', {
    filter: (node) => isElementNode(node) && Boolean(node.getAttribute('data-background-image')),
    replacement: (content, node) => {
      if (!isElementNode(node)) return content;
      const imageUrl = node.getAttribute('data-background-image')?.trim();
      if (!imageUrl) return content;
      const alt = normalizeInlineText(content || node.textContent || '').slice(0, 120);
      return `\n\n![${escapeMarkdownAttribute(alt)}](${preferLargeImageUrl(imageUrl)})\n\n`;
    }
  });
}

function tableElementToMarkdown(turndown: TurndownService, table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'))
    .filter((row) => row.closest('table') === table);
  const markdownRows = rows
    .map((row) => cellsFromRow(turndown, row))
    .filter((cells) => cells.some(Boolean));
  return markdownTable(markdownRows);
}

function cellsFromRow(turndown: TurndownService, row: Element): string[] {
  return Array.from(row.querySelectorAll('th, td'))
    .filter((cell) => cell.closest('tr') === row)
    .map((cell) => elementToTableCellMarkdown(turndown, cell));
}

function tokenViewerElementToMarkdown(turndown: TurndownService, viewer: Element): string {
  const nestedTable = viewer.querySelector('table');
  if (nestedTable) return tableElementToMarkdown(turndown, nestedTable);

  const rowCandidates = Array.from(viewer.querySelectorAll(TOKEN_VIEWER_ROW_SELECTORS))
    .filter((row) => row !== viewer && !hasAncestorMatching(row, viewer, TOKEN_VIEWER_ROW_SELECTORS));
  const rows = rowCandidates
    .map((row) => tokenViewerCellsFromRow(turndown, row))
    .filter((cells) => cells.length > 0 && cells.some(Boolean));

  if (rows.length > 0) return tokenRowsToMarkdown(rows);

  const lines = tokenViewerFallbackLines(viewer).filter((line) => !isTokenViewerNoise(line));
  if (lines.length >= 4 && lines.length % 2 === 0) {
    const pairs: string[][] = [];
    for (let i = 0; i < lines.length; i += 2) pairs.push([lines[i] ?? '', lines[i + 1] ?? '']);
    return markdownTable([['Name', 'Value'], ...pairs]);
  }
  return lines.length ? `\n\n${lines.map((line) => `- ${escapeMarkdownListText(line)}`).join('\n')}\n\n` : '';
}

function tokenViewerCellsFromRow(turndown: TurndownService, row: Element): string[] {
  const explicitCells = Array.from(row.querySelectorAll(TOKEN_VIEWER_CELL_SELECTORS))
    .filter((cell) => cell !== row && !hasAncestorMatching(cell, row, TOKEN_VIEWER_CELL_SELECTORS));
  if (explicitCells.length > 1) {
    return explicitCells.map((cell) => elementToTableCellMarkdown(turndown, cell)).filter((cell) => cell && !isTokenViewerNoise(cell));
  }

  const childCells = Array.from(row.children)
    .filter((child) => normalizeInlineText(child.textContent ?? '') && !isTokenViewerNoise(child.textContent ?? ''))
    .map((child) => elementToTableCellMarkdown(turndown, child));
  if (childCells.length > 1) return childCells;

  const lines = visibleTextLines(row.textContent ?? '').filter((line) => !isTokenViewerNoise(line));
  return lines.length > 1 ? lines.map(escapeMarkdownTableCell) : [];
}

function tokenViewerFallbackLines(viewer: Element): string[] {
  const childNodeLines = Array.from(viewer.childNodes).flatMap((node) => {
    if (node.nodeType === 3) return visibleTextLines(node.textContent ?? '');
    if (isElementNode(node)) return visibleTextLines(node.textContent ?? '');
    return [];
  });
  if (childNodeLines.length > 1) return childNodeLines;

  const htmlLines = visibleTextLines(viewer.innerHTML
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|span|li|tr|th|td|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
  if (htmlLines.length > childNodeLines.length) return htmlLines;

  return childNodeLines.length ? childNodeLines : visibleTextLines(viewer.textContent ?? '');
}

function tokenRowsToMarkdown(rows: string[][]): string {
  const maxColumns = Math.max(...rows.map((row) => row.length));
  if (maxColumns <= 1) return `\n\n${rows.flat().map((line) => `- ${escapeMarkdownListText(line)}`).join('\n')}\n\n`;

  const firstRow = rows[0] ?? [];
  const firstRowLooksLikeHeader = firstRow.some((cell) => /^(element|attribute|token|value|default|property|name|description)$/i.test(normalizeInlineText(cell)));
  const fallbackHeaders = ['Name', 'Value', 'Description', 'State', 'Notes'].slice(0, maxColumns);
  const tableRows = firstRowLooksLikeHeader ? rows : [fallbackHeaders, ...rows];
  return markdownTable(tableRows.map((row) => padRow(row, maxColumns)));
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  if (width === 0) return '';

  const header = padRow(rows[0] ?? [], width).map((cell, index) => cell || `Column ${index + 1}`);
  const body = rows.slice(1).map((row) => padRow(row, width));
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`)
  ];
  return `\n\n${lines.join('\n')}\n\n`;
}

function padRow(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index] ?? '');
}

function elementToTableCellMarkdown(turndown: TurndownService, element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const nestedTable of Array.from(clone.querySelectorAll('table'))) nestedTable.remove();

  const html = clone.innerHTML || clone.textContent || '';
  const markdown = turndown.turndown(html).replace(/\n{2,}/g, '<br>').replace(/\n/g, '<br>');
  return escapeMarkdownTableCell(normalizeInlineText(markdown));
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').trim();
}

function escapeMarkdownAttribute(value: string): string {
  return value.replace(/[\[\]\\]/g, '\\$&').trim();
}

function escapeMarkdownListText(value: string): string {
  return value.replace(/^([-*+]\s+)/, '\\$1').trim();
}

function normalizeInlineText(value: string): string {
  return value.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

function visibleTextLines(value: string): string[] {
  return value.split(/\r?\n|\t/).map(normalizeInlineText).filter(Boolean);
}

function isTokenViewerNoise(value: string): boolean {
  const normalized = normalizeNoiseText(value);
  return NOISE_ONLY_MARKDOWN_LINES.has(normalized) || TOKEN_BROWSER_NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isElementNode(node: unknown): node is Element {
  return Boolean(node && (node as Node).nodeType === 1);
}

function nodeName(node: Element): string {
  return node.nodeName.toLowerCase();
}

function hasAncestorMatching(node: Element, boundary: Element, selector: string): boolean {
  let parent = node.parentElement;
  while (parent && parent !== boundary) {
    if (parent.matches(selector)) return true;
    parent = parent.parentElement;
  }
  return false;
}

function preferLargeImageUrl(url: string): string {
  return url
    .replace(/=w(\d+)(?!\d)/g, (match, width: string) => Number(width) < MIN_EMBEDDED_IMAGE_WIDTH ? `=w${PREFERRED_EMBEDDED_IMAGE_WIDTH}` : match)
    .replace(/=s0(?!\d)/g, `=w${PREFERRED_EMBEDDED_IMAGE_WIDTH}`);
}

function normalizeMarkdownImageUrls(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, imageUrl: string) => `![${alt}](${preferLargeImageUrl(imageUrl)})`);
}

function preserveBackgroundImageAttributes(html: string): string {
  return html.replace(/<([a-z][\w:-]*)([^>]*)>/gi, (match, tagName: string, attributes: string) => {
    if (/\sdata-background-image\s*=/i.test(attributes)) return match;
    const style = attributes.match(/\sstyle=(['"])([\s\S]*?)\1/i)?.[2];
    if (!style) return match;

    const imageUrl = backgroundImageUrlFromStyle(style);
    if (!imageUrl) return match;

    return `<${tagName}${attributes} data-background-image="${escapeHtmlAttribute(imageUrl)}">`;
  });
}

function backgroundImageUrlFromStyle(style: string): string | null {
  const match = style.match(/background-image\s*:\s*url\(\s*(['"]?)(.*?)\1\s*\)/i);
  return match?.[2]?.trim() || null;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripUnsafeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
}

function preserveTokenViewerTextLines(html: string): string {
  return html.replace(/<token-viewer\b([^>]*)>([\s\S]*?)<\/token-viewer>/gi, (match, attributes: string, body: string) => {
    if (/<(?:table|thead|tbody|tfoot|tr|th|td)\b/i.test(body)) return match;
    if (/\b(?:role|class)\s*=/i.test(body)) return match;

    const lines = visibleTextLines(stripHtml(body));
    if (lines.length <= 1) return match;
    return `<token-viewer${attributes}>${lines.map(escapeHtmlText).join('<br>')}</token-viewer>`;
  });
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function extract(page: Page, url: string): Promise<MaterialPage> {
  const content = await page.evaluate(() => {
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    const clone = root.cloneNode(true) as HTMLElement;
    for (const selector of ['script', 'style', 'noscript', 'svg[aria-hidden="true"]']) {
      for (const el of Array.from(clone.querySelectorAll(selector))) el.remove();
    }
    for (const selector of ['nav', '[role="navigation"]', '[role="tablist"]', 'button', '[role="button"]', 'input', 'select']) {
      for (const el of Array.from(clone.querySelectorAll(selector))) {
        const text = el.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
        if (!text || text === 'copy link' || text === 'close' || text === 'search') el.remove();
      }
    }
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
    const isNoiseOnlyText = (value: string) => {
      const text = normalize(value);
      if (!text) return false;
      if (text === 'on this page' || text === 'copy link' || text === 'link copied') return true;
      if (/^resources[a-z0-9+]+$/i.test(text)) return true;
      if (/^(link|pause|search|close)$/i.test(text)) return true;
      if (/^(infooverview|stylespecs|design_servicesguidelines|head_mounted_devicexr|accessibility_newaccessibility)$/i.test(text.replace(/[^a-z_]/g, ''))) return true;
      return false;
    };
    for (const el of Array.from(clone.querySelectorAll<HTMLElement>('p, div, span, li, a'))) {
      if (el.children.length > 0) continue;
      if (isNoiseOnlyText(el.textContent ?? '')) el.remove();
    }
    for (const el of Array.from(clone.querySelectorAll<HTMLElement>('[style*="background-image"]'))) {
      const backgroundImage = el.style.backgroundImage;
      const match = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/i);
      if (match?.[1]) el.setAttribute('data-background-image', match[1]);
    }
    const textContent = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return {
      html: clone.innerHTML,
      title: textContent(clone.querySelector('h1')),
      headings: Array.from(clone.querySelectorAll('h1, h2, h3, h4')).map(textContent).filter(Boolean)
    };
  });
  return extractMaterialPageFromHtml(content.html, url, undefined, { title: content.title, headings: content.headings });
}

function postProcessMarkdown(markdown: string): string {
  const lines = markdown
    .replace(/\r\n/g, '\n')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\u200b/g, '')
    .replace(/!\[([^\]]*)\]\(([^)]*=w\d+[^)]*)\)\s*!\[\1\]\(([^)]*=s0[^)]*)\)/g, '![$1]($2)')
    .replace(/!\[([^\]]*)\]\(([^)]*=s0[^)]*)\)\s*!\[\1\]\(([^)]*=w\d+[^)]*)\)/g, '![$1]($3)')
    .split('\n');

  const cleaned: string[] = [];
  let inFencedCodeBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    const isFence = /^\s*```/.test(rawLine);
    const line = inFencedCodeBlock ? rawLine.replace(/[^\S\n]+$/g, '') : cleanMarkdownLine(rawLine);
    if (!inFencedCodeBlock && shouldDropMarkdownLine(line)) continue;

    const previous = cleaned[cleaned.length - 1] ?? '';
    if (!line && !previous) continue;
    cleaned.push(line);

    if (isFence) inFencedCodeBlock = !inFencedCodeBlock;
  }

  return collapseBlankLines(cleaned).join('\n').trim();
}

function cleanMarkdownLine(line: string): string {
  const trailingTrimmed = line.replace(/[^\S\n]+$/g, '');
  const leadingWhitespace = trailingTrimmed.match(/^\s*/)?.[0] ?? '';
  const content = trailingTrimmed.slice(leadingWhitespace.length).trim();
  if (/^check\s+do$/i.test(content)) return `${leadingWhitespace}Do`;
  if (/^close\s+don['’]?t$/i.test(content)) return `${leadingWhitespace}Don't`;
  const cleanedContent = content
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ');
  return `${leadingWhitespace}${normalizeMarkdownImageUrls(cleanedContent)}`;
}

function shouldDropMarkdownLine(line: string): boolean {
  if (!line) return false;

  const normalized = normalizeNoiseText(line);
  if (NOISE_ONLY_MARKDOWN_LINES.has(normalized)) return true;
  if (/^resources[a-z0-9+]+$/i.test(normalized)) return true;
  if (/^\[(infooverview|stylespecs|design_servicesguidelines|head_mounted_devicexr|accessibility_newaccessibility)/i.test(line)) return true;
  if (TOKEN_BROWSER_NOISE_PATTERNS.some((pattern) => pattern.test(normalized)) && normalized.length < 80) return true;
  return false;
}

function collapseBlankLines(lines: string[]): string[] {
  return lines.filter((line, index, arr) => {
    if (line) return true;
    return (arr[index - 1] ?? '') !== '' && (arr[index + 1] ?? '') !== '';
  });
}

function normalizeNoiseText(value: string): string {
  return value.toLowerCase().replace(/[`*_~[\]()]|\\/g, '').replace(/\s+/g, ' ').trim();
}

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\n{2,}/g, '\n');
}

export function normalizeMaterialCrawlUrl(raw: string, baseUrl: string): string | null {
  return normalizeMaterialUrl(raw, baseUrl);
}

export function materialCrawlCandidates(raw: string, baseUrl: string): string[] {
  const normalized = normalizeMaterialCrawlUrl(raw, baseUrl);
  if (!normalized) return [];
  const candidates = [normalized];
  const url = new URL(normalized);
  const componentMatch = url.pathname.match(COMPONENT_PATH_WITHOUT_OVERVIEW);
  const slug = componentMatch?.[1];
  if (slug) {
    url.pathname = `/components/${slug}/overview`;
    const overviewUrl = url.toString().replace(/\/$/, '');
    if (!candidates.includes(overviewUrl)) candidates.push(overviewUrl);
  }
  return candidates;
}

export function discoverMaterialLinksFromHrefs(hrefs: string[], baseUrl: string): string[] {
  return Array.from(new Set(hrefs.map((href) => normalizeMaterialCrawlUrl(href, baseUrl)).filter((value): value is string => Boolean(value)))).sort(compareMaterialCrawlPriority);
}

async function discoverSitemapLinks(baseUrl: string): Promise<string[]> {
  if (typeof fetch !== 'function') return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITEMAP_FETCH_TIMEOUT_MS);
  try {
    const sitemapUrl = new URL('/sitemap.xml', baseUrl).toString();
    const response = await fetch(sitemapUrl, { signal: controller.signal });
    if (!response.ok) return [];
    const body = await response.text();
    const locUrls = Array.from(body.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)).map((match) => match[1]).filter((url): url is string => Boolean(url));
    const urls = locUrls.length > 0 ? locUrls : Array.from(body.matchAll(/https?:\/\/[^\s<]+/g)).map((match) => match[0]);
    return discoverMaterialLinksFromHrefs(urls, baseUrl);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function discoverLinks(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href));
  return discoverMaterialLinksFromHrefs(links, baseUrl);
}

async function assertMaterialRouteUnchanged(page: Page, expectedUrl: string, baseUrl: string, phase: string): Promise<void> {
  const currentUrl = normalizeMaterialUrl(page.url(), baseUrl);
  if (currentUrl !== expectedUrl) {
    throw new Error(`Material page route changed during ${phase}: expected ${expectedUrl}, got ${currentUrl ?? page.url()}`);
  }
}

export function validateCrawledPage(page: MaterialPage): SuspiciousCrawlPage | null {
  const path = new URL(page.url).pathname.replace(/^\/+|\/+$/g, '');
  const segments = path.split('/').filter(Boolean);
  const title = normalizeText(page.title);
  const firstHeading = normalizeText(page.headings[0] ?? page.title);
  const contentPreview = normalizeText(`${page.title} ${page.headings.join(' ')} ${page.text.slice(0, CONTENT_PREVIEW_LENGTH)}`);

  if (isNotFoundPage(page)) {
    return rejectedRoute(page, 'route rendered a not found page', 'not-found');
  }

  if (segments[0] === 'components' && segments.length >= 2) {
    const componentSlug = segments[1] ?? '';
    const componentName = normalizeSlug(componentSlug);
    if (title === 'components' || firstHeading === 'components') {
      return rejectedRoute(page, `component route rendered the parent Components index instead of ${componentSlug}`, 'route-mismatch');
    }
    if (!containsAllWords(contentPreview, componentName.split(' '))) {
      return rejectedRoute(page, `component route content does not mention expected component slug ${componentSlug}`, 'route-mismatch');
    }
  }

  return null;
}

export function createCrawlQualityReport(pages: MaterialPage[], rejectedSuspiciousPages: SuspiciousCrawlPage[] = []): CrawlQualityReport {
  const rejectedRoutes = rejectedSuspiciousPages.map(toRejectedRoute);
  const suspiciousPages = pages.map(validateCrawledPage).filter((page): page is SuspiciousCrawlPage => Boolean(page));
  const shortPages: ShortCrawlPage[] = pages
    .filter((page) => page.text.length < SHORT_PAGE_TEXT_LENGTH)
    .map((page) => ({ url: page.url, path: page.path, title: page.title, textLength: page.text.length }));
  const pagesBySection = countBy(pages.map((page) => page.section));
  return {
    suspiciousPages,
    rejectedRoutes,
    duplicateContent: duplicateContentGroups(pages),
    shortPages,
    duplicateTitles: duplicateTitleGroups(pages),
    pagesBySection
  };
}

export async function crawlMaterialDocs(options: CrawlOptions = {}): Promise<MaterialIndex> {
  const targetCacheDir = options.cacheDir ?? getDefaultCacheDir();
  const previousIndex = await readIndex(targetCacheDir);
  const stagingCacheDir = await createStagingCacheDir(targetCacheDir);

  try {
    const index = await crawlIntoCache(stagingCacheDir, options);
    assertValidIndex(index, options.minPageCount ?? DEFAULT_MIN_PAGE_COUNT);
    assertSafeCachePromotion(index, previousIndex, { force: options.force });
    await promoteStagingCache(stagingCacheDir, targetCacheDir);
    return index;
  } catch (error) {
    await rm(stagingCacheDir, { recursive: true, force: true });
    throw error;
  }
}

async function crawlIntoCache(cacheDir: string, options: CrawlOptions): Promise<MaterialIndex> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const maxPages = options.maxPages ?? 250;
  const concurrency = Math.min(options.concurrency ?? DEFAULT_CRAWL_CONCURRENCY, maxPages);
  const signal = options.signal;
  const startedAt = new Date().toISOString();
  const currentUrls = new Map<number, string>();
  let lastSavedUrl: string | null = null;
  let lastFailedUrl: string | null = null;
  throwIfAborted(signal);

  const browser = await launchChromium(options.headless ?? true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const queue: string[] = [];
  const queued = new Set<string>();
  const seen = new Set<string>();
  const writtenPaths = new Set<string>();
  const pages: MaterialPage[] = [];
  const failedUrls: string[] = [];
  const suspiciousPages: SuspiciousCrawlPage[] = [];
  const waiters: Array<() => void> = [];
  let activeWorkers = 0;
  let aborted = false;

  const emitProgress = (running: boolean, error: string | null = null): void => {
    const completedAt = running ? null : new Date().toISOString();
    const progress: CrawlProgress = {
      startedAt,
      updatedAt: new Date().toISOString(),
      completedAt,
      running,
      maxPages,
      concurrency,
      attemptedPageCount: seen.size,
      savedPageCount: pages.length,
      failedPageCount: failedUrls.length,
      queuedPageCount: queue.length,
      activeWorkerCount: activeWorkers,
      currentUrls: Array.from(currentUrls.values()).sort(),
      lastSavedUrl,
      lastFailedUrl,
      error
    };
    options.onProgress?.(progress);
  };

  const onAbort = () => {
    aborted = true;
    emitProgress(false, 'Material 3 crawl was interrupted.');
    wakeWorkers();
    void context.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  enqueue(baseUrl);
  for (const link of await discoverSitemapLinks(baseUrl)) enqueue(link);
  emitProgress(true);

  try {
    await Promise.all(Array.from({ length: concurrency }, (_, workerIndex) => worker(workerIndex)));
  } catch (error) {
    emitProgress(false, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    wakeWorkers();
    await browser.close();
  }

  throwIfAborted(signal);

  const capturedAt = new Date().toISOString();
  const qualityReport = createCrawlQualityReport(pages, suspiciousPages);
  const index: MaterialIndex = {
    source: baseUrl,
    capturedAt,
    pageCount: pages.length,
    attemptedPageCount: seen.size,
    failedPageCount: failedUrls.length,
    failedUrls,
    qualityReport,
    pages: pages.map(({ text: _text, markdown: _markdown, ...meta }) => meta)
  };
  await writeIndex(index, cacheDir);
  emitProgress(false);
  return index;

  async function worker(workerIndex: number): Promise<void> {
    while (!aborted) {
      throwIfAborted(signal);
      if (pages.length >= maxPages) return;

      let url = takeUrl();
      while (!url && activeWorkers > 0 && pages.length < maxPages && !aborted) {
        await waitForQueuedUrl();
        throwIfAborted(signal);
        url = takeUrl();
      }
      if (!url) return;

      let page: Page | null = null;
      activeWorkers += 1;
      currentUrls.set(workerIndex, url);
      emitProgress(true);
      try {
        page = await context.newPage();
        throwIfAborted(signal);
        await crawlPage(page, url);
      } catch (error) {
        if (signal?.aborted) throw error;
        failedUrls.push(url);
        lastFailedUrl = url;
        emitProgress(true);
        console.error(`Failed to crawl ${url}:`, error instanceof Error ? error.message : String(error));
      } finally {
        activeWorkers -= 1;
        currentUrls.delete(workerIndex);
        emitProgress(true);
        await page?.close().catch(() => undefined);
        wakeWorkers();
      }
    }
  }

  function takeUrl(): string | null {
    while (queue.length > 0) {
      const queuedUrl = queue.shift();
      if (!queuedUrl) continue;
      queued.delete(queuedUrl);
      if (seen.has(queuedUrl)) continue;
      seen.add(queuedUrl);
      emitProgress(true);
      return queuedUrl;
    }
    return null;
  }

  async function crawlPage(page: Page, url: string): Promise<void> {
    let finalUrl: string;
    try {
      finalUrl = await navigateToStableMaterialPage(page, url, baseUrl, signal);
    } catch (error) {
      if (error instanceof RequestedRouteRejectedError) {
        suspiciousPages.push(error.rejectedRoute);
        failedUrls.push(url);
        lastFailedUrl = url;
        emitProgress(true);
        console.error(`Rejected crawled ${url}: ${error.rejectedRoute.reason}`);
        return;
      }
      throw error;
    }
    if (finalUrl !== url) seen.add(finalUrl);
    currentUrls.set(currentUrls.get(0) === url ? 0 : Array.from(currentUrls.entries()).find(([, current]) => current === url)?.[0] ?? 0, finalUrl);
    emitProgress(true);
    await expandMainContent(page);
    await assertMaterialRouteUnchanged(page, finalUrl, baseUrl, 'content expansion');
    await scrollPage(page);
    await assertMaterialRouteUnchanged(page, finalUrl, baseUrl, 'lazy-load scrolling');
    await waitForStableMaterialSnapshot(page, signal);
    await assertMaterialRouteUnchanged(page, finalUrl, baseUrl, 'stabilization');
    const materialPage = await extract(page, finalUrl);
    const suspiciousResult = validateCrawledPage(materialPage);
    if (suspiciousResult) {
      suspiciousPages.push(suspiciousResult);
      failedUrls.push(url);
      lastFailedUrl = url;
      emitProgress(true);
      console.error(`Rejected crawled ${url}: ${suspiciousResult.reason}`);
      return;
    }
    if (materialPage.text.length > MIN_PAGE_TEXT_LENGTH && pages.length < maxPages && !writtenPaths.has(materialPage.path)) {
      pages.push(materialPage);
      lastSavedUrl = finalUrl;
      writtenPaths.add(materialPage.path);
      await writePage(materialPage, cacheDir);
      emitProgress(true);
    }

    await assertMaterialRouteUnchanged(page, finalUrl, baseUrl, 'link discovery');
    for (const link of await discoverLinks(page, baseUrl)) enqueue(link);
    emitProgress(true);
  }

  function enqueue(raw: string): void {
    const link = normalizeMaterialCrawlUrl(raw, baseUrl);
    if (!link || seen.has(link) || queued.has(link)) return;
    if (queue.length + seen.size >= maxPages * MAX_DISCOVERED_LINK_FACTOR) return;
    queue.push(link);
    queue.sort(compareMaterialCrawlPriority);
    queued.add(link);
    emitProgress(true);
    wakeWorkers();
  }

  function waitForQueuedUrl(): Promise<void> {
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  function wakeWorkers(): void {
    for (const resolve of waiters.splice(0)) resolve();
  }
}

function compareMaterialCrawlPriority(a: string, b: string): number {
  return materialCrawlPriority(a) - materialCrawlPriority(b) || a.localeCompare(b);
}

function materialCrawlPriority(url: string): number {
  const path = new URL(url).pathname;
  if (path === '/') return 0;
  if (path.startsWith('/get-started')) return 1;
  if (path.startsWith('/components')) return 2;
  if (path.startsWith('/foundations')) return 3;
  if (path.startsWith('/styles')) return 4;
  if (path.startsWith('/develop')) return 5;
  if (path.startsWith('/blog')) return 6;
  return 7;
}

function duplicateContentGroups(pages: MaterialPage[]): DuplicateContentGroup[] {
  const groups = new Map<string, MaterialPage[]>();
  for (const page of pages) {
    if (page.text.length < SHORT_PAGE_TEXT_LENGTH) continue;
    const hash = crypto.createHash('sha256').update(stripMarkdownFrontmatter(page.markdown).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
    const group = groups.get(hash) ?? [];
    group.push(page);
    groups.set(hash, group);
  }
  return Array.from(groups.entries())
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => ({
      hash,
      title: group[0]?.title ?? '',
      paths: group.map((page) => page.path).sort(),
      urls: group.map((page) => page.url).sort()
    }));
}

function duplicateTitleGroups(pages: MaterialPage[]): DuplicateTitleGroup[] {
  const groups = new Map<string, MaterialPage[]>();
  for (const page of pages) {
    const key = normalizeText(page.title);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(page);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => ({ title: group[0]?.title ?? '', count: group.length, paths: group.map((page) => page.path).sort() }));
}

function componentSlugFromUrl(url: string): string | null {
  const pathname = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  const segments = pathname.split('/').filter(Boolean);
  return segments[0] === 'components' && segments.length >= 2 ? segments[1] ?? null : null;
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function rejectedRoute(page: MaterialPage, reason: string, classification: RejectedCrawlRoute['classification']): RejectedCrawlRoute {
  return { url: page.url, path: page.path, title: page.title, reason, classification, status: 'failed' };
}

function toRejectedRoute(page: SuspiciousCrawlPage): RejectedCrawlRoute {
  if ('classification' in page && 'status' in page) return page as RejectedCrawlRoute;
  const classification = page.reason === 'route rendered a not found page' ? 'not-found' : 'route-mismatch';
  return { ...page, classification, status: 'failed' };
}

function isNotFoundPage(page: Pick<MaterialPage, 'title' | 'headings' | 'text'>): boolean {
  const title = page.title.trim();
  const firstHeading = (page.headings[0] ?? '').trim();
  const preview = `${page.title}\n${page.headings.join('\n')}\n${page.text.slice(0, CONTENT_PREVIEW_LENGTH)}`;
  return matchesAnyPattern(title, NOT_FOUND_TITLE_PATTERNS)
    || matchesAnyPattern(firstHeading, NOT_FOUND_TITLE_PATTERNS)
    || matchesAnyPattern(preview, NOT_FOUND_BODY_PATTERNS);
}

function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function serializePatterns(patterns: RegExp[]): SerializedPattern[] {
  return patterns.map((pattern) => ({ source: pattern.source, flags: pattern.flags }));
}

function normalizeSlug(value: string): string {
  return normalizeText(value.replace(/-/g, ' '));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAllWords(text: string, words: string[]): boolean {
  return words.filter((word) => word.length > 1).every((word) => text.includes(word));
}

function stripMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---\s*/, '');
}

function titleFromHtml(html: string): string {
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return stripHtml(titleMatch?.[1] ?? '').trim();
}

function headingsFromHtml(html: string): string[] {
  return Array.from(html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)).map((match) => stripHtml(match[1]).trim()).filter(Boolean);
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<noscript[\s\S]*?<\/noscript>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
