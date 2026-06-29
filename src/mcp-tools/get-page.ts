import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import type { MaterialDocsStore } from '../store.js';
import { findArtifactById } from '../raw-artifacts/artifact-index.js';
import { normalizeRouteInput, type GraphToolContext } from './context.js';

export type GetPageView = 'structured' | 'markdown' | 'raw-summary';

export type GetPageInput = {
  route: string;
  view: GetPageView;
  maxMarkdownChars?: number;
};

export type StructuredPagePayload = {
  pageId: string;
  route: string;
  title: string;
  section: string;
  tabs: Array<{ label: string; route: string }>;
  headings: string[];
  sections: Array<{ sectionId: string; title: string; headingLevel: number; chunkIds: string[] }>;
  chunks: Array<{ chunkId: string; chunkType: string; resourceId: string | null; textExcerpt: string | null }>;
  resourceIds: string[];
  tokenTableIds: string[];
  unsupportedChunkTypes: string[];
};

export type RawSummaryArtifactEntry = {
  artifactId: string;
  kind: ArtifactRecord['kind'];
  sourceUrl: string;
  sha256: string;
  fetchedAt: string;
  httpStatus: number | null;
};

export type GetPageResult = {
  available: boolean;
  message: string | null;
  found: boolean;
  view: GetPageView;
  route: string;
  structured?: StructuredPagePayload;
  markdown?: { meta: Record<string, unknown>; markdown: string };
  rawSummary?: { artifacts: RawSummaryArtifactEntry[]; sourceRoute: string | null; canonicalRoute: string | null; virtualRoute: string | null };
};

function findPageNode(context: GraphToolContext, normalizedRoute: string) {
  const pages = context.pageGraph?.pages ?? [];
  return pages.find((page) => page.route === normalizedRoute) ?? null;
}

/**
 * `route` + `view`: "structured" returns sections/chunks/resources/tokens in compact form from
 * graph/pages.json; "markdown" delegates to the existing MaterialDocsStore.getPage Markdown view;
 * "raw-summary" returns an artifact/provenance summary (ids, kinds, hashes, fetchedAt) without
 * dumping full raw JSON content.
 */
export async function getPage(
  context: GraphToolContext,
  store: MaterialDocsStore,
  input: GetPageInput
): Promise<GetPageResult> {
  const normalizedRoute = normalizeRouteInput(input.route);

  if (input.view === 'markdown') {
    try {
      const page = await store.getPage(input.route);
      const maxChars = input.maxMarkdownChars ?? 20_000;
      return {
        available: true,
        message: null,
        found: true,
        view: 'markdown',
        route: normalizedRoute,
        markdown: { meta: { ...page.meta, sourceUrl: page.meta.url }, markdown: page.markdown.slice(0, maxChars) },
      };
    } catch {
      return { available: true, message: `Markdown page not found: ${input.route}`, found: false, view: 'markdown', route: normalizedRoute };
    }
  }

  if (input.view === 'structured') {
    if (!context.pageGraph) {
      return {
        available: false,
        message: 'Material 3 documentation graph (graph/pages.json) is not available yet. Run refresh_material_docs, then retry.',
        found: false,
        view: 'structured',
        route: normalizedRoute,
      };
    }
    const page = findPageNode(context, normalizedRoute);
    if (!page) {
      return { available: true, message: `Structured page not found: ${normalizedRoute}`, found: false, view: 'structured', route: normalizedRoute };
    }
    return {
      available: true,
      message: null,
      found: true,
      view: 'structured',
      route: normalizedRoute,
      structured: {
        pageId: page.pageId,
        route: page.route,
        title: page.title,
        section: page.section,
        tabs: page.tabs,
        headings: page.headings,
        sections: page.sections,
        chunks: page.chunks,
        resourceIds: page.resourceIds,
        tokenTableIds: page.tokenTableIds,
        unsupportedChunkTypes: page.unsupportedChunkTypes,
      },
    };
  }

  // raw-summary
  if (!context.pageGraph) {
    return {
      available: false,
      message: 'Material 3 documentation graph (graph/pages.json) is not available yet. Run refresh_material_docs, then retry.',
      found: false,
      view: 'raw-summary',
      route: normalizedRoute,
    };
  }
  const page = findPageNode(context, normalizedRoute);
  if (!page) {
    return { available: true, message: `Page not found: ${normalizedRoute}`, found: false, view: 'raw-summary', route: normalizedRoute };
  }
  const artifacts: RawSummaryArtifactEntry[] = page.provenance.sourceArtifacts
    .map((ref) => findArtifactById(context.artifactIndex, ref.artifactId))
    .filter((record): record is ArtifactRecord => record !== null)
    .map((record) => ({
      artifactId: record.id,
      kind: record.kind,
      sourceUrl: record.sourceUrl,
      sha256: record.sha256,
      fetchedAt: record.fetchedAt,
      httpStatus: record.httpStatus,
    }));
  return {
    available: true,
    message: null,
    found: true,
    view: 'raw-summary',
    route: normalizedRoute,
    rawSummary: {
      artifacts,
      sourceRoute: page.provenance.sourceRoute,
      canonicalRoute: page.provenance.canonicalRoute,
      virtualRoute: page.provenance.virtualRoute,
    },
  };
}
