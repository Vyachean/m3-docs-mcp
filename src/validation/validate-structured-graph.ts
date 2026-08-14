import { getDefaultCacheDir } from '../cache.js';
import { readPageGraph, readResourceGraph, readTokenTableGraph } from '../graph/graph-store.js';
import type { ResourceNode } from '../graph/graph-types.js';
import { normalizeGraphRoute } from '../graph/route-identity.js';
import { REQUIRED_RENDERER_ROUTES } from '../rendered/renderer-report.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * Stage 4 of `verify:cache:full`: structured graph completeness.
 *
 * Reads `graph/resources.json`, `graph/token-tables.json`, and `graph/pages.json` and fails when,
 * for any of the required pages:
 *  - a DSDB/token/status resource routed to that page is `unresolved` (graph/resources.json
 *    ResourceNode.status), or
 *  - the page's `unsupportedChunkTypes` (graph/pages.json PageNode) contains any chunk/resource
 *    type, i.e. an unknown chunk type was encountered while extracting a required component page.
 *
 * This is a structural check distinct from stage 5 (Markdown rendering quality) — it inspects the
 * graph directly rather than rendered Markdown text, so it can catch unresolved resources even on
 * required routes whose Markdown rendering pipeline papered over the gap with a placeholder that
 * happens not to match the renderer-report's tracked patterns.
 *
 * TokenTableNode.unresolvedTokenCount is informational and intentionally does not fail this stage.
 * Live Material token systems can omit some role/context variants while still resolving the
 * underlying DSDB token-table resource correctly; strict verification should fail on unresolved
 * resources, not on every missing token variant.
 */

function resourceRoutedToRequired(resource: ResourceNode, requiredNormalized: Set<string>): boolean {
  return resource.routes.some((route) => requiredNormalized.has(normalizeGraphRoute(route)));
}

export type ValidateStructuredGraphInput = {
  cacheDir?: string;
  requiredRoutes?: readonly string[];
};

export async function validateStructuredGraph(input: ValidateStructuredGraphInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const requiredRoutes = input.requiredRoutes ?? REQUIRED_RENDERER_ROUTES;
  const requiredNormalized = new Set(requiredRoutes.map(normalizeGraphRoute));
  const stage = 'structured-graph';

  const [resourceGraph, tokenTableGraph, pageGraph] = await Promise.all([
    readResourceGraph(cacheDir),
    readTokenTableGraph(cacheDir),
    readPageGraph(cacheDir),
  ]);

  if (!resourceGraph) {
    return failedCheck(stage, ['graph/resources.json is missing or failed schema validation.']);
  }
  if (!tokenTableGraph) {
    return failedCheck(stage, ['graph/token-tables.json is missing or failed schema validation.']);
  }

  const reasons: string[] = [];
  const resourceById = new Map(resourceGraph.resources.map((resource) => [resource.resourceId, resource]));
  const tokenTableById = new Map(tokenTableGraph.tokenTables.map((tokenTable) => [tokenTable.resourceId, tokenTable]));
  const blockingTokenValueReasons = new Set<string>([
    'missing-alias-target',
    'unsupported-value-type',
    'parser-bug',
    'unclassified',
  ]);
  const blockingTokenValues: string[] = [];
  for (const tokenTable of tokenTableGraph.tokenTables) {
    for (const tokenSet of tokenTable.tokenSets) {
      for (const token of tokenSet.tokens) {
        for (const value of token.values) {
          if (value.resolved || !value.unresolvedReason || !blockingTokenValueReasons.has(value.unresolvedReason)) continue;
          blockingTokenValues.push(`${token.tokenName}:${value.role}:${value.unresolvedReason}`);
        }
      }
    }
  }
  if (blockingTokenValues.length > 0) {
    const sample = blockingTokenValues.slice(0, 10).join(', ');
    reasons.push(
      `Token-table graph contains ${blockingTokenValues.length} parser/integrity unresolved value(s): ${sample}${blockingTokenValues.length > 10 ? `, and ${blockingTokenValues.length - 10} more` : ""}.`
    );
  }

  for (const resource of resourceGraph.resources) {
    if (resource.status !== 'unresolved') continue;
    if (!resourceRoutedToRequired(resource, requiredNormalized)) continue;
    reasons.push(
      `Unresolved ${resource.kind} resource "${resource.resourceName ?? resource.resourceId}" on required route(s) ${resource.routes.join(', ')}: ${resource.unresolvedReason ?? 'unknown reason'}.`
    );
  }

  if (pageGraph) {
    for (const page of pageGraph.pages) {
      if (!requiredNormalized.has(normalizeGraphRoute(page.route))) continue;
      if (page.sections.length === 0) reasons.push(`Required page ${page.route} has no sections in graph/pages.json.`);
      if (page.chunks.length === 0) reasons.push(`Required page ${page.route} has no chunks in graph/pages.json.`);
      if (page.resourceIds.length === 0) reasons.push(`Required page ${page.route} has no resourceIds in graph/pages.json.`);
      if (page.route.endsWith('/specs') && page.tokenTableIds.length === 0) {
        reasons.push(`Required specs page ${page.route} has no tokenTableIds in graph/pages.json.`);
      }
      if (page.unsupportedChunkTypes.length > 0) {
        reasons.push(
          `Required page ${page.route} has unknown chunk/resource type(s) recorded: ${page.unsupportedChunkTypes.join(', ')}.`
        );
      }
      for (const resourceId of page.resourceIds) {
        const resource = resourceById.get(resourceId);
        if (!resource) {
          reasons.push(`Required page ${page.route} references missing resourceId ${resourceId}.`);
          continue;
        }
        if (resource.status !== 'resolved') {
          reasons.push(
            `Required page ${page.route} references unresolved ${resource.kind} resource "${resource.resourceName ?? resource.resourceId}": ${resource.unresolvedReason ?? 'unknown reason'}.`
          );
        }
        if (!resource.routes.some((route) => normalizeGraphRoute(route) === normalizeGraphRoute(page.route))) {
          reasons.push(`Required page ${page.route} references resource ${resourceId} that is not routed back to ${page.route}.`);
        }
      }
      for (const tokenTableId of page.tokenTableIds) {
        if (!tokenTableById.has(tokenTableId)) {
          reasons.push(`Required page ${page.route} references missing token table ${tokenTableId}.`);
        }
      }
    }
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, {
      resourceCount: resourceGraph.resources.length,
      tokenTableCount: tokenTableGraph.tokenTables.length,
    });
  }

  return passedCheck(stage, {
    resourceCount: resourceGraph.resources.length,
    tokenTableCount: tokenTableGraph.tokenTables.length,
  });
}
