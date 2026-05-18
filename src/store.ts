import MiniSearch from 'minisearch';
import { cacheStatus, getDefaultCacheDir, readIndex, readPage } from './cache.js';
import { crawlMaterialDocs } from './crawler.js';
import { materialPagePath, normalizeMaterialUrl } from './crawler-utils.js';
import type { CacheStatus, MaterialIndex, SearchResult } from './types.js';

const MATERIAL_BASE_URL = 'https://m3.material.io';

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
  private indexSignature: string | null = null;
  private search: MiniSearch<SearchDoc> | null = null;
  private refreshPromise: Promise<MaterialIndex> | null = null;

  constructor(private readonly cacheDir = getDefaultCacheDir()) {}

  async ensureAvailable(): Promise<MaterialIndex> {
    return this.readCurrentIndex();
  }

  async refresh(maxPages?: number): Promise<MaterialIndex> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = crawlMaterialDocs({ cacheDir: this.cacheDir, maxPages })
      .then((index) => {
        this.setIndex(index);
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

  async getStatus(maxAgeHours = 24): Promise<CacheStatus> {
    return cacheStatus(this.cacheDir, maxAgeHours);
  }

  async getIndex(): Promise<MaterialIndex> {
    return this.readCurrentIndex();
  }

  async getPage(pathOrUrl: string): Promise<{ meta: MaterialIndex['pages'][number]; markdown: string }> {
    const index = await this.getIndex();
    const lookupKey = normalizeMaterialPageLookupKey(pathOrUrl);
    const page = index.pages.find((p) => normalizeMaterialPageLookupKey(p.path) === lookupKey || normalizeMaterialPageLookupKey(p.url) === lookupKey);
    if (!page) throw new Error(`Material 3 page not found: ${pathOrUrl}`);
    return { meta: page, markdown: await readPage(page.path, this.cacheDir) };
  }

  async getComponentDocs(componentName: string): Promise<Array<{ path: string; title: string; url: string; markdown: string }>> {
    const query = componentName.trim().toLowerCase().replace(/\s+/g, '-');
    const titleQuery = componentName.trim().toLowerCase();
    const index = await this.getIndex();
    const matched = index.pages.filter((p) => p.section.toLowerCase().includes(`components/${query}`) || p.path.toLowerCase().includes(`/components/${query}`) || p.title.toLowerCase().includes(titleQuery));
    return Promise.all(matched.map(async (p) => ({ path: p.path, title: p.title, url: p.url, markdown: await readPage(p.path, this.cacheDir) })));
  }

  async listComponents(): Promise<string[]> {
    const index = await this.getIndex();
    const components = new Set<string>();
    for (const page of index.pages) {
      const match = page.path.match(/^components\/([^/]+)/);
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
    const index = await readIndex(this.cacheDir);
    if (!index) throw new Error('Material 3 docs cache not found. Run: m3-docs-mcp update');
    this.setIndex(index);
    return index;
  }

  private setIndex(index: MaterialIndex): void {
    const nextSignature = signatureForIndex(index);
    if (this.indexSignature !== null && this.indexSignature !== nextSignature) {
      this.search = null;
    }
    this.index = index;
    this.indexSignature = nextSignature;
  }

  private excerpt(body: string, query: string): string {
    const lower = body.toLowerCase();
    const token = query.toLowerCase().split(/\s+/).find((part) => part.length > 2);
    const index = token ? lower.indexOf(token) : -1;
    const start = Math.max(0, index - 180);
    return body.slice(start, start + 500).replace(/\s+/g, ' ').trim();
  }
}

function normalizeMaterialPageLookupKey(pathOrUrl: string): string {
  const input = pathOrUrl.trim();
  const normalizedUrl = normalizeMaterialUrl(input, MATERIAL_BASE_URL);
  const pathLike = normalizedUrl ? materialPagePath(normalizedUrl) : input.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  return pathLike.replace(/\.md$/, '').replace(/^\/+|\/+$/g, '');
}

function signatureForIndex(index: MaterialIndex): string {
  return JSON.stringify({
    source: index.source,
    capturedAt: index.capturedAt,
    pageCount: index.pageCount,
    pages: index.pages.map((page) => ({ path: page.path, url: page.url, capturedAt: page.capturedAt }))
  });
}
