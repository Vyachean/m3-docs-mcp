import { getDefaultCacheDir } from '../cache.js';
import {
  readPageGraph,
  readProvenanceGraph,
  readResourceGraph,
  readRouteGraph,
  readSectionGraph,
  readTokenTableGraph,
} from '../graph/graph-store.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * `validate-cache` graph completeness gate: reads every `graph/*.json` file through the
 * MCP-owned readers/schemas (graph-store.ts / graph-types.ts) — no ad-hoc parsing. Routes,
 * pages, resources, and token tables must each be non-empty (a verified cache documents real
 * content for all four); sections and provenance must exist and pass schema validation, but are
 * allowed to be empty (a route/page set can legitimately produce zero derived section/provenance
 * entries without that being a structural defect on its own).
 */

export type ValidateGraphFilesInput = {
  cacheDir?: string;
};

export async function validateGraphFiles(input: ValidateGraphFilesInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const stage = 'graph-files';

  const [routeGraph, pageGraph, resourceGraph, tokenTableGraph, sectionGraph, provenanceGraph] = await Promise.all([
    readRouteGraph(cacheDir),
    readPageGraph(cacheDir),
    readResourceGraph(cacheDir),
    readTokenTableGraph(cacheDir),
    readSectionGraph(cacheDir),
    readProvenanceGraph(cacheDir),
  ]);

  const reasons: string[] = [];

  if (!routeGraph) reasons.push('graph/routes.json is missing or failed schema validation.');
  else if (routeGraph.routes.length === 0) reasons.push('graph/routes.json contains zero routes.');

  if (!pageGraph) reasons.push('graph/pages.json is missing or failed schema validation.');
  else if (pageGraph.pages.length === 0) reasons.push('graph/pages.json contains zero pages.');

  if (!resourceGraph) reasons.push('graph/resources.json is missing or failed schema validation.');
  else if (resourceGraph.resources.length === 0) reasons.push('graph/resources.json contains zero resources.');

  if (!tokenTableGraph) reasons.push('graph/token-tables.json is missing or failed schema validation.');
  else if (tokenTableGraph.tokenTables.length === 0) reasons.push('graph/token-tables.json contains zero token tables.');

  if (!sectionGraph) reasons.push('graph/sections.json is missing or failed schema validation.');

  if (!provenanceGraph) reasons.push('graph/provenance.json is missing or failed schema validation.');

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, {
      routeCount: routeGraph?.routes.length ?? 0,
      pageCount: pageGraph?.pages.length ?? 0,
      resourceCount: resourceGraph?.resources.length ?? 0,
      tokenTableCount: tokenTableGraph?.tokenTables.length ?? 0,
    });
  }

  return passedCheck(stage, {
    routeCount: routeGraph?.routes.length ?? 0,
    pageCount: pageGraph?.pages.length ?? 0,
    resourceCount: resourceGraph?.resources.length ?? 0,
    tokenTableCount: tokenTableGraph?.tokenTables.length ?? 0,
  });
}
