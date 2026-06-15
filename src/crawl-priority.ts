export type MaterialRoutePriority = 1 | 2 | 3 | 4 | 5;

export const CRAWL_PRIORITY_POLICY_VERSION = '1';

/**
 * Classify a Material 3 public doc path into a crawl priority tier.
 *
 * Tier 1 – core Material docs: components, styles, foundations
 * Tier 2 – development / getting-started / implementation
 * Tier 3 – resources / secondary docs
 * Tier 4 – blog / news / articles
 * Tier 5 – unknown / low-value / non-doc routes
 */
export function classifyMaterialRoute(path: string): MaterialRoutePriority {
  const p = `/${path.replace(/^\/+/, '').split('?')[0].split('#')[0]}`;
  if (p === '/') return 1;
  if (p.startsWith('/components') || p.startsWith('/styles') || p.startsWith('/foundations')) return 1;
  if (p.startsWith('/develop') || p.startsWith('/get-started') || p.startsWith('/designing')) return 2;
  if (p.startsWith('/resources') || p.startsWith('/templates') || p.startsWith('/case-studies')) return 3;
  if (isBlogPath(p)) return 4;
  return 5;
}

/** Return true if the path is a blog / news / article route. */
export function isBlogPath(path: string): boolean {
  const p = `/${path.replace(/^\/+/, '').split('?')[0].split('#')[0]}`;
  return (
    p.startsWith('/blog') ||
    p.startsWith('/articles') ||
    p.startsWith('/news') ||
    /^\/20\d\d(\/|$)/.test(p)
  );
}

/** Compare two doc paths by priority tier, then lexically within a tier. */
export function compareMaterialRoutePriority(a: string, b: string): number {
  return classifyMaterialRoute(a) - classifyMaterialRoute(b) || a.localeCompare(b);
}

/** Compare two full crawl URLs by priority tier, then lexically within a tier. */
export function compareMaterialCrawlUrlPriority(a: string, b: string): number {
  const pa = new URL(a).pathname;
  const pb = new URL(b).pathname;
  return classifyMaterialRoute(pa) - classifyMaterialRoute(pb) || a.localeCompare(b);
}
