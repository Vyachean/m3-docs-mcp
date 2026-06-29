import { describe, expect, it } from 'vitest';
import { validateSearchIndex } from '../src/validation/validate-search-index.js';

describe('validateSearchIndex', () => {
  it('passes when the injected store returns non-empty results for every query', async () => {
    const result = await validateSearchIndex({
      queries: ['button', 'switch'],
      store: {
        searchDocs: async (query: string) => [{ title: query }],
      },
    });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails when a query returns zero results', async () => {
    const result = await validateSearchIndex({
      queries: ['button', 'nonexistent-widget'],
      store: {
        searchDocs: async (query: string) => (query === 'button' ? [{ title: 'Button' }] : []),
      },
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('nonexistent-widget'))).toBe(true);
  });

  it('fails when searchDocs throws', async () => {
    const result = await validateSearchIndex({
      queries: ['button'],
      store: {
        searchDocs: async () => {
          throw new Error('index build failed');
        },
      },
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('index build failed'))).toBe(true);
  });

  it('records per-query result counts in details', async () => {
    const result = await validateSearchIndex({
      queries: ['button', 'list'],
      store: {
        searchDocs: async (query: string) => (query === 'button' ? [{}, {}] : [{}]),
      },
    });
    expect(result.details?.resultCounts).toEqual({ button: 2, list: 1 });
  });
});
