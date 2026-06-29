import { getDefaultCacheDir } from '../cache.js';
import { loadGraphToolContext, normalizeRouteInput } from '../mcp-tools/context.js';
import type { PageNode } from '../graph/graph-types.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * `validate-cache` MCP smoke gate: proves the cache is actually useful to an agent calling the
 * graph-oriented MCP tools, not just schema-valid in isolation. Calls the same internal
 * read-path the MCP server's tools use (`loadGraphToolContext`, mcp-tools/context.ts) directly
 * against the cache directory — no server process, no stdio transport, no network — and checks
 * that each required route resolves to a structured page (mirrors `get-page.ts`'s "structured"
 * view) with non-empty sections, chunks, and resourceIds, plus non-empty tokenTableIds for specs
 * routes.
 */

function findPage(pages: readonly PageNode[], normalizedRoute: string): PageNode | null {
  return pages.find((page) => page.route === normalizedRoute) ?? null;
}

export type ValidateMcpSmokeInput = {
  cacheDir?: string;
  requiredRoutes: readonly string[];
};

export async function validateMcpSmoke(input: ValidateMcpSmokeInput): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const stage = 'mcp-smoke';

  const context = await loadGraphToolContext(cacheDir);
  if (!context.pageGraph) {
    return failedCheck(stage, ['graph/pages.json is not available — MCP structured page lookups cannot be smoke-tested.']);
  }

  const reasons: string[] = [];
  for (const required of input.requiredRoutes) {
    const normalizedRoute = normalizeRouteInput(required);
    const page = findPage(context.pageGraph.pages, normalizedRoute);
    if (!page) {
      reasons.push(`MCP structured page lookup found no page for required route ${normalizedRoute}.`);
      continue;
    }
    if (page.sections.length === 0) reasons.push(`MCP structured page for ${normalizedRoute} has no sections.`);
    if (page.chunks.length === 0) reasons.push(`MCP structured page for ${normalizedRoute} has no chunks.`);
    if (page.resourceIds.length === 0) reasons.push(`MCP structured page for ${normalizedRoute} has no resourceIds.`);
    if (normalizedRoute.endsWith('/specs') && page.tokenTableIds.length === 0) {
      reasons.push(`MCP structured page for required specs route ${normalizedRoute} has no tokenTableIds.`);
    }
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons);
  }
  return passedCheck(stage, { requiredRouteCount: input.requiredRoutes.length });
}
