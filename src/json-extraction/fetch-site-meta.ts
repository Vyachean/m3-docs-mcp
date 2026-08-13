import { z } from 'zod';
import { normalizeMaterialPublicDocPath } from '../crawler-utils.js';
import { createFetchDiagnostic, type FetchDiagnostic } from '../raw-artifacts/fetch-diagnostics.js';

// ── Zod schemas ───────────────────────────────────────────────────────────────

// document_id/collection_id/repo_id are observed as numbers in live data (e.g. 5909068158074880),
// not strings — accept either and normalize to string at the descriptor layer.
const SiteMetaIdSchema = z.union([z.string(), z.number()]).optional();

const SiteMetaReferenceSchema = z.object({
  collection_id: SiteMetaIdSchema,
  document_id: SiteMetaIdSchema,
  repo_id: SiteMetaIdSchema,
}).passthrough();

/**
 * Schema for the value of each entry in the site_meta.routes object map.
 * The route path is the key; this schema describes the value.
 */
export const SiteMetaRouteValueSchema = z.object({
  other_routes: z.array(z.string()).optional().default([]),
  public: z.boolean().optional(),
  redirect_external_url: z.string().nullable().optional(),
  reference: SiteMetaReferenceSchema.optional(),
}).passthrough();

/**
 * The real site_meta.routes shape is a map keyed by route path:
 *   { "/components/buttons/specs": { public: true, reference: { collection_id: "...", document_id: "..." } }, ... }
 */
export const SiteMetaSchema = z.object({
  routes: z.record(z.string(), SiteMetaRouteValueSchema),
}).passthrough();

/** @deprecated Use SiteMetaRouteValueSchema */
export const SiteMetaRouteSchema = SiteMetaRouteValueSchema;

export type SiteMetaRouteValue = z.infer<typeof SiteMetaRouteValueSchema>;
/** @deprecated Use SiteMetaRouteValue */
export type SiteMetaRoute = SiteMetaRouteValue;
export type SiteMeta = z.infer<typeof SiteMetaSchema>;

export type SiteMetaRouteDescriptor = {
  route: string;
  otherRoutes: string[];
  isPublic: boolean;
  redirectExternalUrl: string | null;
  collectionId: string | undefined;
  documentId: string | undefined;
  repoId: string | undefined;
};

/** Coerces a site_meta id field (string | number | undefined) to a normalized string, or undefined if missing/empty. */
function normalizeSiteMetaId(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim();
  return str.length > 0 ? str : undefined;
}

export type SiteMetaParseResult =
  | { ok: true; siteMeta: SiteMeta; routes: SiteMetaRouteDescriptor[]; publicCount: number; privateCount: number; redirectCount: number; aliasCount: number }
  | { ok: false; reason: string };

// ── Public API ────────────────────────────────────────────────────────────────

export class SiteMetaParseError extends Error {
  /** True when the JS was fetched and parsed but the schema/shape was wrong. */
  readonly isFormatError: boolean;
  constructor(message: string, options?: { isFormatError?: boolean; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'SiteMetaParseError';
    this.isFormatError = options?.isFormatError ?? false;
  }
}

type FetchLike = typeof fetch;

/**
 * Fetches the preferred rich navigation metadata from `/site_meta.js`.
 *
 * The Material site no longer guarantees that file exists. When it is unavailable or unusable,
 * the official `/sitemap.xml` is used as a deterministic public route-list fallback. The fallback
 * deliberately contains route identity only; collection/document ids still come from the Angular
 * bundle resolver in the crawler. `onRawText` is invoked only for a real `site_meta.js` response,
 * so raw-snapshot provenance never records sitemap bytes as a site-meta artifact.
 */
export async function fetchSiteMeta(
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
  diagnostics: FetchDiagnostic[] = [],
  onRawText?: (text: string, response: Response) => void
): Promise<SiteMeta> {
  let primaryError: SiteMetaParseError;
  try {
    return await fetchPrimarySiteMeta(baseUrl, signal, fetchImpl, diagnostics, onRawText);
  } catch (error) {
    if (signal?.aborted) throw error;
    primaryError = error instanceof SiteMetaParseError
      ? error
      : new SiteMetaParseError(error instanceof Error ? error.message : String(error), { cause: error });
  }

  try {
    return await fetchSitemapRouteFallback(baseUrl, signal, fetchImpl, diagnostics);
  } catch (fallbackError) {
    if (signal?.aborted) throw fallbackError;
    const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    throw new SiteMetaParseError(
      `${primaryError.message}; sitemap route fallback failed: ${fallbackMessage}`,
      { isFormatError: primaryError.isFormatError, cause: fallbackError }
    );
  }
}

async function fetchPrimarySiteMeta(
  baseUrl: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
  diagnostics: FetchDiagnostic[],
  onRawText?: (text: string, response: Response) => void
): Promise<SiteMeta> {
  const url = new URL('/site_meta.js', baseUrl).toString();
  let response: Response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (err) {
    const networkError = err instanceof Error ? err.message : String(err);
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'site-meta', outcome: 'network-error', networkError,
      reason: 'rejected: site_meta.js fetch threw a network error'
    }));
    throw new SiteMetaParseError(`site_meta.js fetch failed: ${networkError}`, { cause: err });
  }
  if (!response.ok) {
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'site-meta', httpStatus: response.status, outcome: 'http-error',
      reason: `rejected: site_meta.js fetch returned HTTP ${response.status}`
    }));
    throw new SiteMetaParseError(`site_meta.js fetch failed: HTTP ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  onRawText?.(text, response);
  try {
    const siteMeta = parseSiteMetaJs(text);
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'site-meta', httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null, outcome: 'success',
      reason: 'accepted: site_meta.js fetched and parsed'
    }));
    return siteMeta;
  } catch (err) {
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'site-meta', httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null, outcome: 'parse-error',
      parseError: err instanceof Error ? err.message : String(err),
      reason: 'rejected: site_meta.js fetched but could not be parsed/validated'
    }));
    throw err;
  }
}

async function fetchSitemapRouteFallback(
  baseUrl: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
  diagnostics: FetchDiagnostic[]
): Promise<SiteMeta> {
  const url = new URL('/sitemap.xml', baseUrl).toString();
  let response: Response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (err) {
    const networkError = err instanceof Error ? err.message : String(err);
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'sitemap', outcome: 'network-error', networkError,
      reason: 'rejected: sitemap.xml route fallback fetch threw a network error'
    }));
    throw new Error(`sitemap.xml fetch failed: ${networkError}`, { cause: err });
  }

  if (!response.ok) {
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'sitemap', httpStatus: response.status, outcome: 'http-error',
      reason: `rejected: sitemap.xml route fallback returned HTTP ${response.status}`
    }));
    throw new Error(`sitemap.xml fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const locValues = Array.from(text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi))
    .map((match) => decodeXmlText(match[1] ?? '').trim())
    .filter(Boolean);
  const routes: Record<string, SiteMetaRouteValue> = {};

  for (const value of locValues) {
    const route = normalizeMaterialPublicDocPath(value, baseUrl);
    if (!route) continue;
    routes[route] = {
      other_routes: [],
      public: true,
      redirect_external_url: null,
    };
  }

  if (Object.keys(routes).length === 0) {
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'sitemap', httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null, outcome: 'parse-error',
      parseError: 'sitemap.xml contained no usable same-origin public documentation routes',
      reason: 'rejected: sitemap.xml route fallback contained no usable public routes'
    }));
    throw new Error('sitemap.xml contained no usable same-origin public documentation routes');
  }

  diagnostics.push(createFetchDiagnostic({
    url, expectedKind: 'sitemap', httpStatus: response.status,
    contentType: response.headers?.get?.('content-type') ?? null, outcome: 'success',
    reason: `accepted: sitemap.xml supplied ${Object.keys(routes).length} deterministic public routes after site_meta.js was unavailable`
  }));

  return SiteMetaSchema.parse({ routes });
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * Parses /site_meta.js text and extracts the site_meta object.
 * Throws SiteMetaParseError if the shape is not recognized or validation fails.
 *
 * The real format uses routes as an object map keyed by route path:
 *   window.site_meta = { routes: { "/path": { public: true, reference: { ... } } } }
 */
export function parseSiteMetaJs(text: string): SiteMeta {
  const extracted = extractJsonObjectFromJs(text, 'site_meta');
  if (!extracted) {
    throw new SiteMetaParseError(
      'site_meta.js: window.site_meta assignment not found. ' +
      'If the site has changed its metadata format, update parseSiteMetaJs().'
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(extracted);
  } catch (err) {
    throw new SiteMetaParseError(
      `site_meta.js: JSON.parse failed on extracted object: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  const result = SiteMetaSchema.safeParse(raw);
  if (!result.success) {
    throw new SiteMetaParseError(
      `site_meta.js: schema validation failed — routes must be an object map keyed by route path. ` +
      `Zod error: ${result.error.message}. ` +
      'Update the schema if the site has changed its site_meta structure.',
      { isFormatError: true }
    );
  }

  if (Object.keys(result.data.routes).length === 0) {
    throw new SiteMetaParseError(
      'site_meta.js: parsed successfully but routes object is empty. ' +
      'This is unexpected and likely indicates a site structure change.',
      { isFormatError: true }
    );
  }

  return result.data;
}

/**
 * Converts raw site_meta routes (object map) into normalized descriptors.
 * Filters: public-only, excludes external redirects.
 * Deduplicates via other_routes aliasing.
 * Returns diagnostics alongside the filtered list.
 */
export function buildSiteMetaRouteDescriptors(siteMeta: SiteMeta): {
  routes: SiteMetaRouteDescriptor[];
  publicCount: number;
  privateCount: number;
  redirectCount: number;
  aliasCount: number;
} {
  let publicCount = 0;
  let privateCount = 0;
  let redirectCount = 0;
  let aliasCount = 0;

  const routes: SiteMetaRouteDescriptor[] = [];
  const seenRoutes = new Set<string>();

  for (const [routePath, raw] of Object.entries(siteMeta.routes)) {
    const isPublic = raw.public !== false;
    const hasExternalRedirect = Boolean(raw.redirect_external_url);

    if (!isPublic) {
      privateCount += 1;
      continue;
    }
    if (hasExternalRedirect) {
      redirectCount += 1;
      continue;
    }

    const canonicalRoute = routePath;
    if (seenRoutes.has(canonicalRoute)) continue;
    seenRoutes.add(canonicalRoute);

    publicCount += 1;
    const otherRoutes = (raw.other_routes ?? []).filter((r) => r !== canonicalRoute);
    aliasCount += otherRoutes.length;

    routes.push({
      route: canonicalRoute,
      otherRoutes,
      isPublic,
      redirectExternalUrl: raw.redirect_external_url ?? null,
      collectionId: normalizeSiteMetaId(raw.reference?.collection_id),
      documentId: normalizeSiteMetaId(raw.reference?.document_id),
      repoId: normalizeSiteMetaId(raw.reference?.repo_id),
    });
  }

  return { routes, publicCount, privateCount, redirectCount, aliasCount };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Finds an assignment like `window.X = {...}` or `X = {...}` in JavaScript text
 * and returns the balanced JSON object string, or null if not found.
 *
 * Handles:
 *   window.site_meta = {...}
 *   self.site_meta = {...}
 *   var site_meta = {...}
 *   site_meta = {...}
 */
function extractJsonObjectFromJs(text: string, varName: string): string | null {
  // Find the assignment. Allow any prefix (window., self., var , etc.)
  const assignmentRe = new RegExp(`\\b${varName}\\s*=\\s*`, 'g');
  let match: RegExpExecArray | null;
  while ((match = assignmentRe.exec(text)) !== null) {
    const afterEq = match.index + match[0].length;
    if (text[afterEq] !== '{') continue;
    const obj = extractBalancedObject(text, afterEq);
    if (obj !== null) return obj;
  }
  return null;
}

/**
 * Starting at `start` (which must be a `{`), extracts the balanced JSON object,
 * respecting strings and nested braces.
 */
function extractBalancedObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\' && inString) { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
