import { z } from 'zod';

// ── Public utilities ──────────────────────────────────────────────────────────

export function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Internal helpers (private – used only inside this module) ─────────────────

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkObjects(root: unknown, visitor: (value: Record<string, unknown>) => void): void {
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isRecord(value)) {
      visitor(value);
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(root);
}

function asObject(value: unknown): JsonObject | null {
  return isRecord(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function getPath(root: unknown, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const o = asObject(current);
    if (!o || !(key in o)) return undefined;
    current = o[key];
  }
  return current;
}

function firstString(root: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const v = readString(getPath(root, ...path));
    if (v) return v;
  }
  return null;
}

function firstObject(root: unknown, paths: string[][]): JsonObject | null {
  for (const path of paths) {
    const v = asObject(getPath(root, ...path));
    if (v) return v;
  }
  return null;
}

function firstArray(root: unknown, paths: string[][]): unknown[] {
  for (const path of paths) {
    const v = getPath(root, ...path);
    if (Array.isArray(v)) return v;
  }
  return [];
}

function normalizeStringArray(values: unknown[]): string[] {
  return values.map(readString).filter((v): v is string => Boolean(v));
}

// ── Internal schema helpers ───────────────────────────────────────────────────

// Explicit annotation on r threads z.infer<S> through the safeParse return type
// so TypeScript resolves r.data as the schema's output type without any assertion.
function _parseItems<S extends z.ZodTypeAny>(schema: S, raw: unknown): Array<z.infer<S>> {
  return asArray(raw).flatMap((item) => {
    const r: z.SafeParseReturnType<z.input<S>, z.infer<S>> = schema.safeParse(item);
    return r.success ? [r.data] : [];
  });
}

// ── Token Table System Schemas ────────────────────────────────────────────────
//
// .catch('') / .catch([]) / .catch({}) on zod primitives produces a clean
// TypeScript output type (string / string[] / Record) without the index-
// signature `{ [k: string]: unknown }` that .passthrough() would inject.

const TokenItemSchema = z.object({
  name: z.string().trim().min(1),
  tokenName: z.string().catch(''),
  displayName: z.string().catch(''),
  tokenValueType: z.string().catch(''),
  state: z.string().catch(''),
});
export type DecodedTokenItem = z.infer<typeof TokenItemSchema>;

const TokenSetItemSchema = z.object({
  name: z.string().trim().min(1),
  displayName: z.string().catch(''),
  tokenSetName: z.string().catch(''),
});
export type DecodedTokenSetItem = z.infer<typeof TokenSetItemSchema>;

const TagItemSchema = z.object({
  name: z.string().catch(''),
  displayName: z.string().catch(''),
  tagName: z.string().catch(''),
});
export type DecodedTagItem = z.infer<typeof TagItemSchema>;

const ContextTagGroupItemSchema = z.object({
  name: z.string().catch(''),
  displayName: z.string().catch(''),
  defaultTag: z.string().catch(''),
});
export type DecodedContextTagGroupItem = z.infer<typeof ContextTagGroupItemSchema>;

// Recursive reference node — explicit interface so the recursive type is clean.
export type DecodedReferenceNode = {
  tokenName: string;
  childNodes: DecodedReferenceNode[];
};

// z.ZodType<Output> without the Input param avoids the _input mismatch that
// z.lazy generates when the wrapping schema has _input: unknown.
const ReferenceNodeSchema: z.ZodType<DecodedReferenceNode> = z.lazy(() =>
  z.object({
    tokenName: z.string().catch(''),
    childNodes: z.array(z.lazy(() => ReferenceNodeSchema)).catch([]),
  }).catch({ tokenName: '', childNodes: [] })
) as z.ZodType<DecodedReferenceNode>;

const ContextTreeEntrySchema = z.object({
  contextTags: z.array(z.string()).catch([]),
  referenceTree: (ReferenceNodeSchema as z.ZodType<DecodedReferenceNode>).catch({ tokenName: '', childNodes: [] }),
  resolvedValue: z.record(z.unknown()).catch({}),
});
export type DecodedContextTreeEntry = z.infer<typeof ContextTreeEntrySchema>;

const ContextTreeItemSchema = z.object({
  contextualReferenceTree: z.array(
    ContextTreeEntrySchema.catch({ contextTags: [], referenceTree: { tokenName: '', childNodes: [] }, resolvedValue: {} })
  ).catch([]),
});

const ContextualReferenceTreesSchema = z.unknown().transform(
  (raw): Record<string, { contextualReferenceTree: DecodedContextTreeEntry[] } | undefined> => {
    const o = asObject(raw);
    if (!o) return {};
    const result: Record<string, { contextualReferenceTree: DecodedContextTreeEntry[] } | undefined> = {};
    for (const [key, value] of Object.entries(o)) {
      const parsed = ContextTreeItemSchema.safeParse(value);
      result[key] = parsed.success ? parsed.data : undefined;
    }
    return result;
  }
);

export const TokenTableSystemSchema = z.object({
  tokens: z.unknown().transform((raw) => _parseItems(TokenItemSchema, raw)),
  tokenSets: z.unknown().transform((raw) => _parseItems(TokenSetItemSchema, raw)),
  tags: z.unknown().transform((raw) => _parseItems(TagItemSchema, raw)),
  contextTagGroups: z.unknown().transform((raw) => _parseItems(ContextTagGroupItemSchema, raw)),
  contextualReferenceTrees: ContextualReferenceTreesSchema,
});

export type DecodedTokenTableSystem = z.infer<typeof TokenTableSystemSchema>;

export function parseTokenTableSystem(raw: unknown): DecodedTokenTableSystem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = TokenTableSystemSchema.safeParse(raw);
  if (!result.success) return null;
  const system = result.data;
  if (system.tokens.length === 0 && system.tokenSets.length === 0) return null;
  return system;
}

// ── Status Table Schemas ──────────────────────────────────────────────────────

const DecodedStatusTableSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});
export type DecodedStatusTable = z.infer<typeof DecodedStatusTableSchema>;

function _statusHeaders(resource: unknown): string[] {
  const o = asObject(resource);
  if (!o) return [];
  const direct = Array.isArray(o.headers) ? o.headers : Array.isArray(o.columns) ? o.columns : null;
  if (direct) {
    return direct
      .map((v) => {
        if (typeof v === 'string') return v;
        if (isRecord(v)) return String(v.label ?? '');
        return '';
      })
      .filter(Boolean);
  }
  const payload = o.payload;
  if (payload && typeof payload === 'object') return _statusHeaders(payload);
  return [];
}

function _statusRows(resource: unknown): string[][] {
  const o = asObject(resource);
  if (!o) return [];
  const rawRows = Array.isArray(o.rows) ? o.rows : Array.isArray(o.statuses) ? o.statuses : null;
  if (rawRows) {
    return rawRows
      .map((row) => {
        if (Array.isArray(row)) return row.map((v) => (typeof v === 'string' ? v : _stableStringify(v)));
        if (isRecord(row)) {
          return Object.values(row).map((v) => (typeof v === 'string' ? v : _stableStringify(v)));
        }
        return [String(row ?? '')];
      })
      .filter((row) => row.some(Boolean));
  }
  const payload = o.payload;
  if (payload && typeof payload === 'object') return _statusRows(payload);
  return [];
}

function _connectionStatusLabel(status: string): string {
  if (!status) return status;
  return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
}

/**
 * The live DSDB "component" resource (e.g. `designSystems/<id>/components/<id>`) is a component
 * availability matrix, not a generic headers/rows table: { connections: [{ displayName,
 * resourceType, status, resourceUrl, orderInComponent }] }. Each connection becomes one
 * Platform/Status row, sorted by `orderInComponent` (DSDB's own display order) and linked to
 * `resourceUrl` when present — this is the real schema returned by m3.material.io's STATUS_TABLE
 * chunks, distinct from the {headers, rows}/{columns, statuses} shapes handled above.
 */
function _connectionsToHeadersRows(resource: unknown): { headers: string[]; rows: string[][] } | null {
  const o = asObject(resource);
  if (!o) return null;
  const connections = Array.isArray(o.connections) ? o.connections
    : isRecord(o.payload) && Array.isArray(o.payload.connections) ? o.payload.connections
    : null;
  if (!connections) return null;

  const ranked: { order: number; row: string[] }[] = [];
  for (const entry of connections) {
    if (!isRecord(entry)) continue;
    const displayName = typeof entry.displayName === 'string' ? entry.displayName : null;
    const status = typeof entry.status === 'string' ? entry.status : null;
    if (!displayName || !status) continue;
    const resourceUrl = typeof entry.resourceUrl === 'string' ? entry.resourceUrl : null;
    const label = resourceUrl ? `[${displayName}](${resourceUrl})` : displayName;
    const order = typeof entry.orderInComponent === 'number' ? entry.orderInComponent : Number.MAX_SAFE_INTEGER;
    ranked.push({ order, row: [label, _connectionStatusLabel(status)] });
  }
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => a.order - b.order);
  return { headers: ['Platform', 'Status'], rows: ranked.map((entry) => entry.row) };
}

function _stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((e) => _stableStringify(e)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${_stableStringify(value[k])}`).join(',')}}`;
  }
  return '{}';
}

export function parseStatusTable(resource: unknown): DecodedStatusTable | null {
  const fromConnections = _connectionsToHeadersRows(resource);
  if (fromConnections) {
    const result = DecodedStatusTableSchema.safeParse(fromConnections);
    if (result.success) return result.data;
  }
  const headers = _statusHeaders(resource);
  const rows = _statusRows(resource);
  if (headers.length === 0 || rows.length === 0) return null;
  const result = DecodedStatusTableSchema.safeParse({ headers, rows });
  return result.success ? result.data : null;
}

export type UnsupportedStatusTable = {
  readonly _unsupported: true;
};

export function decodeStatusTableResource(raw: unknown): DecodedStatusTable | UnsupportedStatusTable {
  const decoded = parseStatusTable(raw);
  if (!decoded) return { _unsupported: true };
  return decoded;
}

// ── Content Page Schemas ──────────────────────────────────────────────────────

export const ContentChunkSchema = z.object({
  contentChunkType: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  // TEXT chunk fields
  htmlValue: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  value: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  // IMAGE chunk fields
  imageUrl: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  src: z.string().nullable().optional(),
  altText: z.string().nullable().optional(),
  alt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  footer: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  captionText: z.string().nullable().optional(),
  // VIDEO chunk fields
  videoUrl: z.string().nullable().optional(),
  embedUrl: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  // RESOURCE chunk fields
  libraryModuleType: z.string().nullable().optional(),
  moduleType: z.string().nullable().optional(),
  resourceType: z.string().nullable().optional(),
  resourceName: z.string().nullable().optional(),
  resourcePath: z.string().nullable().optional(),
  resourceUrl: z.string().nullable().optional(),
  moduleConfigurationOverrides: z.unknown().optional(),
  moduleConfiguration: z.unknown().optional(),
  tokenSets: z.unknown().optional(),
}).passthrough();
export type DecodedContentChunk = z.infer<typeof ContentChunkSchema>;

export type DecodedContentBlock = {
  title: string | null;
  chunks: DecodedContentChunk[];
};

export type DecodedContentSection = {
  title: string;
  blocks: DecodedContentBlock[];
};

function _parseBlock(raw: unknown): DecodedContentBlock | null {
  const block = asObject(raw);
  if (!block) return null;
  if (readBoolean(block.isHidden) === true || readBoolean(block.hidden) === true) return null;
  const rawChunks = firstArray(block, [['contentChunks'], ['chunks'], ['content'], ['items']]);
  const chunks: DecodedContentChunk[] = rawChunks.flatMap((rawChunk) => {
    const r = ContentChunkSchema.safeParse(rawChunk);
    return r.success ? [r.data] : [];
  });
  return {
    title: readString(block.title) ?? readString(block.name) ?? readString(block.heading) ?? null,
    chunks,
  };
}

function _parseSection(raw: unknown): DecodedContentSection | null {
  const section = asObject(raw);
  if (!section) return null;
  if (readBoolean(section.isVisible) === false || readBoolean(section.visible) === false) return null;
  const rawBlocks = firstArray(section, [['contentBlocks'], ['blocks'], ['content'], ['items']]);
  const blocks: DecodedContentBlock[] = rawBlocks.flatMap((rawBlock) => {
    const b = _parseBlock(rawBlock);
    return b !== null ? [b] : [];
  });
  return {
    title: readString(section.name) ?? readString(section.title) ?? readString(section.heading) ?? 'Section',
    blocks,
  };
}

function _isSectionLike(value: unknown): boolean {
  const o = asObject(value);
  if (!o) return false;
  return (
    Array.isArray(o.contentBlocks) ||
    Array.isArray(o.blocks) ||
    Array.isArray(o.contentChunks) ||
    Array.isArray(o.chunks)
  );
}

function _parseSections(raw: unknown): DecodedContentSection[] {
  const directSections = firstArray(raw, [
    ['sections'],
    ['content', 'sections'],
    ['page', 'sections'],
    ['data', 'sections'],
  ]);
  if (directSections.length > 0) {
    return directSections.flatMap((s) => {
      const sec = _parseSection(s);
      return sec !== null ? [sec] : [];
    });
  }

  const discovered: DecodedContentSection[] = [];
  walkObjects(raw, (value) => {
    if (discovered.length > 0) return;
    const maybeSections = Object.values(value).find(
      (entry) => Array.isArray(entry) && entry.some((item) => _isSectionLike(item))
    );
    if (Array.isArray(maybeSections)) {
      for (const s of maybeSections) {
        const sec = _parseSection(s);
        if (sec !== null) discovered.push(sec);
      }
    }
  });
  return discovered;
}

export type DecodedContentPage = {
  title: string | null;
  /** First available top-level HTML text field for pages with no structured sections. */
  fallbackHtml: string | null;
  sections: DecodedContentSection[];
};

export function parseContentPage(raw: unknown): DecodedContentPage {
  return {
    title: firstString(raw, [['title'], ['name']]),
    fallbackHtml: firstString(raw, [['htmlValue'], ['body'], ['description']]),
    sections: _parseSections(raw),
  };
}

// ── Resource Chunk Schema ─────────────────────────────────────────────────────

export const ResourceChunkSchema = z
  .object({
    libraryModuleType: z.string().nullable().optional(),
    moduleType: z.string().nullable().optional(),
    resourceType: z.string().nullable().optional(),
    resourceName: z.string().nullable().optional(),
    resourcePath: z.string().nullable().optional(),
    resourceUrl: z.string().nullable().optional(),
    // Real DSDB RESOURCE chunks (e.g. STATUS_TABLE component-availability chunks on
    // /components/buttons, /components/lists, /components/switch) carry an explicit JSON `null`
    // here, not just an absent key — `.optional()` alone only accepts `undefined` and rejects
    // `null`, which previously made the whole chunk fail validation and silently skip the DSDB
    // fetch (decodeResourceChunk treated it as malformed, so fetchResource was never even called).
    moduleConfigurationOverrides: z
      .object({
        tokenSets: z.unknown().optional(),
        resourceName: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    moduleConfiguration: z
      .object({
        tokenSets: z.unknown().optional(),
        resourceName: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    tokenSets: z.unknown().optional(),
  })
  .passthrough();
export type DecodedResourceChunk = z.infer<typeof ResourceChunkSchema>;

export function extractRequestedTokenSetsFromChunk(chunk: DecodedResourceChunk): string[] {
  const candidates = [
    asArray(getPath(chunk.moduleConfigurationOverrides, 'tokenSets')),
    asArray(getPath(chunk.moduleConfiguration, 'tokenSets')),
    asArray(chunk.tokenSets),
  ];
  for (const arr of candidates) {
    const tokenSets = arr.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
    );
    if (tokenSets.length > 0) return tokenSets;
  }
  return [];
}

export function extractResourceNameFromChunk(chunk: DecodedResourceChunk): string | null {
  const direct = [
    readString(chunk.resourceName),
    readString(chunk.resourcePath),
    readString(chunk.resourceUrl),
    readString(getPath(chunk.moduleConfigurationOverrides, 'resourceName')),
    readString(getPath(chunk.moduleConfiguration, 'resourceName')),
  ].find(Boolean);
  if (direct) return direct ?? null;

  let discovered: string | null = null;
  walkObjects(chunk, (value) => {
    if (discovered) return;
    for (const candidate of Object.values(value)) {
      if (typeof candidate === 'string' && candidate.includes('TOKEN_TABLE')) {
        discovered = candidate;
        return;
      }
    }
  });
  return discovered;
}
