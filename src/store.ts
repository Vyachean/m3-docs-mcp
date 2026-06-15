import { stat } from 'node:fs/promises';
import MiniSearch from 'minisearch';
import { cacheStatus, getDefaultCacheDir, indexPath, readIndex, readPage } from './cache.js';
import { DEFAULT_CACHE_MAX_AGE_HOURS } from './constants.js';
import { crawlMaterialDocs } from './crawler.js';
import { materialPagePath, normalizeMaterialUrl } from './crawler-utils.js';
import type { CacheStatus, MaterialIndex, OperationalLogger, RefreshOptions, SearchResult } from './types.js';

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

  constructor(
    private readonly cacheDir = getDefaultCacheDir(),
    private readonly logger?: OperationalLogger
  ) {}

  async ensureAvailable(): Promise<MaterialIndex> {
    return this.readCurrentIndex();
  }

  async refresh(options: RefreshOptions = {}): Promise<MaterialIndex> {
    if (this.refreshPromise) {
      this.logger?.info('refresh-deduplicated', 'Refresh already in progress for this store; reusing existing refresh');
      return this.refreshPromise;
    }

    const crawlOptions = {
      cacheDir: this.cacheDir,
      ...options,
      ...(this.logger ? { logger: this.logger } : {})
    };

    this.refreshPromise = crawlMaterialDocs(crawlOptions)
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

  async getComponentDocs(componentName: string): Promise<Array<{ path: string; title: string; url: string; markdown: string }>> {
    const normalizedName = componentName.trim();
    if (!normalizedName) return [];

    const query = normalizedName.toLowerCase().replace(/\s+/g, '-');
    const titleQuery = normalizeSearchText(normalizedName);
    const index = await this.getIndex();
    const matched = index.pages.filter((p) => p.section.toLowerCase().includes(`components/${query}`) || p.path.toLowerCase().includes(`/components/${query}`) || normalizeSearchText(p.title).includes(titleQuery));
    return Promise.all(matched.map(async (p) => ({ path: p.path, title: p.title, url: p.url, markdown: await readPage(p.path, this.cacheDir) })));
  }

  async listComponents(): Promise<string[]> {
    const index = await this.getIndex();
    const components = new Set<string>();
    for (const page of index.pages) {
      const match = page.path.match(/^components\/([^/]+)\//);
      if (match?.[1]) components.add(match[1]);
    }
    return Array.from(components).sort();
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
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
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
