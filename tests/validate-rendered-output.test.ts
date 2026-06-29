import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRendererReport } from '../src/rendered/renderer-report.js';
import {
  REQUIRED_PAGE_PATHS,
  collectSpecMarkdownFiles,
  isSpecMarkdownFile,
  validateRenderedOutput,
} from '../src/validation/validate-rendered-output.js';

let cacheDir: string;
const REBUILT_REQUIRED_PAGES = REQUIRED_PAGE_PATHS.map((pagePath) => ({
  id: pagePath,
  title: pagePath,
  url: `https://m3.material.io/${pagePath.replace(/^pages\//, '').replace(/\.md$/, '')}`,
  path: pagePath.replace(/^pages\//, ''),
  section: 'components',
  headings: ['OK'],
  text: 'OK',
  markdown: '# OK',
  capturedAt: '2026-06-01T00:00:00.000Z',
}));

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-rendered-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

async function writePassingRendererReport(): Promise<void> {
  await writeRendererReport({
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    routes: [],
    requiredRouteFailures: [],
  }, cacheDir);
}

async function writeRequiredPages(): Promise<void> {
  for (const relativePath of REQUIRED_PAGE_PATHS) {
    const absolutePath = path.join(cacheDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, '# OK\n\nNo placeholders here.', 'utf8');
  }
}

describe('isSpecMarkdownFile (Windows path bug fix)', () => {
  it('matches a POSIX-style specs.md path', () => {
    expect(isSpecMarkdownFile('pages/components/switch/specs.md')).toBe(true);
  });

  it('matches a Windows-style backslash-separated specs.md path', () => {
    // The original implementation used `filePath.endsWith('/specs.md')`, which is false for this
    // input because there is no forward slash anywhere in it — path.basename-based matching must
    // still correctly identify the final segment as "specs.md" regardless of separator.
    const windowsStylePath = 'pages\\components\\switch\\specs.md';
    expect(isSpecMarkdownFile(windowsStylePath)).toBe(true);
  });

  it('does not match a Windows-style path for a different file', () => {
    expect(isSpecMarkdownFile('pages\\components\\switch\\overview.md')).toBe(false);
  });

  it('does not match a POSIX-style path for a different file', () => {
    expect(isSpecMarkdownFile('pages/components/switch/overview.md')).toBe(false);
  });

  it('does not match a path that merely contains "specs.md" as a substring of a longer segment', () => {
    expect(isSpecMarkdownFile('pages/components/switch/not-specs.md.bak')).toBe(false);
  });
});

describe('collectSpecMarkdownFiles', () => {
  it('finds all specs.md files recursively under a real directory tree', async () => {
    const pagesDir = path.join(cacheDir, 'pages');
    await mkdir(path.join(pagesDir, 'components', 'switch'), { recursive: true });
    await mkdir(path.join(pagesDir, 'components', 'buttons'), { recursive: true });
    await writeFile(path.join(pagesDir, 'components', 'switch', 'specs.md'), '# Switch specs', 'utf8');
    await writeFile(path.join(pagesDir, 'components', 'switch', 'overview.md'), '# Switch overview', 'utf8');
    await writeFile(path.join(pagesDir, 'components', 'buttons', 'specs.md'), '# Buttons specs', 'utf8');

    const found = await collectSpecMarkdownFiles(pagesDir);
    expect(found.sort()).toEqual([
      path.join(pagesDir, 'components', 'buttons', 'specs.md'),
      path.join(pagesDir, 'components', 'switch', 'specs.md'),
    ].sort());
  });

  it('returns an empty array when the directory does not exist', async () => {
    const found = await collectSpecMarkdownFiles(path.join(cacheDir, 'does-not-exist'));
    expect(found).toEqual([]);
  });
});

describe('validateRenderedOutput', () => {
  it('fails when diagnostics/renderer-report.json is missing', async () => {
    await writeRequiredPages();
    const result = await validateRenderedOutput({ cacheDir, mode: 'full', rebuildFromRawFn: async () => ({ pages: REBUILT_REQUIRED_PAGES, report: { schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', routes: [], requiredRouteFailures: [] } }) });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('renderer-report.json is missing'))).toBe(true);
  });

  it('fails when requiredRouteFailures is non-empty', async () => {
    await writeRendererReport({
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      routes: [],
      requiredRouteFailures: ['/components/switch/specs'],
    }, cacheDir);
    await writeRequiredPages();
    const result = await validateRenderedOutput({ cacheDir, mode: 'full', rebuildFromRawFn: async () => ({ pages: REBUILT_REQUIRED_PAGES, report: { schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', routes: [], requiredRouteFailures: [] } }) });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('/components/switch/specs'))).toBe(true);
  });

  it('fails on full mode when a required generated page is missing', async () => {
    await writePassingRendererReport();
    const result = await validateRenderedOutput({ cacheDir, mode: 'full', rebuildFromRawFn: async () => ({ pages: REBUILT_REQUIRED_PAGES, report: { schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', routes: [], requiredRouteFailures: [] } }) });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Missing required generated page'))).toBe(true);
  });

  it('does not check required generated pages on smoke mode', async () => {
    await writePassingRendererReport();
    const result = await validateRenderedOutput({ cacheDir, mode: 'smoke' });
    expect(result.passed).toBe(true);
  });

  it('fails when a specs.md file contains an unresolved token table placeholder', async () => {
    await writePassingRendererReport();
    await writeRequiredPages();
    const specsPath = path.join(cacheDir, 'pages', 'components', 'switch', 'specs.md');
    await writeFile(specsPath, '# Switch specs\n\n[TOKEN_TABLE placeholder: missing-requested-token-sets]', 'utf8');
    const result = await validateRenderedOutput({ cacheDir, mode: 'full', rebuildFromRawFn: async () => ({ pages: REBUILT_REQUIRED_PAGES, report: { schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', routes: [], requiredRouteFailures: [] } }) });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('placeholder'))).toBe(true);
  });

  it('passes when everything is in order', async () => {
    await writePassingRendererReport();
    await writeRequiredPages();
    const result = await validateRenderedOutput({ cacheDir, mode: 'full', rebuildFromRawFn: async () => ({ pages: REBUILT_REQUIRED_PAGES, report: { schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', routes: [], requiredRouteFailures: [] } }) });
    expect(result.reasons).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails when offline rebuild misses a required route', async () => {
    await writePassingRendererReport();
    await writeRequiredPages();
    const result = await validateRenderedOutput({
      cacheDir,
      mode: 'full',
      rebuildFromRawFn: async () => ({
        pages: REBUILT_REQUIRED_PAGES.filter((page) => page.path !== 'components/switch/specs.md'),
        report: { schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', routes: [], requiredRouteFailures: [] }
      })
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('Offline rebuild did not produce required route /components/switch/specs'))).toBe(true);
  });
});
