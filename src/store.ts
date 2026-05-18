import MiniSearch from 'minisearch';
import { cacheAgeMs, cacheStatus, getDefaultCacheDir, isCacheFresh, readIndex, readPage } from './cache.js';
import { crawlMaterialDocs } from './crawler.js';
import type { CacheStatus, MaterialIndex, SearchResult } from './types.js';

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
  private search: MiniSearch<SearchDoc> | null = null;

  constructor(private readonly cacheDir = getDefaultCacheDir()) {}

  async ensureAvailable(): Promise<MaterialIndex> {
    const index = await readIndex(this.cacheDir);
    if (!index) throw new Error(`Material 3 docs cache not found. Run: m3-docs-mcp update`);
    this.index = index;
    return index;
  }

  async ensureFresh(maxAgeHours = 24): Promise<MaterialIndex> {
    const current = await readIndex(this.cacheDir);
    if (!current) return this.refresh();
    this.index = current;
    if (isCacheFresh(await cacheAgeMs(this.cacheDir), maxAgeHours)) return current;
    return current;
  }

  async refresh(maxPages?: number): Promise<MaterialIndex> {
    const index = await crawlMaterialDocs({ cacheDir: this.cacheDir, maxPages });
    this.index = index;
    this.search = null;
    return index;
  }

  async load(): Promise<MaterialIndex> {
    return this.ensureAvailable();
  }

  async getStatus(maxAgeHours = 24): Promise<CacheStatus> {
    return cacheStatus(this.cacheDir, maxAgeHours);
  }

  async getIndex(): Promise<MaterialIndex> {
    return this.index ?? this.load();
  }

  async getPage(pathOrUrl: string): Promise<{ meta: MaterialIndex['pages'][number]; markdown: string }> {
    const index = await this.getIndex();
    const page = index.pages.find((p) => p.path === pathOrUrl || p.url === pathOrUrl || p.path.replace(/\.md$/, '') === pathOrUrl.replace(/^\/+|\/+$/g, ''));
    if (!page) throw new Error(`Material 3 page not found: ${pathOrUrl}`);
    return { meta: page, markdown: await readPage(page.path, this.cacheDir) };
  }

  async getComponentDocs(componentName: string): Promise<Array<{ path: string; title: string; url: string; markdown: string }>> {
    const query = componentName.toLowerCase().replace(/\s+/g, '-');
    const index = await this.getIndex();
    const matched = index.pages.filter((p) => p.section.toLowerCase().includes(`components/${query}`) || p.path.toLowerCase().includes(`/components/${query}`) || p.title.toLowerCase().includes(componentName.toLowerCase()));
    return Promise.all(matched.map(async (p) => ({ path: p.path, title: p.title, url: p.url, markdown: await readPage(p.path, this.cacheDir) })));
  }

  async listComponents(): Promise<string[]> {
    const index = await this.getIndex();
    const components = new Set<string>();
    for (const page of index.pages) {
      const match = page.path.match(/^components\/([^/]+)/);
      if (match) components.add(match[1]);
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
    if (this.search) return this.search;
    const index = await this.getIndex();
    const docs = await Promise.all(index.pages.map(async (page): Promise<SearchDoc> => {
      const markdown = await readPage(page.path, this.cacheDir);
      return { ...page, headings: page.headings.join('\n'), body: markdown.replace(/^---[\s\S]*?---/, '').slice(0, 30000) };
    }));
    this.search = new MiniSearch<SearchDoc>({ fields: ['title', 'section', 'headings', 'body'], storeFields: ['title', 'url', 'path', 'section', 'headings', 'body'] });
    this.search.addAll(docs);
    return this.search;
  }

  private excerpt(body: string, query: string): string {
    const lower = body.toLowerCase();
    const token = query.toLowerCase().split(/\s+/).find((part) => part.length > 2);
    const index = token ? lower.indexOf(token) : -1;
    const start = Math.max(0, index - 180);
    return body.slice(start, start + 500).replace(/\s+/g, ' ').trim();
  }
}
