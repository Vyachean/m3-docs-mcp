import TurndownService from 'turndown';
import { materialPageId, materialPagePath, sectionFromPagePath } from '../crawler-utils.js';
import type { MaterialPage, TokenContextDiagnostic } from '../types.js';
import type { DecodedContentSection } from './schemas.js';
import {
  compactJson,
  parseTokenTableSystem,
  type DecodedContextTreeEntry,
  type DecodedReferenceNode,
  type DecodedStatusTable,
  type DecodedTokenTableSystem,
} from './schemas.js';

// Backwards-compatible alias for consumers that previously imported from here
export type TokenTableSystem = DecodedTokenTableSystem;

const MIN_EMBEDDED_IMAGE_WIDTH = 800;
const PREFERRED_EMBEDDED_IMAGE_WIDTH = 1600;
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
  /folderenabled/i,
  /^visibility$/i,
  /^expand_all$/i,
  /^folder$/i
];
const TOKEN_VIEWER_ROW_SELECTORS = [
  'tr',
  '[role="row"]',
  '[class*="token-row"]',
  '[class*="tokenRow"]',
  '[class*="table-row"]',
  '[class*="row"]',
  'token'
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

type TagIndex = {
  idByTagName: Map<string, string>;
};

export function extractMaterialPageFromHtml(
  html: string,
  url: string,
  capturedAt = new Date().toISOString(),
  metadata?: Partial<Pick<MaterialPage, 'title' | 'headings'>>,
  tokenSystem?: DecodedTokenTableSystem
): MaterialPage {
  const relPath = materialPagePath(url);
  const sanitizedHtml = preserveBackgroundImageAttributes(preserveTokenViewerTextLines(stripUnsafeHtml(html)));
  const title = metadata?.title?.trim() || titleFromHtml(sanitizedHtml) || 'Material 3 page';
  const headings = metadata?.headings?.map((heading) => heading.trim()).filter(Boolean) ?? headingsFromHtml(sanitizedHtml);
  const body = renderHtmlToMarkdown(sanitizedHtml, tokenSystem);
  return createMaterialPageFromBody({ url, capturedAt, title, headings, body });
}

export function createMaterialPageFromBody({
  url,
  capturedAt = new Date().toISOString(),
  title,
  headings = [],
  body
}: {
  url: string;
  capturedAt?: string;
  title: string;
  headings?: string[];
  body: string;
}): MaterialPage {
  const relPath = materialPagePath(url);
  const normalizedBody = body.trim();
  const text = stripMarkdown(normalizedBody).replace(/\s+/g, ' ').trim();
  const markdown = `---\ntitle: ${JSON.stringify(title)}\nsourceUrl: ${url}\nsection: ${sectionFromPagePath(relPath)}\ncapturedAt: ${capturedAt}\n---\n\n${normalizedBody}\n`;
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

export function renderHtmlToMarkdown(html: string, tokenSystem?: DecodedTokenTableSystem): string {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  addMaterialMarkdownRules(turndown, tokenSystem);
  const rawBody = turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
  return postProcessMarkdown(rawBody);
}

export function renderImageMarkdown(imageUrl: string | null | undefined, altText?: string | null, footer?: string | null): string {
  if (!imageUrl?.trim()) return '';
  const image = `![${escapeMarkdownAttribute(altText ?? '')}](${preferLargeImageUrl(imageUrl.trim())})`;
  const caption = footer?.trim() ? `\n\n${footer.trim()}` : '';
  return `${image}${caption}`;
}

export function renderVideoMarkdown({
  url,
  title,
  altText,
  footer
}: {
  url?: string | null;
  title?: string | null;
  altText?: string | null;
  footer?: string | null;
}): string {
  const label = [title, altText].find((value) => value && value.trim())?.trim() ?? 'Video';
  const lines = [
    url?.trim() ? `[Video: ${escapeMarkdownAttribute(label)}](${url.trim()})` : `Video: ${label}`
  ];
  if (footer?.trim()) lines.push(footer.trim());
  return lines.join('\n\n');
}

export function renderResourcePlaceholder(label: string, details: object): string {
  return [
    `> Material resource placeholder: ${label}`,
    `> ${escapeMarkdownListText(JSON.stringify(details))}`
  ].join('\n');
}

function resolveDisplayTokenSets(viewer: Element, tokenSystem: DecodedTokenTableSystem): string[] {
  const setsAttr = viewer.getAttribute('display-token-sets');
  if (setsAttr) {
    try {
      const parsed: unknown = JSON.parse(setsAttr);
      if (Array.isArray(parsed)) {
        const sets = parsed.filter((s): s is string => typeof s === 'string');
        if (sets.length > 0) return sets;
      }
    } catch {
      // ignore
    }
  }

  const knownNames = new Set([
    ...tokenSystem.tokenSets.map((ts) => ts.displayName),
    ...tokenSystem.tokenSets.map((ts) => ts.tokenSetName)
  ]);
  const discovered: string[] = [];
  for (const btn of Array.from(viewer.querySelectorAll('button'))) {
    const candidate = normalizeInlineText(btn.textContent ?? '')
      .split(/\s+/)
      .filter((word) => !isTokenViewerNoise(word))
      .join(' ')
      .trim();
    if (candidate && knownNames.has(candidate) && !discovered.includes(candidate)) discovered.push(candidate);
  }
  return discovered;
}

function addMaterialMarkdownRules(turndown: TurndownService, tokenSystem?: DecodedTokenTableSystem): void {
  turndown.addRule('materialTables', {
    filter: (node) => isElementNode(node) && nodeName(node) === 'table',
    replacement: (_content, node) => tableElementToMarkdown(turndown, node as Element)
  });

  turndown.addRule('materialTokenViewer', {
    filter: (node) => isElementNode(node) && nodeName(node) === 'token-viewer',
    replacement: (_content, node) => {
      if (!isElementNode(node)) return '';
      if (tokenSystem) {
        const displayTokenSets = resolveDisplayTokenSets(node as Element, tokenSystem);
        if (displayTokenSets.length > 0) {
          const full = tokenTableToMarkdown(tokenSystem, displayTokenSets);
          return full.replace(/^\n*## Design Tokens\n\n/, '\n\n');
        }
      }
      return tokenViewerElementToMarkdown(turndown, node as Element);
    }
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
  const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table);
  const markdownRows = rows.map((row) => cellsFromRow(turndown, row)).filter((cells) => cells.some(Boolean));
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

  if (rows.length > 0) {
    const isTokenElementRows = rowCandidates.length > 0 && nodeName(rowCandidates[0]) === 'token';
    if (isTokenElementRows) {
      const maxColumns = Math.max(...rows.map((r) => r.length));
      return tokenRowsToMarkdown([['Name', 'Token', 'Value'].slice(0, maxColumns), ...rows]);
    }
    return tokenRowsToMarkdown(rows);
  }

  if (viewer.querySelector('button')) return '';

  const lines = tokenViewerFallbackLines(viewer).filter((line) => !isTokenViewerNoise(line));
  if (lines.length >= 4 && lines.length % 2 === 0) {
    const pairs: string[][] = [];
    for (let i = 0; i < lines.length; i += 2) pairs.push([lines[i] ?? '', lines[i + 1] ?? '']);
    return markdownTable([['Name', 'Value'], ...pairs]);
  }
  return lines.length ? `\n\n${lines.map((line) => `- ${escapeMarkdownListText(line)}`).join('\n')}\n\n` : '';
}

function tokenViewerCellsFromRow(turndown: TurndownService, row: Element): string[] {
  if (nodeName(row) === 'token') {
    const displayName = normalizeInlineText(row.querySelector('.display-name__text')?.textContent ?? '');
    const tokenId = normalizeInlineText(row.querySelector('.text-value')?.textContent ?? '');
    const value = normalizeInlineText(row.querySelector('.token-value-container')?.textContent ?? '');
    return [displayName, tokenId, value].filter(Boolean);
  }

  const explicitCells = Array.from(row.querySelectorAll(TOKEN_VIEWER_CELL_SELECTORS))
    .filter((cell) => cell !== row && !hasAncestorMatching(cell, row, TOKEN_VIEWER_CELL_SELECTORS));
  if (explicitCells.length > 1) {
    return explicitCells
      .map((cell) => elementToTableCellMarkdown(turndown, cell))
      .filter((cell) => cell && !isTokenViewerNoise(cell));
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

export function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  if (width === 0) return '';

  const header = padRow(rows[0] ?? [], width).map((cell, index) => cell || `Column ${index + 1}`);
  const body = rows.slice(1).map((row) => padRow(row, width));
  return `\n\n${[
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n')}\n\n`;
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

function buildTagIndex(sys: DecodedTokenTableSystem): TagIndex {
  const idByTagName = new Map<string, string>();
  for (const tag of sys.tags) idByTagName.set(tag.tagName, tag.name);
  return { idByTagName };
}

function findContextEntry(
  entries: DecodedContextTreeEntry[],
  idx: TagIndex,
  theme: 'light' | 'dark',
  opts: { audience?: string; contrast?: string } = {}
): DecodedContextTreeEntry | undefined {
  const { audience = '3p', contrast = 'default' } = opts;
  const themeId = idx.idByTagName.get(theme);
  const antiThemeId = idx.idByTagName.get(theme === 'light' ? 'dark' : 'light');
  const androidId = idx.idByTagName.get('android');
  const audienceId = idx.idByTagName.get(audience);
  const contrastId = idx.idByTagName.get(contrast);
  const mediumId = idx.idByTagName.get('medium.contrast');
  const highId = idx.idByTagName.get('high.contrast');
  const iosId = idx.idByTagName.get('ios');
  const webId = idx.idByTagName.get('web');
  const composeId = idx.idByTagName.get('compose');
  const elevatedId = idx.idByTagName.get('elevated');
  const nonAndroidPlatforms = [iosId, webId, composeId].filter(Boolean) as string[];

  const candidates = entries.filter((entry) => {
    if (entry.resolvedValue['undefined'] === true) return false;
    const tags = entry.contextTags;
    if (!tags) return contrast !== 'high.contrast';
    if (elevatedId && tags.includes(elevatedId)) return false;
    if (tags.some((t) => nonAndroidPlatforms.includes(t))) return false;
    const hasThemeTag = (themeId != null && tags.includes(themeId)) || (antiThemeId != null && tags.includes(antiThemeId));
    if (hasThemeTag) {
      if (themeId && !tags.includes(themeId)) return false;
      if (antiThemeId && tags.includes(antiThemeId)) return false;
    }
    if (contrast === 'high.contrast') {
      if (mediumId && tags.includes(mediumId)) return false;
      if (!highId || !tags.includes(highId)) return false;
    } else {
      if (mediumId && tags.includes(mediumId)) return false;
      if (highId && tags.includes(highId)) return false;
    }
    return true;
  });

  if (candidates.length === 0) return undefined;

  return candidates.sort((a, b) => {
    const score = (e: DecodedContextTreeEntry) => {
      const t = e.contextTags;
      if (!t) return -1;
      let s = 0;
      if (themeId && t.includes(themeId)) s += 8;
      if (audienceId && t.includes(audienceId)) s += 4;
      if (androidId && t.includes(androidId)) s += 2;
      if (contrastId && t.includes(contrastId)) s += 1;
      return s;
    };
    return score(b) - score(a);
  })[0];
}

function normalizeUnit(unit: string): string {
  if (unit === 'DIPS') return 'dp';
  if (unit === 'POINTS' || unit === 'SP') return 'sp';
  return unit.toLowerCase();
}

function isNonArrayObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function formatUnknownStructuredValue(v: Record<string, unknown>): string {
  return stableStringify(v);
}

function formatValueNode(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(formatValueNode).filter(Boolean).join(', ');
  if (!isNonArrayObject(v)) return '';

  if ('red' in v && 'green' in v && 'blue' in v) {
    const red = Number(v.red);
    const green = Number(v.green);
    const blue = Number(v.blue);
    const alpha = v.alpha != null ? Number(v.alpha) : 1;
    if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) return '';
    if (Number.isFinite(alpha) && alpha < 0.9999) {
      return `rgba(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)}, ${alpha.toFixed(2)})`;
    }
    return `#${Math.round(red * 255).toString(16).padStart(2, '0')}${Math.round(green * 255).toString(16).padStart(2, '0')}${Math.round(blue * 255).toString(16).padStart(2, '0')}`;
  }
  if ('unit' in v && typeof v.unit === 'string') {
    if (typeof v.value !== 'number') return '';
    return `${v.value}${normalizeUnit(v.unit)}`;
  }
  if ('values' in v && Array.isArray(v.values)) return v.values.map(formatValueNode).filter(Boolean).join(', ');
  if ('family' in v || 'defaultSize' in v || 'corners' in v) {
    const parts = [
      typeof v.family === 'string' ? v.family : '',
      v.defaultSize ? formatValueNode(v.defaultSize) : '',
      Array.isArray(v.corners) ? v.corners.map(formatValueNode).filter(Boolean).join(', ') : ''
    ].filter(Boolean);
    return parts.join(' ');
  }
  if ('fontNames' in v || 'fontWeight' in v || 'fontSize' in v || 'lineHeight' in v) {
    const parts = [
      v.fontNames ? formatValueNode(v.fontNames) : '',
      typeof v.fontWeight === 'number' ? String(v.fontWeight) : '',
      v.fontSize ? formatValueNode(v.fontSize) : '',
      v.lineHeight ? formatValueNode(v.lineHeight) : ''
    ].filter(Boolean);
    return parts.join(' ');
  }
  return formatUnknownStructuredValue(v);
}

function formatFontTrackingValue(value: unknown): string {
  if (!isNonArrayObject(value) || typeof value.unit !== 'string') return '';
  if (!Object.keys(value).every((key) => key === 'unit' || key === 'value')) return '';
  if (value.value != null && (typeof value.value !== 'number' || !Number.isFinite(value.value))) return '';
  const numericValue = value.value == null ? 0 : value.value;
  return `${numericValue}${normalizeUnit(value.unit)}`;
}

function formatResolvedValue(rv: Record<string, unknown>, tokenValueType: string): string {
  if (!rv || rv['undefined'] === true) return '';
  const formatted = Object.entries(rv)
    .filter(([key]) => key !== 'undefined')
    .map(([key, value]) => tokenValueType === 'FONT_TRACKING' && key === 'fontTracking'
      ? formatFontTrackingValue(value)
      : formatValueNode(value))
    .filter(Boolean)
    .join(' ');
  return formatted || '[unresolved]';
}

function extractAliasChain(tree: DecodedReferenceNode, selfTokenName: string): string[] {
  const aliases: string[] = [];
  let node: DecodedReferenceNode | undefined = (tree.childNodes ?? [])[0];
  while (node) {
    if (node.tokenName && node.tokenName !== selfTokenName) aliases.push(node.tokenName);
    node = (node.childNodes ?? [])[0];
  }
  return aliases;
}

export function extractDisplayTokenSets(html: string): string[] {
  const match = html.match(/display-token-sets="([^"]+)"/i);
  if (!match) return [];
  try {
    const sets: unknown = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    return Array.isArray(sets) ? sets.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function renderTokenTableWithDiagnostics(
  system: DecodedTokenTableSystem,
  displayTokenSets: string[]
): { markdown: string; diagnostics: TokenContextDiagnostic[] } {
  const idx = buildTagIndex(system);
  const requestedDisplayTokenSets = displayTokenSets.filter((value) => value.trim().length > 0);
  const displaySetNames = new Set(requestedDisplayTokenSets);
  const relevantSets = requestedDisplayTokenSets.length === 0
    ? system.tokenSets
    : system.tokenSets.filter((ts) => displaySetNames.has(ts.displayName) || displaySetNames.has(ts.tokenSetName));
  if (relevantSets.length === 0) {
    return { markdown: '', diagnostics: [] };
  }

  const sections: string[] = [];
  const diagnostics: TokenContextDiagnostic[] = [];
  for (const ts of relevantSets) {
    const tokens = system.tokens.filter((t) => t.name.startsWith(ts.name) && t.state === 'ACTIVE');
    if (tokens.length === 0) continue;
    const rows: string[][] = [['Token', 'Name', 'sys alias', 'ref alias', 'Light', 'Dark', 'Light (High contrast)', 'Dark (High contrast)']];
    const selectedContextKeys = new Set<string>();
    const availableContextKeys = new Set<string>();
    let unresolvedTokenCount = 0;
    let usedFallbackContext = false;
    let multipleContextVariantsAvailable = false;

    for (const token of tokens) {
      const treeData = system.contextualReferenceTrees[token.name];
      if (!treeData?.contextualReferenceTree?.length) continue;
      const entries = treeData.contextualReferenceTree;
      const entryContextKeys = entries.map((entry) => entry.contextTags.slice().sort().join('|')).filter(Boolean);
      for (const key of entryContextKeys) availableContextKeys.add(key);
      if (new Set(entryContextKeys).size > 1) multipleContextVariantsAvailable = true;
      const lightEntry = findContextEntry(entries, idx, 'light', { audience: '3p' }) ?? findContextEntry(entries, idx, 'light', { audience: '1p.baseline' }) ?? findContextEntry(entries, idx, 'light');
      const darkEntry = findContextEntry(entries, idx, 'dark', { audience: '3p' }) ?? findContextEntry(entries, idx, 'dark', { audience: '1p.baseline' }) ?? findContextEntry(entries, idx, 'dark');
      const lightHcEntry = findContextEntry(entries, idx, 'light', { audience: '3p', contrast: 'high.contrast' }) ?? findContextEntry(entries, idx, 'light', { contrast: 'high.contrast' });
      const darkHcEntry = findContextEntry(entries, idx, 'dark', { audience: '3p', contrast: 'high.contrast' }) ?? findContextEntry(entries, idx, 'dark', { contrast: 'high.contrast' });
      if (!lightEntry && !darkEntry) continue;
      if ((lightEntry && !entryMatchesContext(lightEntry, idx, { audience: '3p' })) || (darkEntry && !entryMatchesContext(darkEntry, idx, { audience: '3p' }))) {
        usedFallbackContext = true;
      }
      const activeEntry = lightEntry ?? darkEntry;
      const aliases = activeEntry ? extractAliasChain(activeEntry.referenceTree, token.tokenName) : [];
      const renderedValues = [
        lightEntry ? formatResolvedValue(lightEntry.resolvedValue, token.tokenValueType) : '[unresolved]',
        darkEntry ? formatResolvedValue(darkEntry.resolvedValue, token.tokenValueType) : '[unresolved]',
        lightHcEntry ? formatResolvedValue(lightHcEntry.resolvedValue, token.tokenValueType) : '',
        darkHcEntry ? formatResolvedValue(darkHcEntry.resolvedValue, token.tokenValueType) : ''
      ];
      if (renderedValues[0] === '[unresolved]' || renderedValues[1] === '[unresolved]') unresolvedTokenCount += 1;
      for (const entry of [lightEntry, darkEntry, lightHcEntry, darkHcEntry]) {
        const key = entry ? entry.contextTags.slice().sort().join('|') : '';
        if (key) selectedContextKeys.add(key);
      }
      rows.push([
        token.tokenName,
        token.displayName,
        aliases[0] ?? '',
        aliases[1] ?? '',
        ...renderedValues
      ]);
    }

    if (rows.length <= 1) continue;
    const hasHcData = rows.slice(1).some((row) => row[6] || row[7]);
    const finalRows = hasHcData ? rows : rows.map((row) => row.slice(0, 6));
    sections.push(`### ${ts.displayName}\n${markdownTable(finalRows)}`);
    const requestedTokenSetsForSection = requestedDisplayTokenSets.length === 0
      ? [ts.displayName || ts.tokenSetName].filter(Boolean)
      : requestedDisplayTokenSets.filter((name) => name === ts.displayName || name === ts.tokenSetName);
    const renderedTokenSets = [ts.displayName, ts.tokenSetName].filter((value, index, arr) => Boolean(value) && arr.indexOf(value) === index);
    const availableKeys = Array.from(availableContextKeys).sort();
    const selectedKeys = Array.from(selectedContextKeys).sort();
    diagnostics.push({
      resourceName: null,
      requestedTokenSets: requestedTokenSetsForSection,
      renderedTokenSets,
      selectedContextKeys: selectedKeys,
      skippedContextKeys: availableKeys.filter((key) => !selectedContextKeys.has(key)),
      availableContextKeys: availableKeys,
      unresolvedTokenCount,
      missingRequestedTokenSetCount: Math.max(0, requestedTokenSetsForSection.filter((name) => !renderedTokenSets.includes(name)).length),
      usedFallbackContext,
      multipleContextVariantsAvailable
    });
  }

  return {
    markdown: sections.length > 0 ? `\n\n## Design Tokens\n\n${sections.join('\n\n')}` : '',
    diagnostics
  };
}

export function tokenTableToMarkdown(system: DecodedTokenTableSystem, displayTokenSets: string[]): string {
  return renderTokenTableWithDiagnostics(system, displayTokenSets).markdown;
}

export function normalizeTokenTableSystem(raw: unknown): DecodedTokenTableSystem | null {
  return parseTokenTableSystem(raw);
}

export function renderStatusTableMarkdown(decoded: DecodedStatusTable): string {
  return markdownTable([decoded.headers, ...decoded.rows]);
}

export function renderDecodedSections(
  sections: DecodedContentSection[],
  renderChunk: (chunk: import('./schemas.js').DecodedContentChunk) => Promise<string>
): Promise<string[]> {
  const parts: Promise<string>[] = [];
  for (const section of sections) {
    if (section.title.trim()) parts.push(Promise.resolve(`## ${section.title.trim()}`));
    for (const block of section.blocks) {
      if (block.title?.trim()) parts.push(Promise.resolve(`### ${block.title.trim()}`));
      for (const chunk of block.chunks) {
        parts.push(renderChunk(chunk).then((r) => r.trim()));
      }
    }
  }
  return Promise.all(parts);
}

export function preferLargeImageUrl(url: string): string {
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
    if (/<button\b/i.test(body)) return match;
    const lines = visibleTextLines(stripHtml(body));
    if (lines.length <= 1) return match;
    return `<token-viewer${attributes}>${lines.map(escapeHtmlText).join('<br>')}</token-viewer>`;
  });
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function postProcessMarkdown(markdown: string): string {
  const lines = markdown
    .replace(/\r\n/g, '\n')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/​/g, '')
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
  return `${leadingWhitespace}${normalizeMarkdownImageUrls(content.replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' '))}`;
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
  return lines.filter((line, index, arr) => line || ((arr[index - 1] ?? '') !== '' && (arr[index + 1] ?? '') !== ''));
}

function normalizeNoiseText(value: string): string {
  return value.toLowerCase().replace(/[`*_~[\]()]|\\/g, '').replace(/\s+/g, ' ').trim();
}

export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\n{2,}/g, '\n');
}

function titleFromHtml(html: string): string {
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return stripHtml(titleMatch?.[1] ?? '').trim();
}

function headingsFromHtml(html: string): string[] {
  return Array.from(html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)).map((match) => stripHtml(match[1]).trim()).filter(Boolean);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
  return value.replace(/​/g, '').replace(/\s+/g, ' ').trim();
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

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (isNonArrayObject(value)) {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return '{}';
}

function entryMatchesContext(
  entry: DecodedContextTreeEntry,
  idx: TagIndex,
  expected: { audience?: string; contrast?: string }
): boolean {
  const contextNames = new Set(entry.contextTags.map((tag) => idx.idByTagName.get(tag) ?? tag));
  if (expected.audience && !contextNames.has(expected.audience)) return false;
  if (expected.contrast && !contextNames.has(expected.contrast)) return false;
  return true;
}
