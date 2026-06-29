import { materialPagePath } from '../crawler-utils.js';
import { extractBundleRouteTable, extractCarbonVersion, type BundleRouteEntry } from '../json-extraction/page-reference-resolver.js';
import { readArtifactText } from '../raw-artifacts/artifact-store.js';
import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import { normalizeTabSlug } from '../route-coverage.js';
import type { ExtractionRouteDiagnostic, MaterialIndex } from '../types.js';
import {
  type PageChunkNode,
  type PageGraph,
  type PageNode,
  type PageSectionNode,
  type ResourceGraph,
  type ResourceNode,
  type RouteGraph,
  type RouteNode,
  type SourceArtifactRef,
} from './graph-types.js';
import {
  imageResourceId,
  statusTableResourceId,
  tokenTableResourceId,
  unknownResourceId,
  videoResourceId,
} from './resource-identity.js';

type RawCarbonChunk = {
  pageContentChunkId: string | null;
  pageContentChunkCanonId: string | null;
  htmlValue: string | null;
  footer: string | null;
  imageUrl: string | null;
  imageUrlFife: string | null;
  altText: string | null;
  videoUrl: string | null;
  resourceName: string | null;
  libraryModuleType: string | null;
  contentChunkType: string | null;
};

type RawCarbonBlock = {
  pageContentBlockId: string | null;
  pageContentBlockCanonId: string | null;
  title: string | null;
  chunks: RawCarbonChunk[];
};

type RawCarbonSection = {
  pageSectionId: string | null;
  pageSectionCanonId: string | null;
  name: string;
  position: number | null;
  blocks: RawCarbonBlock[];
};

type RawCarbonPage = {
  pageId: string | null;
  pageCanonId: string | null;
  title: string | null;
  slug: string | null;
  sections: RawCarbonSection[];
};

type RawResourceEntry = {
  resourceId: string;
  kind: ResourceNode['kind'];
  resourceName: string | null;
  sourceArtifact: SourceArtifactRef | null;
  route: string;
  pageId: string;
  sectionId: string | null;
  chunkId: string;
  status: ResourceNode['status'];
  unresolvedReason: string | null;
};

type RawPageBuild = {
  page: PageNode;
  resources: RawResourceEntry[];
  matchedSectionId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toSourceArtifactRef(artifact: ArtifactRecord): SourceArtifactRef | null {
  if (artifact.kind === 'page-data' || artifact.kind === 'carbon-content' || artifact.kind === 'dsdb-resource' || artifact.kind === 'network-capture') {
    return { artifactId: artifact.id, kind: artifact.kind };
  }
  return null;
}

function stripHtml(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h1|h2|h3|h4|h5|h6|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

function extractHtmlHeadings(html: string | null): Array<{ level: number; title: string }> {
  if (!html) return [];
  const headings: Array<{ level: number; title: string }> = [];
  for (const match of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const level = Number(match[1] ?? '0');
    const title = stripHtml(match[2] ?? null);
    if (Number.isFinite(level) && title) headings.push({ level, title });
  }
  return headings;
}

function chunkStableId(chunk: RawCarbonChunk, fallbackPrefix: string, index: number): string {
  return chunk.pageContentChunkCanonId ?? chunk.pageContentChunkId ?? `${fallbackPrefix}:${index}`;
}

function blockStableId(block: RawCarbonBlock, fallbackPrefix: string, index: number): string {
  return block.pageContentBlockCanonId ?? block.pageContentBlockId ?? `${fallbackPrefix}:${index}`;
}

function sectionStableId(section: RawCarbonSection, fallbackPrefix: string, index: number): string {
  return section.pageSectionCanonId ?? section.pageSectionId ?? `${fallbackPrefix}:${index}`;
}

function decodeCarbonPage(raw: unknown): RawCarbonPage | null {
  if (!isRecord(raw)) return null;
  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  const sections: RawCarbonSection[] = [];
  for (const rawSection of rawSections) {
    if (!isRecord(rawSection)) continue;
    if (readBoolean(rawSection.isVisible) === false) continue;
    const rawBlocks = Array.isArray(rawSection.contentBlocks) ? rawSection.contentBlocks : [];
    const blocks: RawCarbonBlock[] = [];
    for (const rawBlock of rawBlocks) {
      if (!isRecord(rawBlock)) continue;
      if (readBoolean(rawBlock.isHidden) === true) continue;
      const rawChunks = Array.isArray(rawBlock.contentChunks) ? rawBlock.contentChunks : [];
      const chunks: RawCarbonChunk[] = [];
      for (const rawChunk of rawChunks) {
        if (!isRecord(rawChunk)) continue;
        chunks.push({
          pageContentChunkId: readString(rawChunk.pageContentChunkId),
          pageContentChunkCanonId: readString(rawChunk.pageContentChunkCanonId),
          htmlValue: readString(rawChunk.htmlValue),
          footer: readString(rawChunk.footer),
          imageUrl: readString(rawChunk.imageUrl),
          imageUrlFife: readString(rawChunk.imageUrlFife),
          altText: readString(rawChunk.altText),
          videoUrl: readString(rawChunk.videoUrl),
          resourceName: readString(rawChunk.resourceName),
          libraryModuleType: readString(rawChunk.libraryModuleType),
          contentChunkType: readString(rawChunk.contentChunkType),
        });
      }
      blocks.push({
        pageContentBlockId: readString(rawBlock.pageContentBlockId),
        pageContentBlockCanonId: readString(rawBlock.pageContentBlockCanonId),
        title: readString(rawBlock.title),
        chunks,
      });
    }
    sections.push({
      pageSectionId: readString(rawSection.pageSectionId),
      pageSectionCanonId: readString(rawSection.pageSectionCanonId),
      name: readString(rawSection.name) ?? 'Section',
      position: readNumber(rawSection.position),
      blocks,
    });
  }
  return {
    pageId: readString(raw.pageId),
    pageCanonId: readString(raw.pageCanonId),
    title: readString(raw.title),
    slug: readString(raw.slug),
    sections,
  };
}

function findDsdbArtifact(
  dsdbArtifactsByTrailingSegment: Map<string, ArtifactRecord[]>,
  resourceName: string | null
): ArtifactRecord | null {
  if (!resourceName) return null;
  const trailing = resourceName.split('/').filter(Boolean).at(-1) ?? resourceName;
  return dsdbArtifactsByTrailingSegment.get(trailing)?.[0] ?? null;
}

function routeSectionFromPath(route: string): string {
  return route.replace(/^\/+/, '').split('/')[0] ?? '';
}

function buildRawPage(
  diagnostic: ExtractionRouteDiagnostic,
  carbon: RawCarbonPage,
  carbonArtifact: ArtifactRecord,
  artifactsBySourceRoute: Map<string, ArtifactRecord[]>,
  dsdbArtifactsByTrailingSegment: Map<string, ArtifactRecord[]>
): RawPageBuild | null {
  const sourceRoute = diagnostic.sourceRoute ?? diagnostic.normalizedRoute ?? diagnostic.virtualRoute;
  if (!sourceRoute) return null;
  const route = diagnostic.virtualRoute ?? sourceRoute;

  let selectedSections = carbon.sections;
  if (diagnostic.virtualSource === 'tab') {
    if (diagnostic.tabMatchedSectionIndex != null && carbon.sections[diagnostic.tabMatchedSectionIndex]) {
      selectedSections = [carbon.sections[diagnostic.tabMatchedSectionIndex]!];
    } else if (diagnostic.tabName) {
      const normalizedTab = diagnostic.tabName.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const matched = carbon.sections.find((section) =>
        section.name.toLowerCase().replace(/[^a-z0-9]+/g, '') === normalizedTab
      );
      selectedSections = matched ? [matched] : [];
    } else {
      selectedSections = [];
    }
  }
  if (selectedSections.length === 0) return null;

  const sourceArtifacts = (artifactsBySourceRoute.get(sourceRoute) ?? [])
    .map(toSourceArtifactRef)
    .filter((ref): ref is SourceArtifactRef => ref !== null);

  const pageIdBase = carbon.pageId ?? carbon.pageCanonId ?? route;
  const matchedSection = selectedSections[0]!;
  const pageId = diagnostic.virtualSource === 'tab'
    ? `${pageIdBase}:${sectionStableId(matchedSection, route, matchedSection.position ?? 0)}`
    : pageIdBase;

  const chunkNodes: PageChunkNode[] = [];
  const pageSections: PageSectionNode[] = [];
  const headings = [carbon.title ?? diagnostic.tabName ?? route.split('/').at(-1) ?? route];
  const resourceIds: string[] = [];
  const tokenTableIds: string[] = [];
  const unsupportedChunkTypes: string[] = [];
  const resources: RawResourceEntry[] = [];

  selectedSections.forEach((section, sectionIndex) => {
    const sectionId = sectionStableId(section, `${route}:section`, sectionIndex);
    const chunkIds: string[] = [];
    pageSections.push({
      sectionId,
      title: section.name,
      headingLevel: 2,
      chunkIds,
    });
    if (!headings.includes(section.name)) headings.push(section.name);

    section.blocks.forEach((block, blockIndex) => {
      if (block.title && !headings.includes(block.title)) headings.push(block.title);
      const blockId = blockStableId(block, `${sectionId}:block`, blockIndex);
      block.chunks.forEach((chunk, chunkIndex) => {
        const chunkId = chunkStableId(chunk, `${blockId}:chunk`, chunkIndex);
        const rawType = (chunk.contentChunkType ?? '').toUpperCase();
        let chunkType: PageChunkNode['chunkType'] = 'unsupported';
        let resourceId: string | null = null;
        let textExcerpt: string | null = stripHtml(chunk.htmlValue) ?? chunk.footer ?? chunk.altText ?? null;

        if (rawType === 'TEXT' || rawType === '') {
          chunkType = 'text';
          for (const heading of extractHtmlHeadings(chunk.htmlValue)) {
            if (!headings.includes(heading.title)) headings.push(heading.title);
            pageSections.push({
              sectionId: `${chunkId}:heading`,
              title: heading.title,
              headingLevel: heading.level,
              chunkIds: [chunkId],
            });
          }
        } else if (rawType === 'IMAGE') {
          chunkType = 'image';
          resourceId = chunk.imageUrl ? `image:${chunk.imageUrl}` : imageResourceId(route, chunkIndex);
          resources.push({
            resourceId,
            kind: 'image',
            resourceName: chunk.imageUrl ?? chunk.imageUrlFife,
            sourceArtifact: null,
            route,
            pageId,
            sectionId,
            chunkId,
            status: 'resolved',
            unresolvedReason: null,
          });
        } else if (rawType === 'VIDEO') {
          chunkType = 'video';
          resourceId = chunk.videoUrl ? `video:${chunk.videoUrl}` : videoResourceId(route, chunkIndex);
          resources.push({
            resourceId,
            kind: 'video',
            resourceName: chunk.videoUrl,
            sourceArtifact: null,
            route,
            pageId,
            sectionId,
            chunkId,
            status: 'resolved',
            unresolvedReason: null,
          });
        } else if (rawType === 'RESOURCE') {
          chunkType = 'resource';
          const moduleType = chunk.libraryModuleType ?? 'UNKNOWN_RESOURCE';
          if (moduleType === 'TOKEN_TABLE') {
            resourceId = tokenTableResourceId(route, chunkIndex, chunk.resourceName);
            if (!tokenTableIds.includes(resourceId)) tokenTableIds.push(resourceId);
            const dsdbArtifact = findDsdbArtifact(dsdbArtifactsByTrailingSegment, chunk.resourceName);
            resources.push({
              resourceId,
              kind: 'token-table',
              resourceName: chunk.resourceName,
              sourceArtifact: dsdbArtifact ? toSourceArtifactRef(dsdbArtifact) : null,
              route,
              pageId,
              sectionId,
              chunkId,
              status: dsdbArtifact ? 'resolved' : 'unresolved',
              unresolvedReason: dsdbArtifact ? null : 'missing-token-table-resource',
            });
          } else if (moduleType === 'STATUS_TABLE') {
            resourceId = statusTableResourceId(route, chunkIndex, chunk.resourceName);
            const dsdbArtifact = findDsdbArtifact(dsdbArtifactsByTrailingSegment, chunk.resourceName);
            resources.push({
              resourceId,
              kind: 'status-table',
              resourceName: chunk.resourceName,
              sourceArtifact: dsdbArtifact ? toSourceArtifactRef(dsdbArtifact) : null,
              route,
              pageId,
              sectionId,
              chunkId,
              status: dsdbArtifact ? 'resolved' : 'unresolved',
              unresolvedReason: dsdbArtifact ? null : 'missing-status-table-resource',
            });
          } else {
            resourceId = unknownResourceId(route, chunkIndex);
            resources.push({
              resourceId,
              kind: 'unknown-resource',
              resourceName: chunk.resourceName ?? moduleType,
              sourceArtifact: null,
              route,
              pageId,
              sectionId,
              chunkId,
              status: 'unresolved',
              unresolvedReason: `unknown-resource-type:${moduleType}`,
            });
            if (!unsupportedChunkTypes.includes(moduleType)) unsupportedChunkTypes.push(moduleType);
          }
        } else {
          if (!unsupportedChunkTypes.includes(rawType)) unsupportedChunkTypes.push(rawType);
          textExcerpt = textExcerpt ?? rawType;
        }

        if (resourceId && !resourceIds.includes(resourceId)) resourceIds.push(resourceId);
        chunkIds.push(chunkId);
        chunkNodes.push({ chunkId, chunkType, resourceId, textExcerpt });
      });
    });
  });

  const page: PageNode = {
    pageId,
    route,
    title: carbon.title ?? headings[0] ?? route,
    section: routeSectionFromPath(route),
    tabs: diagnostic.tabName && diagnostic.virtualRoute
      ? [{ label: diagnostic.tabName, route: diagnostic.virtualRoute, sectionIndex: diagnostic.tabMatchedSectionIndex ?? null }]
      : [],
    headings,
    sections: pageSections,
    chunks: chunkNodes,
    resourceIds,
    tokenTableIds,
    unsupportedChunkTypes,
    provenance: {
      sourceArtifacts: [
        ...sourceArtifacts,
        ...(toSourceArtifactRef(carbonArtifact) ? [toSourceArtifactRef(carbonArtifact)!] : []),
      ],
      sourceRoute,
      canonicalRoute: diagnostic.canonicalRoute ?? sourceRoute,
      virtualRoute: diagnostic.virtualRoute ?? null,
    },
  };

  return { page, resources, matchedSectionId: sectionStableId(matchedSection, `${route}:section`, 0) };
}

function buildCoverageForVirtualRoute(baseUrl: string, route: string, parentCoverage: RouteNode['coverage'], parentGenerated: string[]): Pick<RouteNode, 'expectedOutputPaths' | 'generatedOutputPaths' | 'coverage'> {
  const expectedOutput = materialPagePath(new URL(route, baseUrl).toString());
  const generatedOutputPaths = parentGenerated.filter((path) => path === expectedOutput);
  const savedOutputPaths = parentCoverage.savedOutputPaths.filter((path) => path === expectedOutput);
  const failedOutputPaths = parentCoverage.failedOutputPaths.filter((path) => path === expectedOutput);
  const skippedOutputPaths = parentCoverage.skippedOutputPaths.filter((path) => path === expectedOutput);
  const status = savedOutputPaths.length > 0
    ? 'covered'
    : failedOutputPaths.length > 0
      ? 'failed'
      : skippedOutputPaths.length > 0
        ? 'skipped'
        : 'unresolved';
  return {
    expectedOutputPaths: [expectedOutput],
    generatedOutputPaths,
    coverage: {
      ...parentCoverage,
      status,
      originalStatus: status,
      expectedOutputPaths: [expectedOutput],
      savedOutputPaths,
      failedOutputPaths,
      skippedOutputPaths,
      sharedWithRoutes: [],
      sharedCoverageGroup: null,
    },
  };
}

export async function enrichGraphFromRawArtifacts(params: {
  cacheDir: string;
  artifactRecords: ArtifactRecord[];
  routeGraph: RouteGraph;
  legacyPageGraph: PageGraph;
  legacyResourceGraph: ResourceGraph;
  index: MaterialIndex;
}): Promise<{
  routeGraph: RouteGraph;
  pageGraph: PageGraph;
  resourceGraph: ResourceGraph;
}> {
  const { cacheDir, artifactRecords, legacyPageGraph, legacyResourceGraph, index } = params;
  const routeGraph: RouteGraph = {
    ...params.routeGraph,
    routes: params.routeGraph.routes.map((route) => ({
      ...route,
      reference: { ...route.reference },
      tabs: route.tabs.map((tab) => ({ ...tab })),
      sourceArtifacts: [...route.sourceArtifacts],
      expectedOutputPaths: [...route.expectedOutputPaths],
      generatedOutputPaths: [...route.generatedOutputPaths],
      coverage: { ...route.coverage, reasons: [...route.coverage.reasons], expectedOutputPaths: [...route.coverage.expectedOutputPaths], savedOutputPaths: [...route.coverage.savedOutputPaths], failedOutputPaths: [...route.coverage.failedOutputPaths], skippedOutputPaths: [...route.coverage.skippedOutputPaths], sharedWithRoutes: [...route.coverage.sharedWithRoutes] },
    })),
  };

  const artifactsBySourceRoute = new Map<string, ArtifactRecord[]>();
  const dsdbArtifactsByTrailingSegment = new Map<string, ArtifactRecord[]>();
  let carbonVersion: string | null = null;
  const bundleEntriesByRoute = new Map<string, BundleRouteEntry>();
  const bundleEntriesByAlias = new Map<string, BundleRouteEntry>();
  const carbonBySourceRoute = new Map<string, { page: RawCarbonPage; artifact: ArtifactRecord }>();

  for (const artifact of artifactRecords) {
    if (artifact.sourceRoute) {
      const list = artifactsBySourceRoute.get(artifact.sourceRoute);
      if (list) list.push(artifact);
      else artifactsBySourceRoute.set(artifact.sourceRoute, [artifact]);
    }
    if (artifact.kind === 'dsdb-resource') {
      const trailing = artifact.localPath.replace(/\.json$/i, '').split('/').filter(Boolean).at(-1) ?? artifact.localPath;
      const list = dsdbArtifactsByTrailingSegment.get(trailing);
      if (list) list.push(artifact);
      else dsdbArtifactsByTrailingSegment.set(trailing, [artifact]);
    }
    if (artifact.kind === 'angular-bundle') {
      const bundleText = await readArtifactText(artifact.localPath, cacheDir);
      carbonVersion = extractCarbonVersion(bundleText);
      for (const entry of extractBundleRouteTable(bundleText)) {
        const route = `/${entry.slug.replace(/^\/+/, '')}`;
        bundleEntriesByRoute.set(route, entry);
        for (const alias of entry.alternateSlugs ?? []) {
          bundleEntriesByAlias.set(`/${alias.replace(/^\/+/, '')}`, entry);
        }
      }
    }
    if (artifact.kind === 'carbon-content' && artifact.sourceRoute) {
      const raw = JSON.parse(await readArtifactText(artifact.localPath, cacheDir)) as unknown;
      const page = decodeCarbonPage(raw);
      if (page) carbonBySourceRoute.set(artifact.sourceRoute, { page, artifact });
    }
  }

  const routeByRoute = new Map(routeGraph.routes.map((route) => [route.route, route]));
  const virtualRoutes: RouteNode[] = [];
  for (const route of routeGraph.routes) {
    const entry = bundleEntriesByRoute.get(route.route) ?? bundleEntriesByRoute.get(route.canonicalRoute ?? '') ?? bundleEntriesByAlias.get(route.route) ?? bundleEntriesByAlias.get(route.canonicalRoute ?? '');
    const carbonPage = carbonBySourceRoute.get(route.route)?.page ?? carbonBySourceRoute.get(route.canonicalRoute ?? '')?.page ?? null;
    if (entry) {
      route.reference.collectionId = entry.collectionId ?? route.reference.collectionId;
      route.reference.documentId = entry.documentId ?? route.reference.documentId;
      route.reference.exportedCarbonFileId = entry.exportedCarbonFileId ?? route.reference.exportedCarbonFileId;
      route.reference.pageCanonId = carbonPage?.pageCanonId ?? entry.pageCanonId ?? route.reference.pageCanonId;
      route.reference.carbonVersion = carbonVersion ?? route.reference.carbonVersion;
      route.aliases = Array.from(new Set([...(route.aliases ?? []), ...(entry.alternateSlugs ?? []).map((alias) => `/${alias.replace(/^\/+/, '')}`)]));
      const existingMatchedBySlug = new Map(route.tabs.map((tab) => [tab.slug, tab]));
      route.tabs = (entry.tabs ?? []).map((tab, index) => {
        const slug = normalizeTabSlug(tab);
        const base = route.canonicalRoute ?? route.route;
        const existing = existingMatchedBySlug.get(slug);
        return {
          label: tab.label,
          route: `${base}/${slug}`,
          slug,
          matchedSectionId: existing?.matchedSectionId ?? null,
          matchReason: existing?.matchReason ?? 'unmatched',
        };
      });
    }
    for (const tab of route.tabs) {
      if (routeByRoute.has(tab.route)) continue;
      const narrowed = buildCoverageForVirtualRoute(routeGraph.baseUrl, tab.route, route.coverage, route.generatedOutputPaths);
      virtualRoutes.push({
        route: tab.route,
        canonicalRoute: tab.route,
        aliases: [],
        title: route.title,
        section: route.section,
        reference: { ...route.reference },
        tabs: route.tabs.map((item) => ({ ...item })),
        origins: [...route.origins],
        sourceArtifacts: [...route.sourceArtifacts],
        expectedOutputPaths: narrowed.expectedOutputPaths,
        generatedOutputPaths: narrowed.generatedOutputPaths,
        coverage: narrowed.coverage,
      });
    }
  }
  routeGraph.routes.push(...virtualRoutes);
  for (const route of virtualRoutes) routeByRoute.set(route.route, route);

  const rawPagesByRoute = new Map<string, RawPageBuild>();
  const rawPageBuilds: RawPageBuild[] = [];
  for (const diagnostic of index.extractionDiagnostics?.routeDiagnostics ?? []) {
    if (diagnostic.sourceUsed !== 'direct-json') continue;
    const sourceRoute = diagnostic.sourceRoute ?? diagnostic.normalizedRoute ?? null;
    if (!sourceRoute) continue;
    const carbon = carbonBySourceRoute.get(sourceRoute);
    if (!carbon) continue;
    const built = buildRawPage(diagnostic, carbon.page, carbon.artifact, artifactsBySourceRoute, dsdbArtifactsByTrailingSegment);
    if (!built) continue;
    rawPagesByRoute.set(built.page.route, built);
    rawPageBuilds.push(built);
    const parentRoute = routeByRoute.get(sourceRoute);
    const parentTab = parentRoute?.tabs.find((tab) => tab.route === built.page.route);
    if (parentTab) {
      parentTab.matchedSectionId = built.matchedSectionId;
      parentTab.matchReason = diagnostic.tabMatchedBy ?? parentTab.matchReason;
    }
    const virtualRouteNode = routeByRoute.get(built.page.route);
    if (virtualRouteNode && built.matchedSectionId) {
      const matchingTab = virtualRouteNode.tabs.find((tab) => tab.route === built.page.route);
      if (matchingTab) {
        matchingTab.matchedSectionId = built.matchedSectionId;
        matchingTab.matchReason = diagnostic.tabMatchedBy ?? matchingTab.matchReason;
      }
    }
  }

  const mergedPages: PageNode[] = [];
  for (const legacyPage of legacyPageGraph.pages) {
    const raw = rawPagesByRoute.get(legacyPage.route);
    mergedPages.push(raw ? raw.page : legacyPage);
    rawPagesByRoute.delete(legacyPage.route);
  }
  mergedPages.push(...Array.from(rawPagesByRoute.values()).map((entry) => entry.page));
  const pageGraph: PageGraph = { ...legacyPageGraph, pages: mergedPages };

  const resourceById = new Map<string, ResourceNode>(legacyResourceGraph.resources.map((resource) => [
    resource.resourceId,
    {
      ...resource,
      routes: [...resource.routes],
      pageIds: [...resource.pageIds],
      chunkIds: [...resource.chunkIds],
    },
  ]));
  for (const raw of rawPageBuilds) {
    for (const resource of raw.resources) {
      const existing = resourceById.get(resource.resourceId);
      if (existing) {
        if (!existing.routes.includes(resource.route)) existing.routes.push(resource.route);
        if (!existing.pageIds.includes(resource.pageId)) existing.pageIds.push(resource.pageId);
        if (!existing.chunkIds.includes(resource.chunkId)) existing.chunkIds.push(resource.chunkId);
        if (existing.status === 'resolved' || resource.status === 'resolved') {
          existing.status = 'resolved';
          existing.unresolvedReason = null;
        }
        if (!existing.sourceArtifact && resource.sourceArtifact) existing.sourceArtifact = resource.sourceArtifact;
        if (!existing.resourceName && resource.resourceName) existing.resourceName = resource.resourceName;
      } else {
        resourceById.set(resource.resourceId, {
          resourceId: resource.resourceId,
          kind: resource.kind,
          resourceName: resource.resourceName,
          sourceArtifact: resource.sourceArtifact,
          routes: [resource.route],
          pageIds: [resource.pageId],
          chunkIds: [resource.chunkId],
          status: resource.status,
          unresolvedReason: resource.unresolvedReason,
        });
      }
    }
  }
  for (const page of pageGraph.pages) {
    for (const chunk of page.chunks) {
      if (!chunk.resourceId) continue;
      const resource = resourceById.get(chunk.resourceId);
      if (resource && !resource.pageIds.includes(page.pageId)) resource.pageIds.push(page.pageId);
      if (resource && !resource.routes.includes(page.route)) resource.routes.push(page.route);
    }
  }
  const resourceGraph: ResourceGraph = { ...legacyResourceGraph, resources: Array.from(resourceById.values()) };

  return { routeGraph, pageGraph, resourceGraph };
}
