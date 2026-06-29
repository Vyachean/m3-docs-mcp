import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultCacheDir } from '../cache.js';
import { normalizeGraphRoute, routeToMarkdownPath } from '../graph/route-identity.js';
import { rebuildMarkdownFromRaw } from '../rendered/markdown-renderer.js';
import { readRendererReport } from '../rendered/renderer-report.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * Stage 5 of `verify:cache:full`: Markdown rendering quality.
 *
 * Three complementary checks:
 *  1. `diagnostics/renderer-report.json`'s `requiredRouteFailures` must be empty — the renderer
 *     report already tracks, per required route, any error-severity unsupported chunk / unresolved
 *     resource / unresolved token-or-status table finding (see src/rendered/renderer-report.ts).
 *  2. A textual placeholder scan of generated `pages/**\/specs.md` files, matching the
 *     PLACEHOLDER_PATTERNS this script already used before stage 8 — kept as a second,
 *     independent signal in case a route's renderer-report entry doesn't yet exist (e.g. an older
 *     cache promoted before stage 5's wiring) but the rendered Markdown text still shows the
 *     unresolved-placeholder symptom.
 *  3. A fixed set of required generated Markdown pages (`REQUIRED_PAGE_PATHS`, carried over
 *     unchanged from the pre-stage-8 script) must exist on disk under the cache dir — this is the
 *     "direct JSON path producing zero useful pages" / missing-deliverable signal at the file
 *     level, independent of what the renderer report or graph claim.
 *
 * Bug fix (the documented stage 8 Windows-path bug): the previous inline implementation of
 * `collectSpecMarkdownFiles` in scripts/verify-full-cache-refresh.mjs filtered with
 * `filePath.endsWith('/specs.md')`, which silently matches zero files on Windows, where
 * `path.join` produces backslash-separated paths (`pages\\components\\switch\\specs.md`) and the
 * literal `/specs.md` suffix never appears. `isSpecMarkdownFile` below uses `path.basename`
 * instead, which is platform-correct: it only cares about the final path segment, regardless of
 * which separator the underlying OS/path.join used to build it.
 */

export const REQUIRED_PAGE_PATHS: readonly string[] = [
  'pages/components/switch/overview.md',
  'pages/components/switch/specs.md',
  'pages/components/buttons/overview.md',
  'pages/components/buttons/specs.md',
  'pages/components/lists/overview.md',
  'pages/components/lists/specs.md',
  'pages/components/segmented-buttons/overview.md',
  'pages/components/segmented-buttons/specs.md',
];

export const PLACEHOLDER_PATTERNS: readonly string[] = [
  '[TOKEN_TABLE placeholder',
  'missing-requested-token-sets',
  'missing-token-system',
  'missing-resource-name',
];

/** Platform-correct replacement for the old `filePath.endsWith('/specs.md')` check.
 *
 * The original bug: `path.join` on Windows produces backslash-separated paths
 * (`pages\components\switch\specs.md`), so a literal `/specs.md` suffix check silently matches
 * zero files there. Using `path.basename` alone is not quite enough either: Node's POSIX
 * `path.basename` does not treat `\` as a separator, so on a POSIX test runner a Windows-style
 * input string would still fail. This function explicitly splits on both `/` and `\` to find the
 * final path segment, independent of which separator built the string or which OS is running the
 * check — `path.join`'s own platform-native separator is irrelevant once we compare segments
 * instead of raw suffixes. */
export function isSpecMarkdownFile(filePath: string): boolean {
  const segments = filePath.split(/[/\\]+/).filter(Boolean);
  return segments.at(-1) === 'specs.md';
}

async function walk(currentDir: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, results);
      continue;
    }
    if (entry.isFile()) results.push(entryPath);
  }
}

export async function collectSpecMarkdownFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  await walk(rootDir, results);
  return results.filter(isSpecMarkdownFile);
}

export type ValidateRenderedOutputInput = {
  cacheDir?: string;
  /** "smoke" runs skip the REQUIRED_PAGE_PATHS file-existence check, mirroring the original
   *  script's `mode === 'full'` gate (a 20-40 page smoke crawl is not expected to cover every
   *  required component). Defaults to "full". */
  mode?: 'smoke' | 'full';
  rebuildFromRawFn?: typeof rebuildMarkdownFromRaw;
};

export async function validateRenderedOutput(input: ValidateRenderedOutputInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const mode = input.mode ?? 'full';
  const stage = 'rendered-output';
  const reasons: string[] = [];
  const rebuildFromRawFn = input.rebuildFromRawFn ?? rebuildMarkdownFromRaw;

  const rendererReport = await readRendererReport(cacheDir);
  if (!rendererReport) {
    reasons.push('diagnostics/renderer-report.json is missing or failed schema validation.');
  } else if (rendererReport.requiredRouteFailures.length > 0) {
    reasons.push(
      `Required route(s) with renderer error-severity findings: ${rendererReport.requiredRouteFailures.join(', ')}.`
    );
  }

  if (mode === 'full') {
    const missingRequiredPages: string[] = [];
    for (const relativePath of REQUIRED_PAGE_PATHS) {
      const absolutePath = path.join(cacheDir, relativePath);
      try {
        await access(absolutePath);
      } catch {
        missingRequiredPages.push(relativePath);
      }
    }
    if (missingRequiredPages.length > 0) {
      reasons.push(`Missing required generated page(s): ${missingRequiredPages.join(', ')}.`);
    }
  }

  const pagesDir = path.join(cacheDir, 'pages');
  const specFiles = await collectSpecMarkdownFiles(pagesDir);
  const placeholderFailures: Array<{ path: string; pattern: string }> = [];
  for (const filePath of specFiles) {
    const markdown = await readFile(filePath, 'utf8');
    const matchedPattern = PLACEHOLDER_PATTERNS.find((pattern) => markdown.includes(pattern));
    if (!matchedPattern) continue;
    placeholderFailures.push({ path: path.relative(cacheDir, filePath), pattern: matchedPattern });
  }
  if (placeholderFailures.length > 0) {
    const summary = placeholderFailures.slice(0, 10).map((f) => `${f.path} -> ${f.pattern}`).join('; ');
    reasons.push(
      `Unresolved token/status table placeholders in generated specs pages: ${summary}${placeholderFailures.length > 10 ? `; and ${placeholderFailures.length - 10} more` : ''}.`
    );
  }

  if (mode === 'full') {
    const rebuilt = await rebuildFromRawFn(cacheDir);
    const rebuiltByRoute = new Map(rebuilt.pages.map((page) => [normalizeGraphRoute(page.path), page]));
    const requiredOfflineRoutes = REQUIRED_PAGE_PATHS.map((pagePath) => normalizeGraphRoute(pagePath));
    for (const route of requiredOfflineRoutes) {
      const rebuiltPage = rebuiltByRoute.get(normalizeGraphRoute(route));
      if (!rebuiltPage) {
        reasons.push(`Offline rebuild did not produce required route ${route}.`);
        continue;
      }
      const matchedPattern = PLACEHOLDER_PATTERNS.find((pattern) => rebuiltPage.markdown.includes(pattern));
      if (matchedPattern) {
        reasons.push(`Offline rebuild produced unresolved placeholder content for ${route}: ${matchedPattern}.`);
      }
      const expectedPath = routeToMarkdownPath(route);
      if (rebuiltPage.path !== expectedPath) {
        reasons.push(`Offline rebuild produced unexpected output path for ${route}: ${rebuiltPage.path} (expected ${expectedPath}).`);
      }
    }
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, { specFileCount: specFiles.length });
  }

  return passedCheck(stage, { specFileCount: specFiles.length });
}
