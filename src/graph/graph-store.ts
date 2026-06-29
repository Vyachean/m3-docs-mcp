import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultCacheDir } from '../cache.js';
import {
  PageGraphSchema,
  ProvenanceGraphSchema,
  ResourceGraphSchema,
  RouteGraphSchema,
  SectionGraphSchema,
  TokenTableGraphSchema,
  type PageGraph,
  type ProvenanceGraph,
  type ResourceGraph,
  type RouteGraph,
  type SectionGraph,
  type TokenTableGraph,
} from './graph-types.js';

/**
 * Persistence layer for the documentation graph (`graph/*.json` under the cache directory),
 * mirroring the read/write conventions of manifest.ts and raw-artifacts/artifact-index.ts:
 * write the validated shape with a trailing newline, read back through the same zod schema and
 * return null on any failure (missing file, invalid JSON, schema mismatch) rather than throwing.
 */

export function graphDir(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'graph');
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson<T>(filePath: string, schema: { safeParse: (raw: unknown) => { success: boolean; data?: T } }): Promise<T | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    const parsed = schema.safeParse(raw);
    return parsed.success ? (parsed.data ?? null) : null;
  } catch {
    return null;
  }
}

export function routeGraphPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(graphDir(cacheDir), 'routes.json');
}
export function pageGraphPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(graphDir(cacheDir), 'pages.json');
}
export function resourceGraphPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(graphDir(cacheDir), 'resources.json');
}
export function tokenTableGraphPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(graphDir(cacheDir), 'token-tables.json');
}
export function provenanceGraphPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(graphDir(cacheDir), 'provenance.json');
}
export function sectionGraphPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(graphDir(cacheDir), 'sections.json');
}

export async function writeRouteGraph(graph: RouteGraph, cacheDir = getDefaultCacheDir()): Promise<void> {
  await writeJson(routeGraphPath(cacheDir), graph);
}
export async function readRouteGraph(cacheDir = getDefaultCacheDir()): Promise<RouteGraph | null> {
  return readJson(routeGraphPath(cacheDir), RouteGraphSchema);
}

export async function writePageGraph(graph: PageGraph, cacheDir = getDefaultCacheDir()): Promise<void> {
  await writeJson(pageGraphPath(cacheDir), graph);
}
export async function readPageGraph(cacheDir = getDefaultCacheDir()): Promise<PageGraph | null> {
  return readJson(pageGraphPath(cacheDir), PageGraphSchema);
}

export async function writeResourceGraph(graph: ResourceGraph, cacheDir = getDefaultCacheDir()): Promise<void> {
  await writeJson(resourceGraphPath(cacheDir), graph);
}
export async function readResourceGraph(cacheDir = getDefaultCacheDir()): Promise<ResourceGraph | null> {
  return readJson(resourceGraphPath(cacheDir), ResourceGraphSchema);
}

export async function writeTokenTableGraph(graph: TokenTableGraph, cacheDir = getDefaultCacheDir()): Promise<void> {
  await writeJson(tokenTableGraphPath(cacheDir), graph);
}
export async function readTokenTableGraph(cacheDir = getDefaultCacheDir()): Promise<TokenTableGraph | null> {
  return readJson(tokenTableGraphPath(cacheDir), TokenTableGraphSchema);
}

export async function writeProvenanceGraph(graph: ProvenanceGraph, cacheDir = getDefaultCacheDir()): Promise<void> {
  await writeJson(provenanceGraphPath(cacheDir), graph);
}
export async function readProvenanceGraph(cacheDir = getDefaultCacheDir()): Promise<ProvenanceGraph | null> {
  return readJson(provenanceGraphPath(cacheDir), ProvenanceGraphSchema);
}

export async function writeSectionGraph(graph: SectionGraph, cacheDir = getDefaultCacheDir()): Promise<void> {
  await writeJson(sectionGraphPath(cacheDir), graph);
}
export async function readSectionGraph(cacheDir = getDefaultCacheDir()): Promise<SectionGraph | null> {
  return readJson(sectionGraphPath(cacheDir), SectionGraphSchema);
}
