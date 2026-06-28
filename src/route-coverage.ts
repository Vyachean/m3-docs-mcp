import { materialPagePath } from './crawler-utils.js';
import type {
  CompactRouteCoverageExample,
  PublicDocsClassification,
  RouteCandidateSource,
  RouteCoverageEntry,
  RouteCoverageStatus,
  RoutePlanEntry,
  RouteReconciliationStatus
} from './types.js';

const ROUTE_COVERAGE_PROBLEM_EXAMPLE_LIMIT = 5;

export function normalizeCoverageRoute(path: string): string {
  if (path === '/' || path === '') return '/';
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

export function normalizeCoverageOutputPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.md$/i, '.md');
}

export function normalizeTabSlug(tab: { label: string; slug?: string }): string {
  if (tab.slug) return tab.slug.replace(/^\/+|\/+$/g, '');
  return tab.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

export function planExpectedOutputPaths(
  baseUrl: string,
  canonicalRoute: string,
  tabSlugs?: string[]
): Pick<RouteCoverageEntry, 'expectedVirtualRoutes' | 'expectedOutputPaths'> {
  const canonical = normalizeCoverageRoute(canonicalRoute);
  const buildOutput = (route: string): string => materialPagePath(new URL(route, baseUrl).toString());
  if (tabSlugs && tabSlugs.length > 0) {
    const expectedVirtualRoutes = uniqueSorted(tabSlugs.map((slug) => normalizeCoverageRoute(`${canonical}/${slug}`)));
    return {
      expectedVirtualRoutes,
      expectedOutputPaths: expectedVirtualRoutes.map(buildOutput)
    };
  }
  return {
    expectedVirtualRoutes: [canonical],
    expectedOutputPaths: [buildOutput(canonical)]
  };
}

export function createRouteCoverageEntry(params: {
  baseUrl: string;
  sourceRoute: string;
  canonicalRoute: string;
  routeKey?: string;
  sources?: RouteCandidateSource[];
  reconciliationStatus?: RouteReconciliationStatus;
  publicDocsClassification?: PublicDocsClassification;
  navigationSource?: RouteCoverageEntry['navigationSource'];
  pageReferenceSource?: RouteCoverageEntry['pageReferenceSource'];
  tabSlugs?: string[];
  status?: RouteCoverageStatus;
  failureReasons?: string[];
}): RouteCoverageEntry {
  const planned = planExpectedOutputPaths(params.baseUrl, params.canonicalRoute, params.tabSlugs);
  return {
    sourceRoute: normalizeCoverageRoute(params.sourceRoute),
    canonicalRoute: normalizeCoverageRoute(params.canonicalRoute),
    ...(params.routeKey ? { routeKey: params.routeKey } : {}),
    ...(params.sources ? { sources: [...params.sources].sort() } : {}),
    ...(params.reconciliationStatus ? { reconciliationStatus: params.reconciliationStatus } : {}),
    ...(params.publicDocsClassification ? { publicDocsClassification: params.publicDocsClassification } : {}),
    ...(params.navigationSource ? { navigationSource: params.navigationSource } : {}),
    ...(params.pageReferenceSource ? { pageReferenceSource: params.pageReferenceSource } : {}),
    expectedVirtualRoutes: planned.expectedVirtualRoutes,
    expectedOutputPaths: planned.expectedOutputPaths.map(normalizeCoverageOutputPath),
    savedOutputPaths: [],
    failedOutputPaths: [],
    skippedOutputPaths: [],
    status: params.status ?? 'unresolved',
    failureReasons: uniqueSorted(params.failureReasons ?? (planned.expectedOutputPaths.length > 0 ? [] : ['no-expected-output-paths']))
  };
}

export function addRouteCoverageFailureReason(entry: RouteCoverageEntry, reason: string): void {
  if (!reason || entry.failureReasons.includes(reason)) return;
  entry.failureReasons.push(reason);
  entry.failureReasons.sort();
}

export function reconcileRouteCoverageStatus(entry: RouteCoverageEntry): RouteCoverageEntry {
  entry.expectedVirtualRoutes = uniqueSorted(entry.expectedVirtualRoutes.map(normalizeCoverageRoute));
  entry.expectedOutputPaths = uniqueSorted(entry.expectedOutputPaths.map(normalizeCoverageOutputPath));
  entry.savedOutputPaths = uniqueSorted(entry.savedOutputPaths.map(normalizeCoverageOutputPath));
  entry.failedOutputPaths = uniqueSorted(entry.failedOutputPaths.map(normalizeCoverageOutputPath));
  entry.skippedOutputPaths = uniqueSorted(entry.skippedOutputPaths.map(normalizeCoverageOutputPath));
  entry.failureReasons = uniqueSorted(entry.failureReasons);

  if (entry.status === 'policySkipped' || entry.status === 'nonContent') return entry;
  if (entry.expectedOutputPaths.length === 0) {
    entry.status = 'unresolved';
    addRouteCoverageFailureReason(entry, 'no-expected-output-paths');
    return entry;
  }
  const allExpectedSaved = entry.expectedOutputPaths.every((path) => entry.savedOutputPaths.includes(path));
  const allExpectedFailed = entry.expectedOutputPaths.every((path) => entry.failedOutputPaths.includes(path));
  const allExpectedSkipped = entry.expectedOutputPaths.every((path) => entry.skippedOutputPaths.includes(path));
  if (allExpectedSaved) entry.status = 'covered';
  else if (entry.savedOutputPaths.length > 0) entry.status = 'partial';
  else if (allExpectedFailed) entry.status = 'failed';
  else if (allExpectedSkipped) entry.status = 'skipped';
  else entry.status = 'unresolved';
  return entry;
}

export function summarizeRouteCoverage(entries: RouteCoverageEntry[]): {
  totalAcceptedRoutes: number;
  coveredRoutes: number;
  partialRoutes: number;
  failedRoutes: number;
  unresolvedRoutes: number;
  policySkippedRoutes: number;
  nonContentRoutes: number;
  expectedOutputCount: number;
  savedOutputCount: number;
  failedOutputCount: number;
  problematicExamples: CompactRouteCoverageExample[];
} {
  const summary = {
    totalAcceptedRoutes: entries.length,
    coveredRoutes: 0,
    partialRoutes: 0,
    failedRoutes: 0,
    unresolvedRoutes: 0,
    policySkippedRoutes: 0,
    nonContentRoutes: 0,
    expectedOutputCount: 0,
    savedOutputCount: 0,
    failedOutputCount: 0,
    problematicExamples: [] as CompactRouteCoverageExample[]
  };
  for (const entry of entries) {
    summary.expectedOutputCount += entry.expectedOutputPaths.length;
    summary.savedOutputCount += entry.savedOutputPaths.length;
    summary.failedOutputCount += entry.failedOutputPaths.length;
    if (entry.status === 'covered') summary.coveredRoutes += 1;
    else if (entry.status === 'partial') summary.partialRoutes += 1;
    else if (entry.status === 'failed') summary.failedRoutes += 1;
    else if (entry.status === 'policySkipped') summary.policySkippedRoutes += 1;
    else if (entry.status === 'nonContent') summary.nonContentRoutes += 1;
    else summary.unresolvedRoutes += 1;
    if (entry.status === 'covered' || summary.problematicExamples.length >= ROUTE_COVERAGE_PROBLEM_EXAMPLE_LIMIT) continue;
    summary.problematicExamples.push({
      sourceRoute: entry.sourceRoute,
      canonicalRoute: entry.canonicalRoute,
      status: entry.status,
      failureReasons: [...entry.failureReasons],
      expectedOutputPathCount: entry.expectedOutputPaths.length,
      savedOutputPathCount: entry.savedOutputPaths.length,
      failedOutputPathCount: entry.failedOutputPaths.length,
      skippedOutputPathCount: entry.skippedOutputPaths.length,
      expectedOutputPathExamples: entry.expectedOutputPaths.slice(0, 3),
      savedOutputPathExamples: entry.savedOutputPaths.slice(0, 3),
      failedOutputPathExamples: entry.failedOutputPaths.slice(0, 3),
      skippedOutputPathExamples: entry.skippedOutputPaths.slice(0, 3),
    });
  }
  return summary;
}

export function summarizeRouteCoverageFailure(entry: RouteCoverageEntry): string {
  const summarize = (paths: string[]): string => paths.slice(0, 3).join(', ') || 'none';
  return [
    `${entry.sourceRoute}[status=${entry.status}]`,
    `expected=${entry.expectedOutputPaths.length} (${summarize(entry.expectedOutputPaths)})`,
    `saved=${entry.savedOutputPaths.length} (${summarize(entry.savedOutputPaths)})`,
    `failed=${entry.failedOutputPaths.length} (${summarize(entry.failedOutputPaths)})`,
    `skipped=${entry.skippedOutputPaths.length} (${summarize(entry.skippedOutputPaths)})`,
    `reasons=${entry.failureReasons.join('|') || 'none'}`
  ].join(', ');
}

export function toCompactProblemRoutes(routePlanEntries: RoutePlanEntry[], routeCoverage: RouteCoverageEntry[]): RoutePlanEntry[] {
  return routePlanEntries.filter((entry) => {
    const sourceRoute = normalizeCoverageRoute(entry.route);
    const coverageEntry = routeCoverage.find((candidate) => candidate.sourceRoute === sourceRoute);
    return coverageEntry?.status === 'unresolved' || coverageEntry?.status === 'failed' || coverageEntry?.status === 'partial';
  });
}
