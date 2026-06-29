import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getDefaultCacheDir } from '../cache.js';

/**
 * Renderer diagnostics report (`diagnostics/renderer-report.json`), written at the end of a
 * crawl alongside `diagnostics/fetch-report.json` (raw-artifacts/fetch-report.ts) and
 * `manifest.json` (manifest.ts). Mirrors their read/write conventions: write the validated shape
 * with a trailing newline; read back through the same zod schema, returning null/empty on any
 * failure (missing file, invalid JSON, schema mismatch) rather than throwing.
 *
 * Distinct from `diagnostics/fetch-report.json` (one entry per network fetch attempt) and
 * `graph/provenance.json` (artifact ids per route/page/resource subject): this report is about
 * what the *renderer* (extractContentPageToMaterialPage + render-markdown.ts) actually produced
 * for each route, and whether it could fully account for the decoded source structure — unknown
 * chunk types, unresolved resources/token/status tables, and section/heading coverage gaps. This
 * is what stage 8's verification gate will consume; see `requiredRouteFailures` below.
 */

export const RendererDiagnosticSeveritySchema = z.union([
  z.literal('error'),
  z.literal('warning'),
]);
export type RendererDiagnosticSeverity = z.infer<typeof RendererDiagnosticSeveritySchema>;

export const RendererUnsupportedChunkSchema = z.object({
  chunkType: z.string(),
  count: z.number().int().nonnegative(),
  severity: RendererDiagnosticSeveritySchema,
});
export type RendererUnsupportedChunk = z.infer<typeof RendererUnsupportedChunkSchema>;

export const RendererUnresolvedResourceSchema = z.object({
  resourceType: z.string(),
  resourceName: z.string().nullable(),
  reason: z.string(),
  severity: RendererDiagnosticSeveritySchema,
});
export type RendererUnresolvedResource = z.infer<typeof RendererUnresolvedResourceSchema>;

export const RendererUnresolvedTableSchema = z.object({
  kind: z.union([z.literal('token-table'), z.literal('status-table')]),
  resourceName: z.string().nullable(),
  reason: z.string(),
  severity: RendererDiagnosticSeveritySchema,
});
export type RendererUnresolvedTable = z.infer<typeof RendererUnresolvedTableSchema>;

export const RendererSectionCoverageSchema = z.object({
  sourceSectionCount: z.number().int().nonnegative(),
  renderedSectionCount: z.number().int().nonnegative(),
  /** Section titles present in the decoded source but not found as a rendered heading. */
  droppedSectionTitles: z.array(z.string()),
});
export type RendererSectionCoverage = z.infer<typeof RendererSectionCoverageSchema>;

export const RendererHeadingCoverageSchema = z.object({
  sourceHeadingCount: z.number().int().nonnegative(),
  renderedHeadingCount: z.number().int().nonnegative(),
});
export type RendererHeadingCoverage = z.infer<typeof RendererHeadingCoverageSchema>;

export const RendererRouteReportSchema = z.object({
  route: z.string(),
  /** Path to the rendered Markdown file, relative to the cache directory (e.g. "components/switch/overview.md"). */
  renderedMarkdownPath: z.string().nullable(),
  /** Artifact ids (raw-artifacts/artifact-types.ts ArtifactRecord.id) used to produce this route's Markdown, pulled from graph/provenance.json. */
  sourceArtifactIds: z.array(z.string()),
  unsupportedChunkTypes: z.array(RendererUnsupportedChunkSchema),
  unresolvedResources: z.array(RendererUnresolvedResourceSchema),
  unresolvedTables: z.array(RendererUnresolvedTableSchema),
  sectionCoverage: RendererSectionCoverageSchema,
  headingCoverage: RendererHeadingCoverageSchema,
  /** True when this route is one of the required component/spec pages (AGENTS.md spec) — any
   *  error-severity finding for a required route belongs in `requiredRouteFailures` below, not
   *  just this per-route detail list, so a later verification stage (stage 8) can fail fast. */
  isRequiredRoute: z.boolean(),
  /** Highest severity across this route's unsupportedChunkTypes/unresolvedResources/unresolvedTables. */
  severity: RendererDiagnosticSeveritySchema,
});
export type RendererRouteReport = z.infer<typeof RendererRouteReportSchema>;

export const RendererReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().trim().min(1),
  routes: z.array(RendererRouteReportSchema),
  /** Routes from REQUIRED_RENDERER_ROUTES (below) that have at least one error-severity finding.
   *  Stage 8's verification gate should treat a non-empty list here as a hard failure; routes
   *  with only warning-severity findings are not included. */
  requiredRouteFailures: z.array(z.string()),
});
export type RendererReport = z.infer<typeof RendererReportSchema>;

/**
 * Required component/spec pages per the original spec (AGENTS.md / the stage 5 dispatch): for
 * these routes, unknown chunks, unresolved token tables, or unresolved status tables must be
 * verification failures (severity "error"), not harmless warnings. All other routes get
 * severity "warning" for the same findings — still recorded, but not blocking, until stage 8
 * decides whether to broaden this list.
 */
export const REQUIRED_RENDERER_ROUTES: readonly string[] = [
  '/components/switch/overview',
  '/components/switch/specs',
  '/components/buttons/overview',
  '/components/buttons/specs',
  '/components/lists/overview',
  '/components/lists/specs',
  '/styles/color/roles',
  '/foundations/design-tokens/overview',
];

export function isRequiredRendererRoute(route: string): boolean {
  const normalized = `/${route.replace(/^\/+|\/+$/g, '')}`;
  return REQUIRED_RENDERER_ROUTES.includes(normalized);
}

export function rendererReportPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'diagnostics', 'renderer-report.json');
}

/** Writes the renderer diagnostics report to disk, replacing any existing report. */
export async function writeRendererReport(report: RendererReport, cacheDir = getDefaultCacheDir()): Promise<void> {
  const filePath = rendererReportPath(cacheDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** Reads the persisted renderer diagnostics report, or null if none exists yet / it is invalid. */
export async function readRendererReport(cacheDir = getDefaultCacheDir()): Promise<RendererReport | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(rendererReportPath(cacheDir), 'utf8'));
    const parsed = RendererReportSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
