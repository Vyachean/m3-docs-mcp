import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultCacheDir } from '../cache.js';
import { sha256Hex } from './hash.js';
import {
  ArtifactRecordSchema,
  type ArtifactDiagnosticMetadata,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactSourceMethod,
} from './artifact-types.js';

/**
 * Persistence layer for raw artifacts (cache schema v2). Raw artifacts are
 * stored under `<cacheDir>/raw/**` following the kind-specific layout
 * documented in the project architecture notes (see AGENTS.md context):
 *
 *   raw/site/shell.html
 *   raw/site/site_meta.js
 *   raw/site/main.<hash>.js
 *   raw/site/sitemap.xml
 *   raw/page-data/<collectionId>/<documentId>.json
 *   raw/carbon-content/<carbonVersion>/<exportedCarbonFileId>.json
 *   raw/dsdb/<carbonVersion>/<resource-id>.json
 *   raw/network/required-routes.capture.json
 *
 * This module does not interpret artifact contents — it only persists bytes
 * or text and records provenance metadata (hash, status, content type,
 * source). Interpretation happens in later stages (graph builder).
 */

export function rawDir(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'raw');
}

/** Appends a ".json" extension to the last segment of a path-part list, unless it already has an extension. */
function withJsonExtension(segments: string[]): string[] {
  if (segments.length === 0) return segments;
  const last = segments[segments.length - 1] ?? '';
  const hasExtension = /\.[a-z0-9]+$/i.test(last);
  return [...segments.slice(0, -1), hasExtension ? last : `${last}.json`];
}

/** Builds the local (cache-dir-relative) path for a given artifact kind and logical name parts. */
export function artifactLocalPath(kind: ArtifactKind, parts: string[]): string {
  const segments = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  switch (kind) {
    case 'site-shell':
      return path.posix.join('raw', 'site', 'shell.html');
    case 'site-meta':
      return path.posix.join('raw', 'site', 'site_meta.js');
    case 'angular-bundle':
      return path.posix.join('raw', 'site', segments[0] ?? 'main.js');
    case 'sitemap':
      return path.posix.join('raw', 'site', 'sitemap.xml');
    case 'page-data':
      return path.posix.join('raw', 'page-data', ...withJsonExtension(segments));
    case 'carbon-content':
      return path.posix.join('raw', 'carbon-content', ...withJsonExtension(segments));
    case 'dsdb-resource':
      return path.posix.join('raw', 'dsdb', ...withJsonExtension(segments));
    case 'network-capture':
      return path.posix.join('raw', 'network', segments[0] ?? 'required-routes.capture.json');
  }
}

/** Derives a stable artifact id from its kind and local path. */
export function artifactId(kind: ArtifactKind, localPath: string): string {
  return `${kind}:${localPath}`;
}

export type PersistArtifactInput = {
  kind: ArtifactKind;
  /** Logical name parts used to build the local path (e.g. [collectionId, documentId] for page-data). */
  pathParts: string[];
  sourceUrl: string;
  content: Buffer | string;
  httpStatus?: number | null;
  contentType?: string | null;
  sourceRoute?: string | null;
  sourceMethod: ArtifactSourceMethod;
  error?: string | null;
  diagnostics?: ArtifactDiagnosticMetadata | null;
  /** ISO-8601 timestamp; defaults to now. */
  fetchedAt?: string;
};

/**
 * Persists a fetched raw artifact's content to disk under the kind-specific
 * `raw/**` layout and returns its provenance record. Does not update any
 * index — callers that need a queryable index should also call
 * `artifact-index.ts` helpers with the returned record.
 */
export async function persistArtifact(
  input: PersistArtifactInput,
  cacheDir = getDefaultCacheDir()
): Promise<ArtifactRecord> {
  const localPath = artifactLocalPath(input.kind, input.pathParts);
  const absolutePath = path.join(cacheDir, localPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  if (typeof input.content === 'string') {
    await writeFile(absolutePath, input.content, 'utf8');
  } else {
    await writeFile(absolutePath, input.content);
  }

  const record: ArtifactRecord = {
    id: artifactId(input.kind, localPath),
    kind: input.kind,
    sourceUrl: input.sourceUrl,
    localPath,
    httpStatus: input.httpStatus ?? null,
    contentType: input.contentType ?? null,
    sha256: sha256Hex(input.content),
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    sourceRoute: input.sourceRoute ?? null,
    sourceMethod: input.sourceMethod,
    error: input.error ?? null,
    diagnostics: input.diagnostics ?? null,
  };

  const parsed = ArtifactRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error(`Failed to build a valid artifact record for ${localPath}: ${parsed.error.message}`);
  }

  return parsed.data;
}

/** Reads back the raw content of an artifact by its local path (relative to the cache dir), as a Buffer. */
export async function readArtifactContent(localPath: string, cacheDir = getDefaultCacheDir()): Promise<Buffer> {
  return readFile(path.join(cacheDir, localPath));
}

/** Reads back the raw content of an artifact by its local path, decoded as UTF-8 text. */
export async function readArtifactText(localPath: string, cacheDir = getDefaultCacheDir()): Promise<string> {
  return readFile(path.join(cacheDir, localPath), 'utf8');
}
