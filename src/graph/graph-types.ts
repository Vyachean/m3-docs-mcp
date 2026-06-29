import { z } from 'zod';

/**
 * Graph schema (stage 3/4 of the raw-snapshot-first cache architecture).
 *
 * These types describe the persisted `graph/*.json` files written alongside
 * `manifest.json` and `raw/**`. They are built from the existing extraction
 * pipeline's *output* structures (`RoutePlanEntry`, `RouteCoverageEntry`,
 * `MaterialPageMeta`, `ExtractionPageDiagnostic`, `ExtractionRouteDiagnostic`
 * — see src/types.ts) rather than from raw JSON payloads, so every field
 * here is produced by a typed decoder (`route-graph.ts`, `page-graph.ts`,
 * `resource-graph.ts`, `token-table-graph.ts`) and validated with the zod
 * schemas below before being persisted. No `as any` / `as Record<string,
 * unknown>` casts on externally-sourced data — only structurally-typed
 * intermediate values produced by this codebase's own pipeline feed these
 * builders.
 */

// ── Shared primitives ─────────────────────────────────────────────────────────

export const SourceArtifactRefSchema = z.object({
  /** Matches ArtifactRecord.id from raw-artifacts/artifact-index.ts (kind:localPath). Not yet
   *  populated from a live crawl until the crawler is wired to raw-artifacts (see report). */
  artifactId: z.string().trim().min(1),
  kind: z.union([
    z.literal('page-data'),
    z.literal('carbon-content'),
    z.literal('dsdb-resource'),
    z.literal('network-capture'),
  ]),
});
export type SourceArtifactRef = z.infer<typeof SourceArtifactRefSchema>;

// ── Route graph ────────────────────────────────────────────────────────────────

export const RouteReferenceSchema = z.object({
  collectionId: z.string().nullable(),
  documentId: z.string().nullable(),
  exportedCarbonFileId: z.string().nullable(),
  pageCanonId: z.string().nullable(),
  carbonVersion: z.string().nullable(),
});
export type RouteReference = z.infer<typeof RouteReferenceSchema>;

export const RouteTabNodeSchema = z.object({
  label: z.string(),
  route: z.string(),
  slug: z.string(),
  matchedSectionId: z.string().nullable(),
  matchReason: z.union([
    z.literal('slug'),
    z.literal('label'),
    z.literal('position'),
    z.literal('unmatched'),
  ]),
});
export type RouteTabNode = z.infer<typeof RouteTabNodeSchema>;

export const RouteOriginSchema = z.union([
  z.literal('site_meta'),
  z.literal('site_meta_alias'),
  z.literal('nav_drawer'),
  z.literal('bundle'),
  z.literal('sitemap'),
  z.literal('rendered_nav'),
]);
export type RouteOrigin = z.infer<typeof RouteOriginSchema>;

export const RouteCoverageStatusSchema = z.union([
  z.literal('covered'),
  z.literal('partial'),
  z.literal('failed'),
  z.literal('skipped'),
  z.literal('unresolved'),
  z.literal('nonContent'),
  z.literal('policySkipped'),
  z.literal('aliasOnly'),
  z.literal('ambiguous'),
  z.literal('stale'),
]);
export type RouteGraphCoverageStatus = z.infer<typeof RouteCoverageStatusSchema>;

/**
 * Per-route coverage as recorded for THIS route specifically (not collapsed into a shared
 * alias/canonical group). See provenance.ts / route-graph.ts for how this differs from
 * `sharedCoverageGroup`.
 */
export const RouteCoverageInfoSchema = z.object({
  status: RouteCoverageStatusSchema,
  reasons: z.array(z.string()),
  /** The coverage status this specific route had before any shared-group reconciliation
   *  collapsed it into a group status. Always equal to `status` for routes that are not part
   *  of a multi-route coverage group. */
  originalStatus: RouteCoverageStatusSchema,
  /** Coverage group key (see route-coverage.ts createRouteCoverageGroupKey) shared with other
   *  source routes that resolve to the same canonical route + expected outputs, when applicable. */
  sharedCoverageGroup: z.string().nullable(),
  /** Other source routes in the same shared coverage group, when applicable. */
  sharedWithRoutes: z.array(z.string()),
  expectedOutputPaths: z.array(z.string()),
  savedOutputPaths: z.array(z.string()),
  failedOutputPaths: z.array(z.string()),
  skippedOutputPaths: z.array(z.string()),
});
export type RouteCoverageInfo = z.infer<typeof RouteCoverageInfoSchema>;

export const RouteNodeSchema = z.object({
  route: z.string(),
  canonicalRoute: z.string().nullable(),
  /** Other route paths that resolve to this same node (site_meta other_routes, bundle
   *  alternateSlugs). Does not include the route itself. */
  aliases: z.array(z.string()),
  title: z.string().nullable(),
  section: z.string().nullable(),
  reference: RouteReferenceSchema,
  tabs: z.array(RouteTabNodeSchema),
  origins: z.array(RouteOriginSchema),
  sourceArtifacts: z.array(SourceArtifactRefSchema),
  expectedOutputPaths: z.array(z.string()),
  generatedOutputPaths: z.array(z.string()),
  coverage: RouteCoverageInfoSchema,
});
export type RouteNode = z.infer<typeof RouteNodeSchema>;

export const RouteGraphSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1),
  routes: z.array(RouteNodeSchema),
});
export type RouteGraph = z.infer<typeof RouteGraphSchema>;

// ── Page graph ─────────────────────────────────────────────────────────────────

export const PageChunkTypeSchema = z.union([
  z.literal('text'),
  z.literal('image'),
  z.literal('video'),
  z.literal('resource'),
  z.literal('unsupported'),
]);
export type PageChunkType = z.infer<typeof PageChunkTypeSchema>;

export const PageChunkNodeSchema = z.object({
  chunkId: z.string(),
  chunkType: PageChunkTypeSchema,
  /** Present for chunkType "resource": the resource graph node id this chunk references. */
  resourceId: z.string().nullable(),
  /** Short text excerpt for "text" chunks, or a label for media/resource chunks. Not full
   *  markdown — the renderer (stage 5) is the canonical Markdown source. */
  textExcerpt: z.string().nullable(),
});
export type PageChunkNode = z.infer<typeof PageChunkNodeSchema>;

export const PageSectionNodeSchema = z.object({
  sectionId: z.string(),
  title: z.string(),
  headingLevel: z.number().int().nonnegative(),
  chunkIds: z.array(z.string()),
});
export type PageSectionNode = z.infer<typeof PageSectionNodeSchema>;

export const PageTabRefSchema = z.object({
  label: z.string(),
  route: z.string(),
  /** Index of the matched section within the decoded content page this tab was split from (see
   *  ExtractionRouteDiagnostic.tabMatchedSectionIndex) — lets an offline renderer (markdown-renderer.ts)
   *  reconstruct exactly this tab's Markdown from the shared raw page-data/carbon-content artifact
   *  without live route resolution. Null when not recorded (e.g. an older graph). */
  sectionIndex: z.number().int().nonnegative().nullable(),
});
export type PageTabRef = z.infer<typeof PageTabRefSchema>;

export const PageProvenanceSchema = z.object({
  sourceArtifacts: z.array(SourceArtifactRefSchema),
  sourceRoute: z.string().nullable(),
  canonicalRoute: z.string().nullable(),
  virtualRoute: z.string().nullable(),
});
export type PageProvenance = z.infer<typeof PageProvenanceSchema>;

export const PageNodeSchema = z.object({
  pageId: z.string(),
  route: z.string(),
  title: z.string(),
  section: z.string(),
  tabs: z.array(PageTabRefSchema),
  headings: z.array(z.string()),
  sections: z.array(PageSectionNodeSchema),
  chunks: z.array(PageChunkNodeSchema),
  resourceIds: z.array(z.string()),
  tokenTableIds: z.array(z.string()),
  unsupportedChunkTypes: z.array(z.string()),
  provenance: PageProvenanceSchema,
});
export type PageNode = z.infer<typeof PageNodeSchema>;

export const PageGraphSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().trim().min(1),
  pages: z.array(PageNodeSchema),
});
export type PageGraph = z.infer<typeof PageGraphSchema>;

// ── Section graph (derived projection of PageGraph) ─────────────────────────────

export const SectionNodeSchema = z.object({
  sectionId: z.string(),
  pageId: z.string(),
  route: z.string(),
  title: z.string(),
  headingLevel: z.number().int().nonnegative(),
  chunkIds: z.array(z.string()),
});
export type SectionNode = z.infer<typeof SectionNodeSchema>;

export const SectionGraphSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().trim().min(1),
  sections: z.array(SectionNodeSchema),
});
export type SectionGraph = z.infer<typeof SectionGraphSchema>;

// ── Resource graph ─────────────────────────────────────────────────────────────

export const ResourceKindSchema = z.union([
  z.literal('token-table'),
  z.literal('status-table'),
  z.literal('image'),
  z.literal('video'),
  z.literal('unknown-resource'),
]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const ResourceStatusSchema = z.union([
  z.literal('resolved'),
  z.literal('unresolved'),
]);
export type ResourceStatus = z.infer<typeof ResourceStatusSchema>;

export const ResourceNodeSchema = z.object({
  resourceId: z.string(),
  kind: ResourceKindSchema,
  /** Resource name as referenced in the page-data/content payload (e.g. DSDB resourceName),
   *  null when the chunk never carried a resolvable name. */
  resourceName: z.string().nullable(),
  sourceArtifact: SourceArtifactRefSchema.nullable(),
  routes: z.array(z.string()),
  /** PageNode.pageId values for pages whose chunks reference this resource (backfilled in
   *  build-graph.ts once both PageGraph and ResourceGraph are built — see buildAndWriteGraph). */
  pageIds: z.array(z.string()),
  chunkIds: z.array(z.string()),
  status: ResourceStatusSchema,
  unresolvedReason: z.string().nullable(),
});
export type ResourceNode = z.infer<typeof ResourceNodeSchema>;

export const ResourceGraphSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().trim().min(1),
  resources: z.array(ResourceNodeSchema),
});
export type ResourceGraph = z.infer<typeof ResourceGraphSchema>;

// ── Token table graph ──────────────────────────────────────────────────────────

export const TokenValueRoleSchema = z.union([
  z.literal('light'),
  z.literal('dark'),
  z.literal('light-high-contrast'),
  z.literal('dark-high-contrast'),
]);
export type TokenValueRole = z.infer<typeof TokenValueRoleSchema>;

export const TokenValueEntrySchema = z.object({
  role: TokenValueRoleSchema,
  /** Rendered/resolved value string (e.g. "#6750A4", "16dp"), or null when unresolved for this role. */
  value: z.string().nullable(),
  resolved: z.boolean(),
});
export type TokenValueEntry = z.infer<typeof TokenValueEntrySchema>;

export const TokenNodeSchema = z.object({
  tokenName: z.string(),
  displayName: z.string(),
  /** Direct sys/ref alias chain captured from the resource's reference tree, nearest first. */
  aliases: z.array(z.string()),
  values: z.array(TokenValueEntrySchema),
});
export type TokenNode = z.infer<typeof TokenNodeSchema>;

export const TokenSetNodeSchema = z.object({
  tokenSetName: z.string(),
  displayName: z.string(),
  tokens: z.array(TokenNodeSchema),
});
export type TokenSetNode = z.infer<typeof TokenSetNodeSchema>;

export const TokenTableNodeSchema = z.object({
  resourceId: z.string(),
  resourceName: z.string().nullable(),
  requestedTokenSets: z.array(z.string()),
  tokenSets: z.array(TokenSetNodeSchema),
  routes: z.array(z.string()),
  unresolvedTokenCount: z.number().int().nonnegative(),
});
export type TokenTableNode = z.infer<typeof TokenTableNodeSchema>;

export const TokenTableGraphSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().trim().min(1),
  tokenTables: z.array(TokenTableNodeSchema),
});
export type TokenTableGraph = z.infer<typeof TokenTableGraphSchema>;

// ── Provenance graph ────────────────────────────────────────────────────────────

export const ProvenanceEntrySchema = z.object({
  /** "route:<route>" | "page:<pageId>" | "resource:<resourceId>" */
  subject: z.string(),
  sourceArtifacts: z.array(SourceArtifactRefSchema),
});
export type ProvenanceEntry = z.infer<typeof ProvenanceEntrySchema>;

export const ProvenanceGraphSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().trim().min(1),
  entries: z.array(ProvenanceEntrySchema),
});
export type ProvenanceGraph = z.infer<typeof ProvenanceGraphSchema>;
