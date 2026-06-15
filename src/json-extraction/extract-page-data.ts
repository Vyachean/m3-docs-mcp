import { asObject, firstString, getPath } from './schemas.js';

export type JsonPageMetadata = {
  title: string | null;
  pageCanonId: string | null;
  pathname: string | null;
};

export function extractPageDataMetadata(rawPageData: unknown): JsonPageMetadata {
  const title = firstString(rawPageData, [
    ['result', 'data', 'mdx', 'frontmatter', 'title'],
    ['result', 'pageContext', 'title'],
    ['pageContext', 'title'],
    ['title']
  ]);

  const pageCanonId = firstString(rawPageData, [
    ['result', 'pageContext', 'pageCanonId'],
    ['result', 'pageContext', 'pageCanonicalId'],
    ['pageContext', 'pageCanonId'],
    ['pageContext', 'pageCanonicalId'],
    ['result', 'data', 'pageCanonId'],
    ['pageCanonId'],
    ['result', 'pageContext', 'documentId']
  ]);

  const pathname = firstString(rawPageData, [
    ['path'],
    ['pageContext', 'slug'],
    ['result', 'pageContext', 'slug'],
    ['result', 'pageContext', 'pathname'],
    ['result', 'pageContext', 'path']
  ]);

  return { title, pageCanonId, pathname };
}

export function deriveCollectionSegmentFromSlug(slug: string): string | null {
  const root = slug.replace(/^\/+|\/+$/g, '').split('/')[0] ?? '';
  if (!root) return null;
  const mapping: Record<string, string> = {
    components: 'ComponentsM3',
    foundations: 'FoundationsM3',
    styles: 'StylesM3',
    develop: 'DevelopM3',
    'get-started': 'GetStartedM3',
    blog: 'BlogM3'
  };
  return mapping[root] ?? null;
}

export function fallbackPageCanonId(rawPageData: unknown): string | null {
  const pageContext = asObject(getPath(rawPageData, 'result', 'pageContext'));
  if (!pageContext) return null;
  for (const key of Object.keys(pageContext)) {
    const value = pageContext[key];
    if (typeof value === 'string' && /canon|document/i.test(key)) return value;
  }
  return null;
}
