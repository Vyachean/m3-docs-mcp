import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getDefaultCacheDir, readIndex } from './cache.js';
import { readPageGraph, readRouteGraph, readTokenTableGraph } from './graph/graph-store.js';
import { findArtifactsByKind, readArtifactIndex } from './raw-artifacts/artifact-index.js';

/**
 * Cache schema v2 manifest (`manifest.json` at the cache directory root).
 *
 * This sits alongside the existing v1 `index.json` (written by
 * src/cache.ts's `writeIndex`) without replacing it — `index.json` remains
 * the source of truth for the existing Markdown-rendering pipeline and MCP
 * tools. `manifest.json` is the entry point for the new raw-snapshot-first
 * cache: it records what raw artifacts/graph/markdown/coverage exist and
 * their health, without itself containing page content.
 */

export const ManifestHealthSchema = z.union([
  z.literal('unverified'),
  z.literal('verified'),
  z.literal('partial'),
  z.literal('degraded'),
  z.literal('failed'),
]);
export type ManifestHealth = z.infer<typeof ManifestHealthSchema>;

export const ManifestHealthSummarySchema = z.object({
  rawSnapshot: ManifestHealthSchema,
  graph: ManifestHealthSchema,
  markdown: ManifestHealthSchema,
  coverage: ManifestHealthSchema,
});
export type ManifestHealthSummary = z.infer<typeof ManifestHealthSummarySchema>;

export const ManifestCountsSchema = z.object({
  rawArtifacts: z.number().int().nonnegative(),
  routes: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  markdownPages: z.number().int().nonnegative(),
  dsdbResources: z.number().int().nonnegative(),
  tokenTables: z.number().int().nonnegative(),
});
export type ManifestCounts = z.infer<typeof ManifestCountsSchema>;

export const CacheManifestSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1),
  carbonVersion: z.string().nullable(),
  siteMetaHash: z.string().nullable(),
  angularBundleHash: z.string().nullable(),
  sitemapHash: z.string().nullable(),
  counts: ManifestCountsSchema,
  health: ManifestHealthSummarySchema,
});
export type CacheManifest = z.infer<typeof CacheManifestSchema>;

const DEFAULT_COUNTS: ManifestCounts = {
  rawArtifacts: 0,
  routes: 0,
  pages: 0,
  markdownPages: 0,
  dsdbResources: 0,
  tokenTables: 0,
};

const DEFAULT_HEALTH: ManifestHealthSummary = {
  rawSnapshot: 'unverified',
  graph: 'unverified',
  markdown: 'unverified',
  coverage: 'unverified',
};

export type CreateCacheManifestInput = {
  baseUrl: string;
  carbonVersion?: string | null;
  siteMetaHash?: string | null;
  angularBundleHash?: string | null;
  sitemapHash?: string | null;
  counts?: Partial<ManifestCounts>;
  health?: Partial<ManifestHealthSummary>;
  generatedAt?: string;
};

/** Builds a validated cache schema v2 manifest. */
export function createCacheManifest(input: CreateCacheManifestInput): CacheManifest {
  return CacheManifestSchema.parse({
    schemaVersion: 2,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    baseUrl: input.baseUrl,
    carbonVersion: input.carbonVersion ?? null,
    siteMetaHash: input.siteMetaHash ?? null,
    angularBundleHash: input.angularBundleHash ?? null,
    sitemapHash: input.sitemapHash ?? null,
    counts: { ...DEFAULT_COUNTS, ...input.counts },
    health: { ...DEFAULT_HEALTH, ...input.health },
  });
}

export function manifestPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'manifest.json');
}

/** Reads the cache schema v2 manifest, or null if it doesn't exist / fails validation. */
export async function readManifest(cacheDir = getDefaultCacheDir()): Promise<CacheManifest | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(manifestPath(cacheDir), 'utf8'));
    const parsed = CacheManifestSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Returns the count summary of the canonical persisted owners that currently exist on disk.
 *
 * Missing or invalid owners contribute zero here; presence/schema validity remains the
 * responsibility of the dedicated cache/graph/raw validators. Keeping count derivation here gives
 * generation and manifest-consistency validation one definition for what every count means.
 */
export async function readPersistedManifestCounts(cacheDir = getDefaultCacheDir()): Promise<ManifestCounts> {
  const [artifactIndex, routeGraph, pageGraph, tokenTableGraph, index] = await Promise.all([
    readArtifactIndex(cacheDir),
    readRouteGraph(cacheDir),
    readPageGraph(cacheDir),
    readTokenTableGraph(cacheDir),
    readIndex(cacheDir),
  ]);

  return ManifestCountsSchema.parse({
    rawArtifacts: artifactIndex.artifacts.length,
    routes: routeGraph?.routes.length ?? 0,
    pages: pageGraph?.pages.length ?? 0,
    markdownPages: index?.pages.length ?? 0,
    dsdbResources: findArtifactsByKind(artifactIndex, 'dsdb-resource').length,
    tokenTables: tokenTableGraph?.tokenTables.length ?? 0,
  });
}

/** Writes the validated cache schema v2 manifest supplied by its caller. */
export async function writeManifest(manifest: CacheManifest, cacheDir = getDefaultCacheDir()): Promise<void> {
  const validatedManifest = CacheManifestSchema.parse(manifest);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(manifestPath(cacheDir), `${JSON.stringify(validatedManifest, null, 2)}\n`, 'utf8');
}
