import { describe, expect, it } from 'vitest';
import {
  deriveCollectionSegmentFromSlug,
  extractPageDataMetadata,
  fallbackPageCanonId
} from '../src/json-extraction/extract-page-data.js';

describe('extractPageDataMetadata', () => {
  it('uses the documented title precedence', () => {
    expect(extractPageDataMetadata({
      title: 'root',
      pageContext: { title: 'context' },
      result: {
        pageContext: { title: 'result-context' },
        data: { mdx: { frontmatter: { title: 'frontmatter' } } }
      }
    }).title).toBe('frontmatter');

    expect(extractPageDataMetadata({ result: { pageContext: { title: 'result-context' } } }).title).toBe('result-context');
    expect(extractPageDataMetadata({ pageContext: { title: 'context' } }).title).toBe('context');
    expect(extractPageDataMetadata({ title: 'root' }).title).toBe('root');
  });

  it('uses canonical identity precedence and accepts documentId only from result.pageContext', () => {
    expect(extractPageDataMetadata({
      pageCanonId: 'root',
      pageContext: { pageCanonId: 'context' },
      result: {
        data: { pageCanonId: 'data' },
        pageContext: {
          pageCanonId: 'result-canon',
          pageCanonicalId: 'result-canonical',
          documentId: 'document'
        }
      }
    }).pageCanonId).toBe('result-canon');

    expect(extractPageDataMetadata({ result: { pageContext: { pageCanonicalId: 'canonical' } } }).pageCanonId).toBe('canonical');
    expect(extractPageDataMetadata({ pageContext: { pageCanonId: 'context' } }).pageCanonId).toBe('context');
    expect(extractPageDataMetadata({ pageContext: { pageCanonicalId: 'context-canonical' } }).pageCanonId).toBe('context-canonical');
    expect(extractPageDataMetadata({ result: { data: { pageCanonId: 'data' } } }).pageCanonId).toBe('data');
    expect(extractPageDataMetadata({ pageCanonId: 'root' }).pageCanonId).toBe('root');
    expect(extractPageDataMetadata({ result: { pageContext: { documentId: 'document' } } }).pageCanonId).toBe('document');
    expect(extractPageDataMetadata({ documentId: 'root-document' }).pageCanonId).toBeNull();
  });

  it('uses route pathname precedence without treating arbitrary pathname fields as public metadata', () => {
    expect(extractPageDataMetadata({
      path: '/root-path',
      pageContext: { slug: 'context-slug' },
      result: { pageContext: { slug: 'result-slug', pathname: '/result-pathname', path: '/result-path' } }
    }).pathname).toBe('/root-path');

    expect(extractPageDataMetadata({ pageContext: { slug: 'context-slug' } }).pathname).toBe('context-slug');
    expect(extractPageDataMetadata({ result: { pageContext: { slug: 'result-slug' } } }).pathname).toBe('result-slug');
    expect(extractPageDataMetadata({ result: { pageContext: { pathname: '/result-pathname' } } }).pathname).toBe('/result-pathname');
    expect(extractPageDataMetadata({ result: { pageContext: { path: '/result-path' } } }).pathname).toBe('/result-path');
    expect(extractPageDataMetadata({ pathname: '/root-pathname' }).pathname).toBeNull();
  });

  it('ignores blank strings, arrays, and non-record intermediate values', () => {
    expect(extractPageDataMetadata({
      title: '   ',
      pageCanonId: '',
      path: 123,
      pageContext: [],
      result: { pageContext: 'not-an-object' }
    })).toEqual({ title: null, pageCanonId: null, pathname: null });

    expect(extractPageDataMetadata(null)).toEqual({ title: null, pageCanonId: null, pathname: null });
  });
});

describe('deriveCollectionSegmentFromSlug', () => {
  it.each([
    ['components/button/overview', 'ComponentsM3'],
    ['/foundations/layout/', 'FoundationsM3'],
    ['styles/color/roles', 'StylesM3'],
    ['develop/android', 'DevelopM3'],
    ['get-started/overview', 'GetStartedM3'],
    ['blog/2026/example', 'BlogM3']
  ])('maps %s to %s', (slug, expected) => {
    expect(deriveCollectionSegmentFromSlug(slug)).toBe(expected);
  });

  it('returns null for empty and unsupported roots', () => {
    expect(deriveCollectionSegmentFromSlug('///')).toBeNull();
    expect(deriveCollectionSegmentFromSlug('unknown/page')).toBeNull();
  });
});

describe('fallbackPageCanonId', () => {
  it('finds the first string canon/document field from result.pageContext', () => {
    expect(fallbackPageCanonId({
      result: {
        pageContext: {
          unrelated: 'ignore',
          customCanonicalIdentity: 'canon-id',
          documentReference: 'document-id'
        }
      }
    })).toBe('canon-id');
  });

  it('ignores matching keys with non-string values and invalid pageContext shapes', () => {
    expect(fallbackPageCanonId({
      result: { pageContext: { canonicalIdentity: 123, documentReference: 'document-id' } }
    })).toBe('document-id');
    expect(fallbackPageCanonId({ result: { pageContext: [] } })).toBeNull();
    expect(fallbackPageCanonId({ result: {} })).toBeNull();
    expect(fallbackPageCanonId(null)).toBeNull();
  });
});
