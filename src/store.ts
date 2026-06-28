import { stat } from 'node:fs/promises';
import MiniSearch from 'minisearch';
import { cacheStatus, getCacheDiagnostics, getDefaultCacheDir, indexPath, readIndex, readPage } from './cache.js';
import { DEFAULT_CACHE_MAX_AGE_HOURS } from './constants.js';
import { crawlMaterialDocs } from './crawler.js';
import { materialPagePath, normalizeMaterialUrl } from './crawler-utils.js';
import type { CacheDiagnostics, CacheStatus, MaterialIndex, RefreshOptions, RoutePlanEntry, SearchResult } from './types.js';

const MATERIAL_BASE_URL = 'https://m3.material.io';
const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:/i;

type SearchDoc = {
  id: string;
  title: string;
  url: string;
  path: string;
  section: string;
  headings: string;
  body: string;
};

export class MaterialDocsStore {
  private index: MaterialIndex | null = null;
  private indexFingerprint: string | null = null;
  private search: MiniSearch<SearchDoc> | null = null;
  private refreshPromise: Promise<MaterialIndex> | null = null;

  constructor(private readonly cacheDir = getDefaultCacheDir()) {}

  async ensureAvailable(): Promise<MaterialIndex> {
    return this.readCurrentIndex();
  }

  async refresh(options: RefreshOptions = {}): Promise<MaterialIndex> {
    if (this.refreshPromise) return this.refreshPromise;
    const promotePartial = options.promotePartial ?? (options.maxPages === undefined);

    this.refreshPromise = crawlMaterialDocs({ cacheDir: this.cacheDir, ...options, promotePartial })
      .then((index) => {
        this.index = index;
        this.indexFingerprint = null;
        this.search = null;
        return index;
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  async load(): Promise<MaterialIndex> {
    return this.ensureAvailable();
  }

  async getStatus(maxAgeHours = DEFAULT_CACHE_MAX_AGE_HOURS): Promise<CacheStatus> {
    return cacheStatus(this.cacheDir, maxAgeHours);
  }

  async getDiagnostics(): Promise<CacheDiagnostics> {
    return getCacheDiagnostics(this.cacheDir);
  }

  async getIndex(): Promise<MaterialIndex> {
    return this.readCurrentIndex();
  }

  async getPage(pathOrUrl: string): Promise<{ meta: MaterialIndex['pages'][number]; markdown: string }> {
    const index = await this.getIndex();
    const lookupKeys = normalizeMaterialPageLookupKeys(pathOrUrl);
    const page = index.pages.find((p) => {
      const pageKeys = new Set([...normalizeMaterialPageLookupKeys(p.path), ...normalizeMaterialPageLookupKeys(p.url)]);
      return lookupKeys.some((key) => pageKeys.has(key));
    });
    if (!page) throw new Error(`Material 3 page not found: ${pathOrUrl}`);
    return { meta: page, markdown: await readPage(page.path, this.cacheDir) };
  }

  async getComponentDocs(
    componentName: string,
    options: { includeMarkdown?: boolean; maxPages?: number; maxMarkdownChars?: number } = {}
  ): Promise<Array<{ path: string; title: string; url: string; section: string; headings: string[]; markdown?: string }>> {
    const normalizedName = componentName.trim();
    if (!normalizedName) return [];

    const index = await this.getIndex();
    const componentRoutes = this.componentRouteAliases(index, normalizedName);
    const titleQuery = normalizeSearchText(normalizedName);
    const matched = index.pages.filter((p) => {
      const pageKeys = new Set([...normalizeMaterialPageLookupKeys(p.path), ...normalizeMaterialPageLookupKeys(p.url)]);
      return componentRoutes.some((route) => pageKeys.has(route) || pageKeys.has(`${route}/overview`))
        || normalizeSearchText(p.title).includes(titleQuery);
    });
    const limited = matched.slice(0, options.maxPages ?? 10);
    if (!options.includeMarkdown) {
      return limited.map((p) => ({ path: p.path, title: p.title, url: p.url, section: p.section, headings: p.headings }));
    }
    const maxMarkdownChars = options.maxMarkdownChars ?? 20_000;
    return Promise.all(limited.map(async (p) => ({
      path: p.path,
      title: p.title,
      url: p.url,
      section: p.section,
      headings: p.headings,
      markdown: (await readPage(p.path, this.cacheDir)).slice(0, maxMarkdownChars)
    })));
  }

  async listComponents(): Promise<Array<{ component: string; section: string; path: string }>> {
    const index = await this.getIndex();
    const components = new Map<string, { component: string; section: string; path: string }>();
    for (const page of index.pages) {
      const match = page.path.match(/^components\/([^/]+)\//);
      if (match?.[1] && !components.has(match[1])) {
        components.set(match[1], { component: match[1], section: page.section, path: page.path });
      }
    }
    return Array.from(components.values()).sort((a, b) => a.component.localeCompare(b.component));
  }

  async searchDocs(query: string, limit = 10): Promise<SearchResult[]> {
    const search = await this.getSearchIndex();
    const results = search.search(query, { prefix: true, fuzzy: 0.2 }).slice(0, limit);
    return results.map((r) => ({
      title: String(r.title),
      url: String(r.url),
      path: String(r.path),
      section: String(r.section),
      headings: String(r.headings).split('\n').filter(Boolean),
      score: r.score,
      excerpt: this.excerpt(String(r.body), query)
    }));
  }

  private async getSearchIndex(): Promise<MiniSearch<SearchDoc>> {
    const index = await this.getIndex();
    if (this.search) return this.search;

    const docs = await Promise.all(index.pages.map(async (page): Promise<SearchDoc> => {
      const markdown = await readPage(page.path, this.cacheDir);
      return { ...page, headings: page.headings.join('\n'), body: markdown.replace(/^---[\s\S]*?---/, '').slice(0, 30000) };
    }));
    this.search = new MiniSearch<SearchDoc>({ fields: ['title', 'section', 'headings', 'body'], storeFields: ['title', 'url', 'path', 'section', 'headings', 'body'] });
    this.search.addAll(docs);
    return this.search;
  }

  private async readCurrentIndex(): Promise<MaterialIndex> {
    let fingerprint: string;
    try {
      const indexStats = await stat(indexPath(this.cacheDir));
      fingerprint = `${indexStats.mtimeMs}:${indexStats.size}`;
    } catch {
      this.index = null;
      this.indexFingerprint = null;
      this.search = null;
      throw new Error('Material 3 docs cache not found. Run: m3-docs-mcp update');
    }

    if (this.index && this.indexFingerprint === fingerprint) return this.index;

    const index = await readIndex(this.cacheDir);
    if (!index) {
      this.index = null;
      this.indexFingerprint = null;
      this.search = null;
      throw new Error('Material 3 docs cache not found. Run: m3-docs-mcp update');
    }

    if (this.indexFingerprint !== null && this.indexFingerprint !== fingerprint) this.search = null;
    this.index = index;
    this.indexFingerprint = fingerprint;
    return index;
  }

  private excerpt(body: string, query: string): string {
    const lower = body.toLowerCase();
    const token = query.toLowerCase().split(/\s+/).find((part) => part.length > 2);
    const index = token ? lower.indexOf(token) : -1;
    const start = Math.max(0, index - 180);
    return body.slice(start, start + 500).replace(/\s+/g, ' ').trim();
  }

  private componentRouteAliases(index: MaterialIndex, componentName: string): string[] {
    const normalized = normalizeComponentLookup(componentName);
    if (!normalized) return [];
    const plannedRoutes = index.coverageDiagnostics?.fullRoutePlanSummary?.acceptedRoutes ?? [];
    const matchedPlannedRoutes = plannedRoutes
      .filter((entry) => isComponentRouteEntry(entry))
      .filter((entry) => componentTokensForRoute(entry).some((token) => token === normalized));
    const aliases = new Set<string>();
    for (const route of matchedPlannedRoutes) {
      aliases.add(route.route.replace(/^\/+/, ''));
      if (route.canonicalRoute) aliases.add(route.canonicalRoute.replace(/^\/+/, ''));
      for (const alias of route.alternateSlugs ?? []) aliases.add(alias.replace(/^\/+/, ''));
    }
    if (aliases.size === 0) {
      for (const fallback of fallbackComponentAliases(normalized)) aliases.add(fallback);
    }
    return Array.from(aliases);
  }
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeComponentLookup(value: string): string {
  return value.trim().toLowerCase().replace(/overview/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function singularizeComponentToken(token: string): string[] {
  const variants = new Set<string>([token]);
  if (token.endsWith('ies') && token.length > 3) variants.add(`${token.slice(0, -3)}y`);
  if (token.endsWith('es') && token.length > 3) variants.add(token.slice(0, -2));
  if (token.endsWith('s') && token.length > 2) variants.add(token.slice(0, -1));
  return Array.from(variants);
}

function fallbackComponentAliases(normalized: string): string[] {
  const variants = new Set<string>();
  for (const variant of singularizeComponentToken(normalized)) {
    variants.add(`components/${variant}`);
    variants.add(`components/${variant}s`);
    variants.add(`components/${variant}es`);
  }
  return Array.from(variants);
}

function isComponentRouteEntry(entry: RoutePlanEntry): boolean {
  const route = (entry.canonicalRoute ?? entry.route).replace(/^\/+/, '');
  return route.startsWith('components/');
}

function componentTokensForRoute(entry: RoutePlanEntry): string[] {
  const raw = (entry.canonicalRoute ?? entry.route).replace(/^\/+/, '');
  const segments = raw.split('/');
  const component = segments[1];
  if (!component) return [];
  return singularizeComponentToken(component);
}

function normalizeMaterialPageLookupKeys(pathOrUrl: string): string[] {
  const input = pathOrUrl.trim();
  const inputWithoutQuery = input.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  const isCachePathInput = !ABSOLUTE_URL.test(input) && inputWithoutQuery.endsWith('.md');
  const normalizedUrl = isCachePathInput ? null : normalizeMaterialUrl(input, MATERIAL_BASE_URL);
  const pathLike = normalizedUrl ? materialPagePath(normalizedUrl) : inputWithoutQuery;
  const key = pathLike.replace(/\.md$/, '').replace(/^\/+|\/+$/g, '');
  const aliases = new Set([key]);
  const componentOverview = key.match(/^(components\/[^/]+)\/overview$/);
  if (componentOverview?.[1]) aliases.add(componentOverview[1]);
  const componentLanding = key.match(/^(components\/[^/]+)$/);
  if (componentLanding?.[1]) aliases.add(`${componentLanding[1]}/overview`);
  return Array.from(aliases);
}
