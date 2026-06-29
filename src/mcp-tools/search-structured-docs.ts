import type { GraphToolContext } from './context.js';

/**
 * Graph-based structured search (spec item 9): lets agents find routes/sections/chunks/tokens/
 * resources by query text without parsing Markdown or raw JSON. Complements (does not replace)
 * the Markdown-oriented `search_material_docs` — this tool only ever reads already-built
 * graph/*.json data (routes.json/pages.json/resources.json/token-tables.json), the same source
 * the other graph-oriented MCP tools use.
 *
 * Matching: the query is split into lowercased words; a candidate matches when every query word
 * appears as a substring of the candidate's normalized searchable text (non-alphanumeric
 * characters treated as spaces, so a token name like "md.comp.switch.selected.track.color"
 * matches a query of "switch selected track color"). This is intentionally a simple, predictable
 * substring matcher — good enough for finding facts by name/alias/heading, not a ranked
 * full-text search engine.
 */

export type StructuredSearchMatchKind = 'route' | 'page' | 'section' | 'chunk' | 'token' | 'resource';

export type StructuredSearchMatch = {
  kind: StructuredSearchMatchKind;
  route: string | null;
  title: string;
  excerpt: string;
  tokenSetName?: string;
  tokenName?: string;
  resourceId?: string;
};

export type SearchStructuredDocsResult = {
  available: boolean;
  message: string | null;
  query: string;
  results: StructuredSearchMatch[];
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchesQuery(searchableText: string, queryWords: string[]): boolean {
  const normalized = normalize(searchableText);
  if (!normalized) return false;
  return queryWords.every((word) => normalized.includes(word));
}

export function searchStructuredDocs(context: GraphToolContext, query: string, limit = 20): SearchStructuredDocsResult {
  if (!context.routeGraph && !context.pageGraph && !context.resourceGraph && !context.tokenTableGraph) {
    return {
      available: false,
      message: 'Material 3 documentation graph is not available yet. Run refresh_material_docs, then retry.',
      query,
      results: [],
    };
  }

  const queryWords = normalize(query).split(' ').filter(Boolean);
  if (queryWords.length === 0) {
    return { available: true, message: 'Empty query.', query, results: [] };
  }

  const results: StructuredSearchMatch[] = [];

  for (const route of context.routeGraph?.routes ?? []) {
    const searchable = [route.route, route.title ?? '', route.section ?? '', ...route.aliases].join(' ');
    if (matchesQuery(searchable, queryWords)) {
      results.push({ kind: 'route', route: route.route, title: route.title ?? route.route, excerpt: route.route });
    }
  }

  for (const page of context.pageGraph?.pages ?? []) {
    if (matchesQuery([page.title, ...page.headings].join(' '), queryWords)) {
      results.push({ kind: 'page', route: page.route, title: page.title, excerpt: page.headings.join(' › ') });
    }
    for (const section of page.sections) {
      // Include the page title so a query like "segmented button outline" can match a section
      // titled just "Outline" on the "Segmented buttons" page — the component name usually isn't
      // repeated in every section heading.
      if (matchesQuery(`${page.title} ${section.title}`, queryWords)) {
        results.push({ kind: 'section', route: page.route, title: section.title, excerpt: `${page.title} › ${section.title}` });
      }
    }
    for (const chunk of page.chunks) {
      if (chunk.textExcerpt && matchesQuery(chunk.textExcerpt, queryWords)) {
        results.push({ kind: 'chunk', route: page.route, title: page.title, excerpt: chunk.textExcerpt });
      }
    }
  }

  for (const table of context.tokenTableGraph?.tokenTables ?? []) {
    const route = table.routes[0] ?? null;
    for (const tokenSet of table.tokenSets) {
      if (matchesQuery([tokenSet.tokenSetName, tokenSet.displayName, table.resourceName ?? ''].join(' '), queryWords)) {
        results.push({
          kind: 'token',
          route,
          title: tokenSet.displayName || tokenSet.tokenSetName,
          excerpt: `Token set ${tokenSet.tokenSetName} (${table.resourceName ?? table.resourceId})`,
          tokenSetName: tokenSet.tokenSetName,
        });
      }
      for (const token of tokenSet.tokens) {
        const searchable = [token.tokenName, token.displayName, ...token.aliases].join(' ');
        if (matchesQuery(searchable, queryWords)) {
          results.push({
            kind: 'token',
            route,
            title: token.displayName || token.tokenName,
            excerpt: `${token.tokenName} (${tokenSet.tokenSetName})${token.aliases.length > 0 ? ` aliases: ${token.aliases.join(', ')}` : ''}`,
            tokenSetName: tokenSet.tokenSetName,
            tokenName: token.tokenName,
          });
        }
      }
    }
  }

  for (const resource of context.resourceGraph?.resources ?? []) {
    if (resource.resourceName && matchesQuery(resource.resourceName, queryWords)) {
      results.push({
        kind: 'resource',
        route: resource.routes[0] ?? null,
        title: resource.resourceName,
        excerpt: `${resource.kind} resource (${resource.status})`,
        resourceId: resource.resourceId,
      });
    }
  }

  return {
    available: true,
    message: results.length === 0 ? `No structured matches found for: ${query}` : null,
    query,
    results: results.slice(0, limit),
  };
}
