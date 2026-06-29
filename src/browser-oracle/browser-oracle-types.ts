import { z } from 'zod';

/**
 * Browser oracle (stage 7 of the raw-snapshot-first cache architecture).
 *
 * This is a *validation* layer, not a crawler path: a fixed set of "required routes" (the same
 * eight component/spec/style pages already singled out in src/rendered/renderer-report.ts's
 * REQUIRED_RENDERER_ROUTES) are loaded in a real Playwright browser and the network JSON +
 * rendered DOM are captured. A later stage (stage 8) compares that capture against the persisted
 * raw snapshot (`raw/artifact-index.json`) and documentation graph (`graph/*.json`) to catch
 * resources or headings the deterministic direct-JSON crawl silently missed.
 *
 * All captured payloads are externally-sourced (live network responses, live DOM text) and must
 * enter the system as `unknown`, then be validated/narrowed here per AGENTS.md. Comparison logic
 * downstream (compare-capture-to-snapshot.ts) consumes only the decoded `RequiredRouteCapture`
 * shape below, never raw network/DOM values directly.
 */

export const REQUIRED_BROWSER_ORACLE_ROUTES: readonly string[] = [
  '/components/switch/overview',
  '/components/switch/specs',
  '/components/buttons/overview',
  '/components/buttons/specs',
  '/components/lists/overview',
  '/components/lists/specs',
  '/styles/color/roles',
  '/foundations/design-tokens/overview',
];

export const CapturedNetworkResourceKindSchema = z.union([
  z.literal('page-data'),
  z.literal('dsm-content'),
  z.literal('dsm-data'),
  z.literal('token-table'),
  z.literal('status-table'),
  z.literal('other-json'),
]);
export type CapturedNetworkResourceKind = z.infer<typeof CapturedNetworkResourceKindSchema>;

/**
 * One network JSON response observed while a required route was loaded. `resourceId` is a stable,
 * URL-derived identifier (pathname, with query stripped) used to cross-check against
 * `ArtifactRecord.sourceUrl` / `ArtifactRecord.localPath` in raw/artifact-index.json — the browser
 * oracle does not attempt to re-derive a DSDB resourceName/artifact id, since that decoding
 * already lives in classify-json-response.ts and is the raw crawler's responsibility, not this
 * oracle's.
 */
export const CapturedNetworkResourceSchema = z.object({
  resourceId: z.string().trim().min(1),
  url: z.string().trim().min(1),
  kind: CapturedNetworkResourceKindSchema,
  httpStatus: z.number().int().nullable(),
});
export type CapturedNetworkResource = z.infer<typeof CapturedNetworkResourceSchema>;

/** Best-effort DOM text scrape of a required route. Heading extraction (h1-h4 text content) is
 *  reliable; table label extraction is intentionally shallow (see capture-required-routes.ts) —
 *  it grabs each table-like row group's leading cell/label text, not a full structured parse. */
export const CapturedDomSnapshotSchema = z.object({
  headings: z.array(z.string().trim().min(1)),
  /** Visible labels scraped from token/status table-like DOM regions (best-effort; see
   *  capture-required-routes.ts's scrapeVisibleTableLabels for documented limits). */
  visibleTableLabels: z.array(z.string().trim().min(1)),
});
export type CapturedDomSnapshot = z.infer<typeof CapturedDomSnapshotSchema>;

export const RequiredRouteCaptureSchema = z.object({
  route: z.string().trim().min(1),
  requestedUrl: z.string().trim().min(1),
  finalUrl: z.string().trim().min(1).nullable(),
  /** Null when navigation/capture failed outright for this route; capture continues with the
   *  remaining required routes rather than aborting the whole run. */
  navigationError: z.string().nullable(),
  networkResources: z.array(CapturedNetworkResourceSchema),
  dom: CapturedDomSnapshotSchema.nullable(),
});
export type RequiredRouteCapture = z.infer<typeof RequiredRouteCaptureSchema>;

export const RequiredRoutesCaptureReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1),
  routes: z.array(RequiredRouteCaptureSchema),
});
export type RequiredRoutesCaptureReport = z.infer<typeof RequiredRoutesCaptureReportSchema>;

export const RequiredRoutesCaptureReportListSchema = RequiredRoutesCaptureReportSchema;
