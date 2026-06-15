import type { JsonObject } from './schemas.js';
import { firstString, getPath } from './schemas.js';

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

export function fallbackPageCanonId(rawPageData: unknown): string | null {
  const maybeObj = getPath(rawPageData, 'result', 'pageContext');
  if (!maybeObj || typeof maybeObj !== 'object') return null;
  const pageContext = maybeObj as JsonObject;
  for (const key of Object.keys(pageContext)) {
    const value = pageContext[key];
    if (typeof value === 'string' && /canon|document/i.test(key)) return value;
  }
  return null;
}
