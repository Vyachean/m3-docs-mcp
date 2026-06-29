import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractContentPageToMaterialPage } from '../src/json-extraction/extract-content-page.js';
import { artifactIdsForSubject, buildRendererRouteReport, collectRequiredRouteFailures } from '../src/rendered/build-renderer-report.js';
import type { RendererRouteReport } from '../src/rendered/renderer-report.js';

const fixture = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/json-extraction', name), 'utf8'));

describe('buildRendererRouteReport', () => {
  it('records unsupported chunk types and unresolved resources as warnings on a non-required route', async () => {
    const contentPage = fixture('content-unknown.json');
    const extraction = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/experimental',
      pageData: null,
      contentPage,
      fetchResource: async () => null
    });

    const report = buildRendererRouteReport({
      route: '/foundations/experimental',
      page: extraction.page,
      pageDiagnostic: extraction.pageDiagnostic,
      contentPage,
      sourceArtifactIds: ['carbon-content:raw/carbon-content/v1/x.json']
    });

    expect(report.isRequiredRoute).toBe(false);
    expect(report.unsupportedChunkTypes.length).toBeGreaterThan(0);
    expect(report.unsupportedChunkTypes.every((f) => f.severity === 'warning')).toBe(true);
    expect(report.unresolvedResources.some((f) => f.resourceType === 'EXPERIMENTAL_GRID')).toBe(true);
    expect(report.unresolvedResources.every((f) => f.severity === 'warning')).toBe(true);
    expect(report.severity).toBe('warning');
    expect(report.sourceArtifactIds).toEqual(['carbon-content:raw/carbon-content/v1/x.json']);
  });

  it('escalates the same findings to error severity on a required route, and surfaces it via collectRequiredRouteFailures', async () => {
    const contentPage = fixture('content-status-table.json');
    // No fetchResource match -> STATUS_TABLE resource resolves to null -> rendered as a placeholder.
    const extraction = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/switch/specs',
      pageData: null,
      contentPage,
      fetchResource: async () => null
    });

    const report = buildRendererRouteReport({
      route: '/components/switch/specs',
      page: extraction.page,
      pageDiagnostic: extraction.pageDiagnostic,
      contentPage,
      sourceArtifactIds: []
    });

    expect(report.isRequiredRoute).toBe(true);
    expect(report.unresolvedTables.length).toBeGreaterThan(0);
    expect(report.unresolvedTables[0]?.kind).toBe('status-table');
    expect(report.unresolvedTables.every((f) => f.severity === 'error')).toBe(true);
    expect(report.severity).toBe('error');

    expect(collectRequiredRouteFailures([report])).toEqual(['/components/switch/specs']);
  });

  it('reports section/heading coverage gaps when a decoded section title is not rendered as a heading', () => {
    const contentPage = {
      title: 'Demo',
      sections: [
        { name: 'Overview', isVisible: true, contentBlocks: [] },
        { name: 'Accessibility', isVisible: true, contentBlocks: [] }
      ]
    };
    const report = buildRendererRouteReport({
      route: '/demo',
      page: {
        id: 'demo',
        title: 'Demo',
        url: 'https://m3.material.io/demo',
        path: 'demo.md',
        section: 'demo',
        headings: ['Demo', 'Overview'],
        text: 'Demo Overview',
        markdown: '# Demo\n\n## Overview',
        capturedAt: '2026-06-29T00:00:00.000Z'
      },
      pageDiagnostic: null,
      contentPage,
      sourceArtifactIds: []
    });

    expect(report.sectionCoverage.sourceSectionCount).toBe(2);
    expect(report.sectionCoverage.renderedSectionCount).toBe(1);
    expect(report.sectionCoverage.droppedSectionTitles).toEqual(['Accessibility']);
    expect(report.headingCoverage.sourceHeadingCount).toBe(3); // title + 2 sections
    expect(report.headingCoverage.renderedHeadingCount).toBe(2);
  });

  it('reports renderedMarkdownPath: null and no findings when no page was produced (e.g. route never rendered from raw)', () => {
    const report = buildRendererRouteReport({
      route: '/some/route',
      page: null,
      pageDiagnostic: null,
      contentPage: null,
      sourceArtifactIds: []
    });

    expect(report.renderedMarkdownPath).toBeNull();
    expect(report.severity).toBe('warning');
    expect(report.unsupportedChunkTypes).toEqual([]);
    expect(report.unresolvedResources).toEqual([]);
    expect(report.unresolvedTables).toEqual([]);
  });
});

describe('artifactIdsForSubject', () => {
  it('returns the artifact ids recorded for a provenance subject', () => {
    const provenance = {
      schemaVersion: 1 as const,
      generatedAt: '2026-06-29T00:00:00.000Z',
      entries: [
        { subject: 'page:p1', sourceArtifacts: [{ artifactId: 'page-data:raw/page-data/a/b.json', kind: 'page-data' as const }] }
      ]
    };
    expect(artifactIdsForSubject(provenance, 'page:p1')).toEqual(['page-data:raw/page-data/a/b.json']);
    expect(artifactIdsForSubject(provenance, 'page:missing')).toEqual([]);
    expect(artifactIdsForSubject(null, 'page:p1')).toEqual([]);
  });
});

describe('collectRequiredRouteFailures', () => {
  it('only includes required routes with error severity', () => {
    const reports: RendererRouteReport[] = [
      {
        route: '/components/switch/overview',
        renderedMarkdownPath: 'components/switch/overview.md',
        sourceArtifactIds: [],
        unsupportedChunkTypes: [],
        unresolvedResources: [],
        unresolvedTables: [],
        sectionCoverage: { sourceSectionCount: 0, renderedSectionCount: 0, droppedSectionTitles: [] },
        headingCoverage: { sourceHeadingCount: 0, renderedHeadingCount: 0 },
        isRequiredRoute: true,
        severity: 'error'
      },
      {
        route: '/foundations/experimental',
        renderedMarkdownPath: 'foundations/experimental.md',
        sourceArtifactIds: [],
        unsupportedChunkTypes: [],
        unresolvedResources: [],
        unresolvedTables: [],
        sectionCoverage: { sourceSectionCount: 0, renderedSectionCount: 0, droppedSectionTitles: [] },
        headingCoverage: { sourceHeadingCount: 0, renderedHeadingCount: 0 },
        isRequiredRoute: false,
        severity: 'error'
      }
    ];
    expect(collectRequiredRouteFailures(reports)).toEqual(['/components/switch/overview']);
  });
});
