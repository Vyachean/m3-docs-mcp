import { z } from 'zod';

// ── Zod schemas ───────────────────────────────────────────────────────────────

const SiteMetaReferenceSchema = z.object({
  collection_id: z.string().optional(),
  document_id: z.string().optional(),
  repo_id: z.string().optional(),
}).passthrough();

export const SiteMetaRouteSchema = z.object({
  route: z.string(),
  other_routes: z.array(z.string()).optional().default([]),
  public: z.boolean().optional(),
  redirect_external_url: z.string().nullable().optional(),
  reference: SiteMetaReferenceSchema.optional(),
}).passthrough();

export const SiteMetaSchema = z.object({
  routes: z.array(SiteMetaRouteSchema),
}).passthrough();

export type SiteMetaRoute = z.infer<typeof SiteMetaRouteSchema>;
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

export type SiteMetaParseResult =
  | { ok: true; siteMeta: SiteMeta; routes: SiteMetaRouteDescriptor[]; publicCount: number; privateCount: number; redirectCount: number; aliasCount: number }
  | { ok: false; reason: string };

// ── Public API ────────────────────────────────────────────────────────────────

export class SiteMetaParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SiteMetaParseError';
  }
}

type FetchLike = typeof fetch;

export async function fetchSiteMeta(
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<SiteMeta> {
  const url = new URL('/site_meta.js', baseUrl).toString();
  let response: Response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (err) {
    throw new SiteMetaParseError(`site_meta.js fetch failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  if (!response.ok) {
    throw new SiteMetaParseError(`site_meta.js fetch failed: HTTP ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  return parseSiteMetaJs(text);
}

/**
 * Parses /site_meta.js text and extracts the site_meta object.
 * Throws SiteMetaParseError if the shape is not recognized or validation fails.
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
      err
    );
  }

  const result = SiteMetaSchema.safeParse(raw);
  if (!result.success) {
    throw new SiteMetaParseError(
      `site_meta.js: schema validation failed — routes array missing or malformed. ` +
      `Zod error: ${result.error.message}. ` +
      'This indicates the site has changed its site_meta structure. Update the schema.'
    );
  }

  if (result.data.routes.length === 0) {
    throw new SiteMetaParseError(
      'site_meta.js: parsed successfully but routes array is empty. ' +
      'This is unexpected and likely indicates a site structure change.'
    );
  }

  return result.data;
}

/**
 * Converts raw site_meta routes into normalized descriptors.
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

  for (const raw of siteMeta.routes) {
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

    const canonicalRoute = raw.route;
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
      collectionId: raw.reference?.collection_id,
      documentId: raw.reference?.document_id,
      repoId: raw.reference?.repo_id,
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
