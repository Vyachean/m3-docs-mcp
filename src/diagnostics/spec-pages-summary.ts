import type { PageGraph } from '../graph/graph-types.js';

export type SpecPagesSummary = {
  schemaVersion: 1;
  generatedAt: string;
  /** Total count of all /specs pages (including non-component specs such as /styles/motion/overview/specs). */
  specPageCount: number;
  /** Count of all /specs pages that have at least one token table. */
  specPagesWithTokenTables: number;
  /** Routes of all /specs pages that have no token tables.
   *  Includes non-component specs pages (e.g. /styles/motion/overview/specs) as well as
   *  component specs pages. See componentSpecPagesWithoutTokenTables for the component-only subset. */
  specPagesWithoutTokenTables: string[];
  specPagesMissingGraphPage: string[];
  specPagesWithEmptySections: string[];
  specPagesWithEmptyChunks: string[];
  specPagesWithEmptyResources: string[];
  /** Count of /components/...\/specs pages only (component specs subset). */
  componentSpecPageCount: number;
  /** Count of /components/...\/specs pages that have at least one token table. */
  componentSpecPagesWithTokenTables: number;
  /** Routes of /components/...\/specs pages that have no token tables. */
  componentSpecPagesWithoutTokenTables: string[];
};

function isSpecsRoute(route: string): boolean {
  return route === '/specs' || route.endsWith('/specs');
}

function isComponentSpecsRoute(route: string): boolean {
  return route.startsWith('/components/') && (route === '/components/specs' || route.endsWith('/specs'));
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
    .map(routeFromMarkdownPath)
    .filter((route) => !specGraphRouteSet.has(route));

  let specPagesWithTokenTables = 0;
  const specPagesWithoutTokenTables: string[] = [];
  const specPagesWithEmptySections: string[] = [];
  const specPagesWithEmptyChunks: string[] = [];
  const specPagesWithEmptyResources: string[] = [];

  let componentSpecPageCount = 0;
  let componentSpecPagesWithTokenTables = 0;
  const componentSpecPagesWithoutTokenTables: string[] = [];

  for (const page of specGraphPages) {
    const tokenTableIds = page.tokenTableIds ?? [];
    const sections = page.sections ?? [];
    const chunks = page.chunks ?? [];
    const resourceIds = page.resourceIds ?? [];
    const hasTokenTables = tokenTableIds.length > 0;
    const isComponentSpec = isComponentSpecsRoute(page.route);

    if (hasTokenTables) {
      specPagesWithTokenTables++;
    } else {
      specPagesWithoutTokenTables.push(page.route);
    }

    if (isComponentSpec) {
      componentSpecPageCount++;
      if (hasTokenTables) {
        componentSpecPagesWithTokenTables++;
      } else {
        componentSpecPagesWithoutTokenTables.push(page.route);
      }
    }

    if (sections.length === 0) specPagesWithEmptySections.push(page.route);
    if (chunks.length === 0) specPagesWithEmptyChunks.push(page.route);
    if (resourceIds.length === 0) specPagesWithEmptyResources.push(page.route);
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
    componentSpecPageCount,
    componentSpecPagesWithTokenTables,
    componentSpecPagesWithoutTokenTables,
  };
}
