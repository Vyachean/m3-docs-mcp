import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { diagnosticsDir, getDefaultCacheDir } from '../cache.js';
import { readPageGraph, readRouteGraph, readTokenTableGraph } from '../graph/graph-store.js';
import type { PageGraph, RouteGraph, TokenTableGraph } from '../graph/graph-types.js';
import type { CoverageDiagnostics, RoutePlanSummary } from '../types.js';
import { buildRejectedRoutesSummary, type RejectedRoutesSummary, type StalePublicDocsRouteSource } from './rejected-routes-summary.js';
import { buildSpecPagesSummary, type SpecPagesSummary } from './spec-pages-summary.js';
import { buildTokenResolutionSummary, type TokenResolutionSummary, type UnresolvedByReason } from './token-resolution-summary.js';

export type CacheDiagnosticsSummary = {
  unresolvedTokenRows: number;
  unresolvedTokenCells: number;
  specPagesWithTokenTables: number;
  specPagesWithoutTokenTables: number;
  componentSpecPageCount: number;
  componentSpecPagesWithTokenTables: number;
  componentSpecPagesWithoutTokenTables: number;
  stalePublicDocsRoutes: number;
  stalePublicDocsRouteSource: StalePublicDocsRouteSource;
  policySkippedRoutes: number;
  nonContentRoutes: number;
  /** Breakdown of unresolved token cells by reason. */
  unresolvedByReason?: UnresolvedByReason;
};

export type WriteCacheDiagnosticsInput = {
  cacheDir?: string;
  tokenTableGraph?: TokenTableGraph;
  pageGraph?: PageGraph;
  markdownPagePaths?: Iterable<string>;
  routePlanSummary?: RoutePlanSummary | null;
  coverageDiagnostics?: CoverageDiagnostics | null;
  routeGraph?: RouteGraph | null;
  generatedAt?: string;
};

function tokenResolutionSummaryPath(cacheDir: string): string {
  return path.join(diagnosticsDir(cacheDir), 'token-resolution-summary.json');
}

function specPagesSummaryPath(cacheDir: string): string {
  return path.join(diagnosticsDir(cacheDir), 'spec-pages-summary.json');
}

function rejectedRoutesSummaryPath(cacheDir: string): string {
  return path.join(diagnosticsDir(cacheDir), 'rejected-routes-summary.json');
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function writeCacheDiagnostics(input: WriteCacheDiagnosticsInput = {}): Promise<CacheDiagnosticsSummary> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  const tokenTableGraph = input.tokenTableGraph ?? (await readTokenTableGraph(cacheDir)) ?? { schemaVersion: 1 as const, generatedAt, tokenTables: [] };
  const pageGraph = input.pageGraph ?? (await readPageGraph(cacheDir)) ?? { schemaVersion: 1 as const, generatedAt, pages: [] };
  const routeGraph = input.routeGraph !== undefined ? input.routeGraph : await readRouteGraph(cacheDir);
  const markdownPagePaths = input.markdownPagePaths ?? [];

  const tokenSummary = buildTokenResolutionSummary({ tokenTableGraph, generatedAt });
  const specSummary = buildSpecPagesSummary({ pageGraph, markdownPagePaths, generatedAt });
  const rejectedSummary = buildRejectedRoutesSummary({
    routePlanSummary: input.routePlanSummary,
    coverageDiagnostics: input.coverageDiagnostics,
    routeGraph,
    generatedAt,
  });

  await Promise.all([
    writeJson(tokenResolutionSummaryPath(cacheDir), tokenSummary),
    writeJson(specPagesSummaryPath(cacheDir), specSummary),
    writeJson(rejectedRoutesSummaryPath(cacheDir), rejectedSummary),
  ]);

  return buildCacheDiagnosticsSummary(tokenSummary, specSummary, rejectedSummary);
}

function buildCacheDiagnosticsSummary(
  tokenSummary: TokenResolutionSummary,
  specSummary: SpecPagesSummary,
  rejectedSummary: RejectedRoutesSummary,
): CacheDiagnosticsSummary {
  return {
    unresolvedTokenRows: tokenSummary.unresolvedTokenRows,
    unresolvedTokenCells: tokenSummary.unresolvedCellCount,
    specPagesWithTokenTables: specSummary.specPagesWithTokenTables,
    specPagesWithoutTokenTables: specSummary.specPagesWithoutTokenTables.length,
    componentSpecPageCount: specSummary.componentSpecPageCount,
    componentSpecPagesWithTokenTables: specSummary.componentSpecPagesWithTokenTables,
    componentSpecPagesWithoutTokenTables: specSummary.componentSpecPagesWithoutTokenTables.length,
    stalePublicDocsRoutes: rejectedSummary.stalePublicDocsRouteCount,
    stalePublicDocsRouteSource: rejectedSummary.stalePublicDocsRouteSource,
    policySkippedRoutes: rejectedSummary.policySkippedRouteCount,
    nonContentRoutes: rejectedSummary.nonContentRouteCount,
    unresolvedByReason: tokenSummary.unresolvedByReason,
  };
}

/** Read diagnostics summary counts from already-written files. Returns null if files are absent or invalid. */
export async function readCacheDiagnosticsSummary(cacheDir: string): Promise<CacheDiagnosticsSummary | null> {
  try {
    const [tokenRaw, specRaw, rejectedRaw] = await Promise.all([
      readFile(tokenResolutionSummaryPath(cacheDir), 'utf8').then((t) => JSON.parse(t) as unknown).catch(() => null),
      readFile(specPagesSummaryPath(cacheDir), 'utf8').then((t) => JSON.parse(t) as unknown).catch(() => null),
      readFile(rejectedRoutesSummaryPath(cacheDir), 'utf8').then((t) => JSON.parse(t) as unknown).catch(() => null),
    ]);

    if (!isRecord(tokenRaw) || !isRecord(specRaw) || !isRecord(rejectedRaw)) return null;

    const rawSource = rejectedRaw['stalePublicDocsRouteSource'];
    const stalePublicDocsRouteSource: StalePublicDocsRouteSource =
      rawSource === 'routePlanSummary' || rawSource === 'coverageDiagnostics.fullRoutePlanSummary'
        ? rawSource
        : 'unavailable';

    const rawByReason = tokenRaw['unresolvedByReason'];
    const unresolvedByReason: UnresolvedByReason | undefined = isRecord(rawByReason)
      ? {
          'missing-alias-target': typeof rawByReason['missing-alias-target'] === 'number' ? rawByReason['missing-alias-target'] : 0,
          'missing-context-entry': typeof rawByReason['missing-context-entry'] === 'number' ? rawByReason['missing-context-entry'] : 0,
          'unsupported-value-type': typeof rawByReason['unsupported-value-type'] === 'number' ? rawByReason['unsupported-value-type'] : 0,
          'upstream-empty': typeof rawByReason['upstream-empty'] === 'number' ? rawByReason['upstream-empty'] : 0,
          'parser-bug': typeof rawByReason['parser-bug'] === 'number' ? rawByReason['parser-bug'] : 0,
          unclassified: typeof rawByReason['unclassified'] === 'number' ? rawByReason['unclassified'] : 0,
        }
      : undefined;

    return {
      unresolvedTokenRows: typeof tokenRaw['unresolvedTokenRows'] === 'number' ? tokenRaw['unresolvedTokenRows'] : 0,
      unresolvedTokenCells: typeof tokenRaw['unresolvedCellCount'] === 'number' ? tokenRaw['unresolvedCellCount'] : 0,
      specPagesWithTokenTables: typeof specRaw['specPagesWithTokenTables'] === 'number' ? specRaw['specPagesWithTokenTables'] : 0,
      specPagesWithoutTokenTables: Array.isArray(specRaw['specPagesWithoutTokenTables']) ? specRaw['specPagesWithoutTokenTables'].length : 0,
      componentSpecPageCount: typeof specRaw['componentSpecPageCount'] === 'number' ? specRaw['componentSpecPageCount'] : 0,
      componentSpecPagesWithTokenTables: typeof specRaw['componentSpecPagesWithTokenTables'] === 'number' ? specRaw['componentSpecPagesWithTokenTables'] : 0,
      componentSpecPagesWithoutTokenTables: Array.isArray(specRaw['componentSpecPagesWithoutTokenTables']) ? specRaw['componentSpecPagesWithoutTokenTables'].length : 0,
      stalePublicDocsRoutes: typeof rejectedRaw['stalePublicDocsRouteCount'] === 'number' ? rejectedRaw['stalePublicDocsRouteCount'] : 0,
      stalePublicDocsRouteSource,
      policySkippedRoutes: typeof rejectedRaw['policySkippedRouteCount'] === 'number' ? rejectedRaw['policySkippedRouteCount'] : 0,
      nonContentRoutes: typeof rejectedRaw['nonContentRouteCount'] === 'number' ? rejectedRaw['nonContentRouteCount'] : 0,
      ...(unresolvedByReason ? { unresolvedByReason } : {}),
    };
  } catch {
    return null;
  }
}
