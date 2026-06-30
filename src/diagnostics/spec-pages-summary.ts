import type { PageGraph } from '../graph/graph-types.js';

export type SpecPagesSummary = {
  schemaVersion: 1;
  generatedAt: string;
  specPageCount: number;
  specPagesWithTokenTables: number;
  specPagesWithoutTokenTables: string[];
  specPagesMissingGraphPage: string[];
  specPagesWithEmptySections: string[];
  specPagesWithEmptyChunks: string[];
  specPagesWithEmptyResources: string[];
};

function isSpecsRoute(route: string): boolean {
  return route === '/specs' || route.endsWith('/specs');
}

function isSpecsMarkdownPath(pagePath: string): boolean {
  const normalized = pagePath.replace(/^\/+/, '');
  return normalized === 'specs.md' || normalized.endsWith('/specs.md');
}

function routeFromMarkdownPath(markdownPath: string): string {
  const withoutMd = markdownPath.replace(/\.md$/i, '');
  const withoutLeadingSlash = withoutMd.replace(/^\/+/, '');
  return `/${withoutLeadingSlash}`;
}

export function buildSpecPagesSummary(params: {
  pageGraph: PageGraph;
  markdownPagePaths: Iterable<string>;
  generatedAt?: string;
}): SpecPagesSummary {
  const { pageGraph, markdownPagePaths, generatedAt = new Date().toISOString() } = params;

  const specGraphPages = pageGraph.pages.filter((p) => isSpecsRoute(p.route));
  const specGraphRouteSet = new Set(specGraphPages.map((p) => p.route));

  const specMdPaths: string[] = [];
  for (const mdPath of markdownPagePaths) {
    if (isSpecsMarkdownPath(mdPath)) {
      specMdPaths.push(mdPath);
    }
  }

  const specPagesMissingGraphPage: string[] = specMdPaths
    .filter((mdPath) => !specGraphRouteSet.has(routeFromMarkdownPath(mdPath)))
    .map((mdPath) => routeFromMarkdownPath(mdPath));

  let specPagesWithTokenTables = 0;
  const specPagesWithoutTokenTables: string[] = [];
  const specPagesWithEmptySections: string[] = [];
  const specPagesWithEmptyChunks: string[] = [];
  const specPagesWithEmptyResources: string[] = [];

  for (const page of specGraphPages) {
    if (page.tokenTableIds.length > 0) {
      specPagesWithTokenTables++;
    } else {
      specPagesWithoutTokenTables.push(page.route);
    }

    if (page.sections.length === 0) specPagesWithEmptySections.push(page.route);
    if (page.chunks.length === 0) specPagesWithEmptyChunks.push(page.route);
    if (page.resourceIds.length === 0) specPagesWithEmptyResources.push(page.route);
  }

  const specPageCount = specGraphPages.length + specPagesMissingGraphPage.length;

  return {
    schemaVersion: 1,
    generatedAt,
    specPageCount,
    specPagesWithTokenTables,
    specPagesWithoutTokenTables,
    specPagesMissingGraphPage,
    specPagesWithEmptySections,
    specPagesWithEmptyChunks,
    specPagesWithEmptyResources,
  };
}
