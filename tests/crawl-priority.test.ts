import { describe, expect, it } from 'vitest';
import { CRAWL_PRIORITY_POLICY_VERSION, classifyMaterialRoute, compareMaterialCrawlUrlPriority, compareMaterialRoutePriority, isBlogPath } from '../src/crawl-priority.js';

describe('classifyMaterialRoute', () => {
  it('classifies component paths as Tier 1', () => {
    expect(classifyMaterialRoute('/components/button/specs')).toBe(1);
    expect(classifyMaterialRoute('/components/divider/guidelines')).toBe(1);
    expect(classifyMaterialRoute('/components')).toBe(1);
  });

  it('classifies styles paths as Tier 1', () => {
    expect(classifyMaterialRoute('/styles/color/overview')).toBe(1);
    expect(classifyMaterialRoute('/styles')).toBe(1);
  });

  it('classifies foundations paths as Tier 1', () => {
    expect(classifyMaterialRoute('/foundations/accessibility/overview')).toBe(1);
    expect(classifyMaterialRoute('/foundations')).toBe(1);
  });

  it('classifies root as Tier 1', () => {
    expect(classifyMaterialRoute('/')).toBe(1);
    expect(classifyMaterialRoute('')).toBe(1);
  });

  it('classifies develop paths as Tier 2', () => {
    expect(classifyMaterialRoute('/develop/web')).toBe(2);
    expect(classifyMaterialRoute('/develop')).toBe(2);
  });

  it('classifies get-started paths as Tier 2', () => {
    expect(classifyMaterialRoute('/get-started')).toBe(2);
    expect(classifyMaterialRoute('/get-started/design')).toBe(2);
  });

  it('classifies designing paths as Tier 2', () => {
    expect(classifyMaterialRoute('/designing')).toBe(2);
    expect(classifyMaterialRoute('/designing/overview')).toBe(2);
  });

  it('classifies resources as Tier 3', () => {
    expect(classifyMaterialRoute('/resources')).toBe(3);
    expect(classifyMaterialRoute('/resources/fonts')).toBe(3);
  });

  it('classifies templates as Tier 3', () => {
    expect(classifyMaterialRoute('/templates')).toBe(3);
  });

  it('classifies case-studies as Tier 3', () => {
    expect(classifyMaterialRoute('/case-studies')).toBe(3);
    expect(classifyMaterialRoute('/case-studies/google-pay')).toBe(3);
  });

  it('classifies blog paths as Tier 4', () => {
    expect(classifyMaterialRoute('/blog')).toBe(4);
    expect(classifyMaterialRoute('/blog/material-you-2023')).toBe(4);
    expect(classifyMaterialRoute('/blog/some-post')).toBe(4);
  });

  it('classifies articles paths as Tier 4', () => {
    expect(classifyMaterialRoute('/articles')).toBe(4);
    expect(classifyMaterialRoute('/articles/design-tips')).toBe(4);
  });

  it('classifies news paths as Tier 4', () => {
    expect(classifyMaterialRoute('/news')).toBe(4);
    expect(classifyMaterialRoute('/news/release-notes')).toBe(4);
  });

  it('classifies year-based paths as Tier 4', () => {
    expect(classifyMaterialRoute('/2023/some-article')).toBe(4);
    expect(classifyMaterialRoute('/2024/post')).toBe(4);
  });

  it('classifies unknown routes as Tier 5', () => {
    expect(classifyMaterialRoute('/unknown-section')).toBe(5);
    expect(classifyMaterialRoute('/about')).toBe(5);
    expect(classifyMaterialRoute('/sitemap.xml')).toBe(5);
  });

  it('ignores query strings and hash fragments', () => {
    expect(classifyMaterialRoute('/components/button?tab=specs')).toBe(1);
    expect(classifyMaterialRoute('/blog/post#section')).toBe(4);
  });

  it('handles paths without leading slash', () => {
    expect(classifyMaterialRoute('components/button/specs')).toBe(1);
    expect(classifyMaterialRoute('blog/post')).toBe(4);
    expect(classifyMaterialRoute('resources')).toBe(3);
  });
});

describe('isBlogPath', () => {
  it('returns true for blog paths', () => {
    expect(isBlogPath('/blog')).toBe(true);
    expect(isBlogPath('/blog/post')).toBe(true);
    expect(isBlogPath('/articles/tips')).toBe(true);
    expect(isBlogPath('/news')).toBe(true);
    expect(isBlogPath('/2023/post')).toBe(true);
  });

  it('returns false for non-blog paths', () => {
    expect(isBlogPath('/components/button')).toBe(false);
    expect(isBlogPath('/styles/color')).toBe(false);
    expect(isBlogPath('/foundations/accessibility')).toBe(false);
    expect(isBlogPath('/develop/web')).toBe(false);
    expect(isBlogPath('/resources')).toBe(false);
    expect(isBlogPath('/')).toBe(false);
  });
});

describe('compareMaterialRoutePriority', () => {
  it('orders components before blog', () => {
    expect(compareMaterialRoutePriority('/components/button', '/blog/post')).toBeLessThan(0);
  });

  it('orders styles before blog', () => {
    expect(compareMaterialRoutePriority('/styles/color', '/blog/post')).toBeLessThan(0);
  });

  it('orders foundations before blog', () => {
    expect(compareMaterialRoutePriority('/foundations/accessibility', '/blog/post')).toBeLessThan(0);
  });

  it('orders Tier 1 before Tier 2', () => {
    expect(compareMaterialRoutePriority('/components/button', '/develop/web')).toBeLessThan(0);
  });

  it('orders Tier 2 before Tier 3', () => {
    expect(compareMaterialRoutePriority('/develop/web', '/resources')).toBeLessThan(0);
  });

  it('orders Tier 3 before Tier 4', () => {
    expect(compareMaterialRoutePriority('/resources', '/blog/post')).toBeLessThan(0);
  });

  it('orders Tier 4 before Tier 5', () => {
    expect(compareMaterialRoutePriority('/blog/post', '/unknown-page')).toBeLessThan(0);
  });

  it('uses lexical order within the same tier', () => {
    expect(compareMaterialRoutePriority('/components/button', '/components/divider')).toBeLessThan(0);
    expect(compareMaterialRoutePriority('/blog/b', '/blog/a')).toBeGreaterThan(0);
  });

  it('returns 0 for equal paths', () => {
    expect(compareMaterialRoutePriority('/components/button', '/components/button')).toBe(0);
  });
});

describe('queue ordering', () => {
  it('puts components/styles/foundations before blog in a mixed list', () => {
    const paths = [
      '/blog/post',
      '/styles/color/overview',
      '/components/button/specs',
      '/foundations/accessibility/overview',
      '/develop/web',
      '/resources',
      '/unknown'
    ];
    const sorted = [...paths].sort(compareMaterialRoutePriority);
    const blogIndex = sorted.indexOf('/blog/post');
    expect(sorted.indexOf('/components/button/specs')).toBeLessThan(blogIndex);
    expect(sorted.indexOf('/styles/color/overview')).toBeLessThan(blogIndex);
    expect(sorted.indexOf('/foundations/accessibility/overview')).toBeLessThan(blogIndex);
  });

  it('ordering is deterministic regardless of input order', () => {
    const paths = ['/blog/z', '/components/a', '/blog/a', '/styles/b', '/foundations/c'];
    const sorted1 = [...paths].sort(compareMaterialRoutePriority);
    const shuffled = ['/foundations/c', '/blog/a', '/components/a', '/blog/z', '/styles/b'];
    const sorted2 = [...shuffled].sort(compareMaterialRoutePriority);
    expect(sorted1).toEqual(sorted2);
  });

  it('sitemap order cannot make blog first', () => {
    // Simulate sitemap returning blog before components
    const sitemapOrder = ['/blog/post', '/blog/other', '/components/button', '/styles/color'];
    const sorted = [...sitemapOrder].sort(compareMaterialRoutePriority);
    expect(sorted[0]).toMatch(/^\/(components|styles|foundations)/);
  });
});

describe('compareMaterialCrawlUrlPriority', () => {
  const base = 'https://m3.material.io';

  it('orders component URLs before blog URLs', () => {
    const a = `${base}/components/button/specs`;
    const b = `${base}/blog/post`;
    expect(compareMaterialCrawlUrlPriority(a, b)).toBeLessThan(0);
  });

  it('uses lexical order within the same tier', () => {
    const a = `${base}/components/button`;
    const b = `${base}/components/divider`;
    expect(compareMaterialCrawlUrlPriority(a, b)).toBeLessThan(0);
  });
});

describe('CRAWL_PRIORITY_POLICY_VERSION', () => {
  it('exports a non-empty version string', () => {
    expect(typeof CRAWL_PRIORITY_POLICY_VERSION).toBe('string');
    expect(CRAWL_PRIORITY_POLICY_VERSION.length).toBeGreaterThan(0);
  });
});
