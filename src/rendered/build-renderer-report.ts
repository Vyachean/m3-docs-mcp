import type { ExtractionPageDiagnostic, MaterialPage } from '../types.js';
import { parseContentPage } from '../json-extraction/schemas.js';
import type { ProvenanceGraph } from '../graph/graph-types.js';
import {
  isRequiredRendererRoute,
  type RendererRouteReport,
  type RendererUnresolvedResource,
  type RendererUnresolvedTable,
  type RendererUnsupportedChunk,
} from './renderer-report.js';

/**
 * Pure derivation of a single route's `RendererRouteReport` from the already-produced
 * `MaterialPage` + `ExtractionPageDiagnostic` (extract-content-page.ts's
 * `JsonExtractionResult`) and the raw `contentPage` JSON it was rendered from. Takes no live
 * inputs — callers in both the hot crawl path (crawler.ts) and the from-raw rebuild path
 * (markdown-renderer.ts) call this identically, so the diagnostics shape never diverges between
 * "rendered during crawl" and "rendered from raw snapshot".
 */
export function buildRendererRouteReport({
  route,
  page,
  pageDiagnostic,
  contentPage,
  sourceArtifactIds
}: {
  route: string;
  page: MaterialPage | null;
  pageDiagnostic: ExtractionPageDiagnostic | null;
  /** Raw contentPage JSON (or null when unavailable) — used only to compute source section/heading
   *  counts for coverage diagnostics; never trusted directly, decoded via parseContentPage. */
  contentPage: unknown | null;
  sourceArtifactIds: string[];
}): RendererRouteReport {
  const decoded = contentPage !== null ? parseContentPage(contentPage) : null;
  const sourceSectionTitles = (decoded?.sections ?? []).map((section) => section.title.trim()).filter(Boolean);
  const renderedHeadings = (page?.headings ?? []).map((heading) => heading.trim());
  const renderedHeadingSet = new Set(renderedHeadings.map((heading) => heading.toLowerCase()));
  const droppedSectionTitles = sourceSectionTitles.filter((title) => !renderedHeadingSet.has(title.toLowerCase()));

  const sourceHeadingCount = (decoded?.title ? 1 : 0) + sourceSectionTitles.length;

  const unsupportedChunkTypes: RendererUnsupportedChunk[] = [];
  const unknownChunkCounts = new Map<string, number>();
  for (const chunkType of pageDiagnostic?.unknownChunkTypes ?? []) {
    unknownChunkCounts.set(chunkType, (unknownChunkCounts.get(chunkType) ?? 0) + 1);
  }

  const required = isRequiredRendererRoute(route);
  const errorSeverity = required ? 'error' : 'warning';

  for (const [chunkType, count] of unknownChunkCounts) {
    unsupportedChunkTypes.push({ chunkType, count, severity: errorSeverity });
  }

  const unresolvedResources: RendererUnresolvedResource[] = [];
  for (const resourceType of pageDiagnostic?.unknownResourceTypes ?? []) {
    unresolvedResources.push({
      resourceType,
      resourceName: null,
      reason: 'unsupported-resource-type',
      severity: errorSeverity,
    });
  }

  const unresolvedTables: RendererUnresolvedTable[] = [];
  const tokenPlaceholderCount = pageDiagnostic?.tokenTablesRenderedAsPlaceholder ?? 0;
  for (let i = 0; i < tokenPlaceholderCount; i += 1) {
    const reason = pageDiagnostic?.tokenTablePlaceholderReasons?.[i] ?? 'unresolved-token-table';
    unresolvedTables.push({ kind: 'token-table', resourceName: null, reason, severity: errorSeverity });
  }
  for (const diagnostic of pageDiagnostic?.statusTableDiagnostics ?? []) {
    if (diagnostic.renderedAsPlaceholder) {
      unresolvedTables.push({
        kind: 'status-table',
        resourceName: diagnostic.resourceName,
        reason: diagnostic.unsupportedSchema ? 'unsupported-status-table-schema' : 'unresolved-status-table',
        severity: errorSeverity,
      });
    }
  }

  const hasErrorFinding =
    unsupportedChunkTypes.some((f) => f.severity === 'error') ||
    unresolvedResources.some((f) => f.severity === 'error') ||
    unresolvedTables.some((f) => f.severity === 'error');

  return {
    route,
    renderedMarkdownPath: page?.path ?? null,
    sourceArtifactIds,
    unsupportedChunkTypes,
    unresolvedResources,
    unresolvedTables,
    sectionCoverage: {
      sourceSectionCount: sourceSectionTitles.length,
      renderedSectionCount: sourceSectionTitles.length - droppedSectionTitles.length,
      droppedSectionTitles,
    },
    headingCoverage: {
      sourceHeadingCount,
      renderedHeadingCount: renderedHeadings.length,
    },
    isRequiredRoute: required,
    severity: hasErrorFinding ? 'error' : 'warning',
  };
}

export function collectRequiredRouteFailures(routes: RendererRouteReport[]): string[] {
  return routes.filter((route) => route.isRequiredRoute && route.severity === 'error').map((route) => route.route);
}

/** Finds the artifact ids recorded for a given provenance subject (e.g. "page:<pageId>" or
 *  "route:<route>"), or an empty array when no provenance entry exists for it. */
export function artifactIdsForSubject(provenance: ProvenanceGraph | null, subject: string): string[] {
  if (!provenance) return [];
  const entry = provenance.entries.find((e) => e.subject === subject);
  return entry ? entry.sourceArtifacts.map((ref) => ref.artifactId) : [];
}
