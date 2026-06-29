import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultCacheDir } from '../cache.js';
import {
  ArtifactRecordListSchema,
  type ArtifactKind,
  type ArtifactRecord,
} from './artifact-types.js';

/**
 * Maintains a queryable index of all raw artifacts persisted under
 * `raw/**`. Persisted as its own JSON file (`raw/artifact-index.json`)
 * rather than embedded in `manifest.json`, so the index can grow large
 * (one entry per page-data/carbon-content/dsdb-resource fetch) without
 * bloating the small, frequently-read top-level manifest.
 */

export function artifactIndexPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'raw', 'artifact-index.json');
}

export type ArtifactIndex = {
  artifacts: ArtifactRecord[];
};

/** Reads the persisted artifact index, or an empty index if none exists yet / it is invalid. */
export async function readArtifactIndex(cacheDir = getDefaultCacheDir()): Promise<ArtifactIndex> {
  try {
    const raw: unknown = JSON.parse(await readFile(artifactIndexPath(cacheDir), 'utf8'));
    const parsed = ArtifactRecordListSchema.safeParse(raw);
    return { artifacts: parsed.success ? parsed.data : [] };
  } catch {
    return { artifacts: [] };
  }
}

/** Writes the artifact index to disk, replacing any existing index. */
export async function writeArtifactIndex(index: ArtifactIndex, cacheDir = getDefaultCacheDir()): Promise<void> {
  const filePath = artifactIndexPath(cacheDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(index.artifacts, null, 2)}\n`, 'utf8');
}

/**
 * Adds or replaces an artifact record in the index (matched by id) and
 * persists the updated index. Returns the updated index.
 */
export async function upsertArtifactRecord(
  record: ArtifactRecord,
  cacheDir = getDefaultCacheDir()
): Promise<ArtifactIndex> {
  const current = await readArtifactIndex(cacheDir);
  const withoutExisting = current.artifacts.filter((existing) => existing.id !== record.id);
  const next: ArtifactIndex = { artifacts: [...withoutExisting, record] };
  await writeArtifactIndex(next, cacheDir);
  return next;
}

export function findArtifactById(index: ArtifactIndex, id: string): ArtifactRecord | null {
  return index.artifacts.find((artifact) => artifact.id === id) ?? null;
}

export function findArtifactsByKind(index: ArtifactIndex, kind: ArtifactKind): ArtifactRecord[] {
  return index.artifacts.filter((artifact) => artifact.kind === kind);
}

export function findArtifactsBySourceRoute(index: ArtifactIndex, sourceRoute: string): ArtifactRecord[] {
  return index.artifacts.filter((artifact) => artifact.sourceRoute === sourceRoute);
}
