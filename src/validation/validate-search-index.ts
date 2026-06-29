import { getDefaultCacheDir } from '../cache.js';
import { loadGraphToolContext } from '../mcp-tools/context.js';
import { searchStructuredDocs } from '../mcp-tools/search-structured-docs.js';
import { MaterialDocsStore } from '../store.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * Stage 6 of `verify:cache:full`: search/index generation.
 *
 * This repository does not persist a standalone search-index file (e.g. `rendered/search-index.json`)
 * — `src/store.ts`'s `MaterialDocsStore` builds a MiniSearch index in-memory from `index.json` +
 * `pages/**` Markdown on first use (see `getSearchIndex`). There is therefore no "does the search
 * index file exist and parse" check to perform; instead, this validates the equivalent guarantee
 * end-to-end: that a freshly-constructed `MaterialDocsStore` pointed at the cache dir can build its
 * search index and return non-empty results for each of `DEFAULT_SEARCH_SMOKE_QUERIES` (component
 * names expected to exist in any healthy cache). This is documented here as the chosen smoke proxy
 * per the dispatch's "your call, document it" guidance — if a future stage adds a persisted
 * search-index artifact, this check should be updated to validate that file directly instead.
 */

export const DEFAULT_SEARCH_SMOKE_QUERIES: readonly string[] = ['button', 'switch', 'list'];

export type ValidateSearchIndexInput = {
  cacheDir?: string;
  queries?: readonly string[];
  /** Injected for tests: a pre-built store (or fake) satisfying MaterialDocsStore's searchDocs
   *  shape, bypassing the real cacheDir-backed constructor. */
  store?: { searchDocs: (query: string, limit?: number) => Promise<unknown[]> };
};

export async function validateSearchIndex(input: ValidateSearchIndexInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const queries = input.queries ?? DEFAULT_SEARCH_SMOKE_QUERIES;
  const stage = 'search-index';
  const store = input.store ?? new MaterialDocsStore(cacheDir);

  const reasons: string[] = [];
  const resultCounts: Record<string, number> = {};

  for (const query of queries) {
    try {
      const results = await store.searchDocs(query, 5);
      resultCounts[query] = results.length;
      if (results.length === 0) {
        reasons.push(`Search query "${query}" returned zero results against the freshly-built cache.`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reasons.push(`Search query "${query}" threw an error: ${reason}.`);
    }
  }

  // Structured search (spec: "structured search / search index" is part of full verification,
  // not just the Markdown-search smoke proxy above) — only checked against the real cache dir
  // (callers injecting a fake `store` are testing stage orchestration, not this cache's graph).
  let structuredSearchResultCount: number | null = null;
  if (!input.store) {
    const context = await loadGraphToolContext(cacheDir);
    const structuredResult = searchStructuredDocs(context, queries[0] ?? 'button', 5);
    if (structuredResult.available) {
      structuredSearchResultCount = structuredResult.results.length;
      if (structuredResult.results.length === 0) {
        reasons.push(`Structured search query "${queries[0] ?? 'button'}" returned zero results against the documentation graph.`);
      }
    }
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, { resultCounts, structuredSearchResultCount });
  }

  return passedCheck(stage, { resultCounts, structuredSearchResultCount });
}
