import { z } from 'zod';
import { ArtifactKindSchema } from './artifact-types.js';

/**
 * Generic diagnostic record for a single fetch attempt against the live
 * site (or a browser-captured network request). This is intentionally
 * decoupled from `ArtifactRecord`: a `FetchDiagnostic` can exist for a
 * fetch attempt that never produced a persisted artifact (e.g. a 404, a
 * JSON parse failure, or a network error), whereas `ArtifactRecord` only
 * exists for content that was actually persisted.
 *
 * Stage 1 defines this shape generically so stage 2 (auditing the existing
 * JSON fetch call sites in src/json-extraction/**) can reuse it without
 * having to invent a new diagnostic shape per call site.
 */

export const FetchOutcomeSchema = z.union([
  z.literal('success'),
  z.literal('http-error'),
  z.literal('network-error'),
  z.literal('parse-error'),
  z.literal('rejected'),
]);
export type FetchOutcome = z.infer<typeof FetchOutcomeSchema>;

export const FetchDiagnosticSchema = z.object({
  url: z.string().trim().min(1),
  expectedKind: ArtifactKindSchema,
  sourceRoute: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  contentType: z.string().nullable(),
  outcome: FetchOutcomeSchema,
  /** Set when outcome is "parse-error": the JSON/text parse failure message. */
  parseError: z.string().nullable(),
  /** Set when outcome is "network-error": the underlying network/transport failure message. */
  networkError: z.string().nullable(),
  /** Human-readable reason the candidate artifact was accepted or rejected (e.g. "accepted: valid page-data shape", "rejected: missing collectionId"). */
  reason: z.string().nullable(),
  /** ISO-8601 timestamp of the fetch attempt. */
  attemptedAt: z.string().trim().min(1),
});
export type FetchDiagnostic = z.infer<typeof FetchDiagnosticSchema>;

export const FetchDiagnosticListSchema = z.array(FetchDiagnosticSchema);
export type FetchDiagnosticList = z.infer<typeof FetchDiagnosticListSchema>;

export type CreateFetchDiagnosticInput = {
  url: string;
  expectedKind: FetchDiagnostic['expectedKind'];
  sourceRoute?: string | null;
  httpStatus?: number | null;
  contentType?: string | null;
  outcome: FetchOutcome;
  parseError?: string | null;
  networkError?: string | null;
  reason?: string | null;
  attemptedAt?: string;
};

/** Builds a validated FetchDiagnostic record, filling in sensible defaults for optional fields. */
export function createFetchDiagnostic(input: CreateFetchDiagnosticInput): FetchDiagnostic {
  return FetchDiagnosticSchema.parse({
    url: input.url,
    expectedKind: input.expectedKind,
    sourceRoute: input.sourceRoute ?? null,
    httpStatus: input.httpStatus ?? null,
    contentType: input.contentType ?? null,
    outcome: input.outcome,
    parseError: input.parseError ?? null,
    networkError: input.networkError ?? null,
    reason: input.reason ?? null,
    attemptedAt: input.attemptedAt ?? new Date().toISOString(),
  });
}
