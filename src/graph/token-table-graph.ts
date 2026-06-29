import type { DecodedContextTreeEntry, DecodedReferenceNode, DecodedTokenTableSystem } from '../json-extraction/schemas.js';
import {
  TokenTableGraphSchema,
  type TokenSetNode,
  type TokenTableGraph,
  type TokenTableNode,
  type TokenValueEntry,
  type TokenValueRole,
} from './graph-types.js';

/**
 * Builds structured token-table graph nodes directly from a `DecodedTokenTableSystem` (the same
 * decoded shape `render-markdown.ts`'s `renderTokenTableWithDiagnostics` consumes — see
 * src/json-extraction/schemas.ts's `parseTokenTableSystem` / `TokenTableSystemSchema`).
 *
 * Unlike page-graph.ts/resource-graph.ts (which reconstruct from post-hoc diagnostic counters
 * because the raw decoded system is discarded after rendering), this builder is designed to be
 * called *at the point of decode*, before rendering throws the structured data away — i.e.
 * `extract-dsdb-resource.ts`'s `renderDsdbResourceChunk` would call this alongside (or instead
 * of) `renderTokenTableWithDiagnostics` once stage 5 wires the renderer to read from the graph.
 * It is exposed here as a pure function (system, requestedTokenSets) -> TokenTableNode so it can
 * be unit tested against fixtures without needing a live crawl.
 *
 * Per the task spec, this must expose real token name/value/role fields (not opaque markdown
 * blobs) so an MCP tool can return exact token names/values without parsing Markdown.
 */

type TagIndex = Map<string, string>;

function buildTagIndex(system: DecodedTokenTableSystem): TagIndex {
  const idByTagName = new Map<string, string>();
  for (const tag of system.tags) idByTagName.set(tag.tagName, tag.name);
  return idByTagName;
}

type ContextSelector = { theme: 'light' | 'dark'; contrast: 'default' | 'high.contrast' };

const ROLE_SELECTORS: Array<{ role: TokenValueRole; selector: ContextSelector }> = [
  { role: 'light', selector: { theme: 'light', contrast: 'default' } },
  { role: 'dark', selector: { theme: 'dark', contrast: 'default' } },
  { role: 'light-high-contrast', selector: { theme: 'light', contrast: 'high.contrast' } },
  { role: 'dark-high-contrast', selector: { theme: 'dark', contrast: 'high.contrast' } },
];

function findContextEntry(
  entries: DecodedContextTreeEntry[],
  idx: TagIndex,
  selector: ContextSelector,
  audience = '3p'
): DecodedContextTreeEntry | undefined {
  const themeId = idx.get(selector.theme);
  const antiThemeId = idx.get(selector.theme === 'light' ? 'dark' : 'light');
  const audienceId = idx.get(audience);
  const contrastId = idx.get(selector.contrast);
  const mediumId = idx.get('medium.contrast');
  const highId = idx.get('high.contrast');
  const elevatedId = idx.get('elevated');
  const nonAndroidPlatforms = [idx.get('ios'), idx.get('web'), idx.get('compose')].filter((v): v is string => Boolean(v));

  const candidates = entries.filter((entry) => {
    if (entry.resolvedValue['undefined'] === true) return false;
    const tags = entry.contextTags;
    if (!tags) return selector.contrast !== 'high.contrast';
    if (elevatedId && tags.includes(elevatedId)) return false;
    if (tags.some((t) => nonAndroidPlatforms.includes(t))) return false;
    const hasThemeTag = (themeId != null && tags.includes(themeId)) || (antiThemeId != null && tags.includes(antiThemeId));
    if (hasThemeTag) {
      if (themeId && !tags.includes(themeId)) return false;
      if (antiThemeId && tags.includes(antiThemeId)) return false;
    }
    if (selector.contrast === 'high.contrast') {
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
    const score = (entry: DecodedContextTreeEntry): number => {
      const tags = entry.contextTags;
      if (!tags) return -1;
      let s = 0;
      if (themeId && tags.includes(themeId)) s += 8;
      if (audienceId && tags.includes(audienceId)) s += 4;
      if (contrastId && tags.includes(contrastId)) s += 1;
      return s;
    };
    return score(b) - score(a);
  })[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValueNode(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(formatValueNode).filter(Boolean).join(', ');
  if (!isRecord(value)) return '';

  if ('red' in value && 'green' in value && 'blue' in value) {
    const red = Number(value['red']);
    const green = Number(value['green']);
    const blue = Number(value['blue']);
    const alpha = value['alpha'] != null ? Number(value['alpha']) : 1;
    if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) return '';
    if (Number.isFinite(alpha) && alpha < 0.9999) {
      return `rgba(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)}, ${alpha.toFixed(2)})`;
    }
    return `#${Math.round(red * 255).toString(16).padStart(2, '0')}${Math.round(green * 255).toString(16).padStart(2, '0')}${Math.round(blue * 255).toString(16).padStart(2, '0')}`;
  }
  if (typeof value['unit'] === 'string' && typeof value['value'] === 'number') {
    const unitName = value['unit'];
    const unit = unitName === 'DIPS' ? 'dp' : unitName === 'POINTS' || unitName === 'SP' ? 'sp' : unitName.toLowerCase();
    return `${value['value']}${unit}`;
  }
  return '';
}

function formatResolvedValue(resolvedValue: Record<string, unknown>): string | null {
  if (!resolvedValue || resolvedValue['undefined'] === true) return null;
  const formatted = Object.entries(resolvedValue)
    .filter(([key]) => key !== 'undefined')
    .map(([, value]) => formatValueNode(value))
    .filter(Boolean)
    .join(' ');
  return formatted || null;
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

function buildTokenValues(
  entries: DecodedContextTreeEntry[],
  idx: TagIndex
): { values: TokenValueEntry[]; aliases: string[]; unresolved: boolean } {
  const values: TokenValueEntry[] = [];
  let aliases: string[] = [];
  let unresolved = false;

  for (const { role, selector } of ROLE_SELECTORS) {
    const entry = findContextEntry(entries, idx, selector, '3p')
      ?? findContextEntry(entries, idx, selector, '1p.baseline')
      ?? findContextEntry(entries, idx, selector);
    if (!entry) {
      if (selector.contrast === 'default') {
        values.push({ role, value: null, resolved: false });
        unresolved = true;
      }
      continue;
    }
    const value = formatResolvedValue(entry.resolvedValue);
    values.push({ role, value, resolved: value !== null });
    if (value === null && selector.contrast === 'default') unresolved = true;
    if (aliases.length === 0) aliases = extractAliasChain(entry.referenceTree, '');
  }

  return { values, aliases, unresolved };
}

function matchesTokenSet(tokenSet: DecodedTokenTableSystem['tokenSets'][number], requested: string[]): boolean {
  if (requested.length === 0) return true;
  return requested.includes(tokenSet.displayName) || requested.includes(tokenSet.tokenSetName);
}

export function buildTokenTableNode(params: {
  resourceId: string;
  resourceName: string | null;
  system: DecodedTokenTableSystem;
  requestedTokenSets: string[];
  routes?: string[];
}): TokenTableNode {
  const idx = buildTagIndex(params.system);
  const relevantSets = params.system.tokenSets.filter((tokenSet) => matchesTokenSet(tokenSet, params.requestedTokenSets));

  let unresolvedTokenCount = 0;
  const tokenSets: TokenSetNode[] = relevantSets.map((tokenSet) => {
    const tokens = params.system.tokens.filter((token) => token.name.startsWith(tokenSet.name) && token.state === 'ACTIVE');
    const tokenNodes = tokens.map((token) => {
      const treeData = params.system.contextualReferenceTrees[token.name];
      const entries = treeData?.contextualReferenceTree ?? [];
      const { values, aliases, unresolved } = buildTokenValues(entries, idx);
      if (unresolved) unresolvedTokenCount += 1;
      return {
        tokenName: token.tokenName,
        displayName: token.displayName,
        aliases,
        values,
      };
    });
    return {
      tokenSetName: tokenSet.tokenSetName,
      displayName: tokenSet.displayName,
      tokens: tokenNodes,
    };
  });

  return {
    resourceId: params.resourceId,
    resourceName: params.resourceName,
    requestedTokenSets: params.requestedTokenSets,
    tokenSets,
    routes: params.routes ?? [],
    unresolvedTokenCount,
  };
}

export type BuildTokenTableGraphInput = {
  generatedAt?: string;
  tokenTables: TokenTableNode[];
};

export function buildTokenTableGraph(input: BuildTokenTableGraphInput): TokenTableGraph {
  const graph: TokenTableGraph = {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    tokenTables: input.tokenTables,
  };
  const parsed = TokenTableGraphSchema.safeParse(graph);
  if (!parsed.success) {
    throw new Error(`Failed to build a valid token table graph: ${parsed.error.message}`);
  }
  return parsed.data;
}
