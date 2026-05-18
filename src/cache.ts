import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { MaterialIndex, MaterialPage } from './types.js';

export function getDefaultCacheDir(): string {
  if (process.env.M3_DOCS_CACHE_DIR) return process.env.M3_DOCS_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, 'm3-docs-mcp');
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'm3-docs-mcp');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'm3-docs-mcp');
  return path.join(homedir(), '.cache', 'm3-docs-mcp');
}

export function pagesDir(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'pages');
}

export function indexPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'index.json');
}

export async function ensureCacheDirs(cacheDir = getDefaultCacheDir()): Promise<void> {
  await mkdir(pagesDir(cacheDir), { recursive: true });
}

export async function readIndex(cacheDir = getDefaultCacheDir()): Promise<MaterialIndex | null> {
  try {
    return JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as MaterialIndex;
  } catch {
    return null;
  }
}

export async function writeIndex(index: MaterialIndex, cacheDir = getDefaultCacheDir()): Promise<void> {
  await ensureCacheDirs(cacheDir);
  await writeFile(indexPath(cacheDir), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

export async function writePage(page: MaterialPage, cacheDir = getDefaultCacheDir()): Promise<void> {
  await ensureCacheDirs(cacheDir);
  const file = path.join(pagesDir(cacheDir), page.path);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, page.markdown, 'utf8');
}

export async function readPage(pagePath: string, cacheDir = getDefaultCacheDir()): Promise<string> {
  return readFile(path.join(pagesDir(cacheDir), pagePath), 'utf8');
}

export async function cacheAgeMs(cacheDir = getDefaultCacheDir()): Promise<number | null> {
  try {
    const s = await stat(indexPath(cacheDir));
    return Date.now() - s.mtimeMs;
  } catch {
    return null;
  }
}

export function isCacheFresh(ageMs: number | null, maxAgeHours: number): boolean {
  if (ageMs === null) return false;
  return ageMs < maxAgeHours * 60 * 60 * 1000;
}
