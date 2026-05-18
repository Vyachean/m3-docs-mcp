export type MaterialPage = {
  id: string;
  title: string;
  url: string;
  path: string;
  section: string;
  headings: string[];
  text: string;
  markdown: string;
  capturedAt: string;
};

export type MaterialIndex = {
  source: 'https://m3.material.io';
  capturedAt: string;
  pageCount: number;
  pages: Omit<MaterialPage, 'text' | 'markdown'>[];
};

export type CrawlOptions = {
  baseUrl?: string;
  maxPages?: number;
  cacheDir?: string;
  headless?: boolean;
  force?: boolean;
};

export type SearchResult = {
  title: string;
  url: string;
  path: string;
  section: string;
  headings: string[];
  score: number;
  excerpt: string;
};
