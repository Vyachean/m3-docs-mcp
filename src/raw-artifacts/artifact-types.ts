import { z } from 'zod';

/**
 * Raw artifact record schemas (cache schema v2).
 *
 * A "raw artifact" is a byte-for-byte (or text-for-text) capture of something
 * fetched from the live site (or a browser capture of network traffic against
 * the live site), persisted under `raw/**` in the cache directory. These
 * records are the provenance layer the future documentation graph (routes,
 * pages, resources, token tables) will be built from.
 *
 * All fields here are derived from zod schemas per AGENTS.md: external/decoded
 * payload types must come from `z.infer`/`z.output`, never hand-written
 * interfaces.
 */

export const ArtifactKindSchema = z.union([
  z.literal('site-shell'),
  z.literal('site-meta'),
  z.literal('angular-bundle'),
  z.literal('sitemap'),
  z.literal('page-data'),
  z.literal('carbon-content'),
  z.literal('dsdb-resource'),
  z.literal('network-capture'),
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactSourceMethodSchema = z.union([
  z.literal('static-plan'),
  z.literal('browser-capture'),
  z.literal('manual-required-route'),
]);
export type ArtifactSourceMethod = z.infer<typeof ArtifactSourceMethodSchema>;

/**
 * Optional free-form diagnostic/error metadata attached to an artifact record.
 * Kept permissive (string-keyed, string/number/boolean leaf values) since the
 * exact diagnostic shape varies by artifact kind and call site; consumers
 * must still treat any value read back as `unknown` and narrow it themselves.
 */
export const ArtifactDiagnosticMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);
export type ArtifactDiagnosticMetadata = z.infer<typeof ArtifactDiagnosticMetadataSchema>;

export const ArtifactRecordSchema = z.object({
  /** Stable, content-independent identifier for this artifact (e.g. derived from kind + local path). */
  id: z.string().trim().min(1),
  kind: ArtifactKindSchema,
  /** Absolute URL the artifact was fetched from. */
  sourceUrl: z.string().trim().min(1),
  /** Path to the persisted artifact file, relative to the cache directory root (e.g. "raw/page-data/<collectionId>/<documentId>.json"). */
  localPath: z.string().trim().min(1),
  httpStatus: z.number().int().nullable(),
  contentType: z.string().nullable(),
  /** Lowercase hex-encoded SHA-256 digest of the persisted bytes/text. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** ISO-8601 timestamp of when the artifact was fetched/persisted. */
  fetchedAt: z.string().trim().min(1),
  /** The documentation route this artifact was fetched in service of, when applicable (e.g. "components/buttons/specs"). */
  sourceRoute: z.string().nullable(),
  sourceMethod: ArtifactSourceMethodSchema,
  error: z.string().nullable(),
  diagnostics: ArtifactDiagnosticMetadataSchema.nullable(),
});
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export const ArtifactRecordListSchema = z.array(ArtifactRecordSchema);
export type ArtifactRecordList = z.infer<typeof ArtifactRecordListSchema>;
