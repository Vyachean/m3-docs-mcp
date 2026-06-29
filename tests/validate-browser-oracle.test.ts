import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertArtifactRecord } from '../src/raw-artifacts/artifact-index.js';
import { persistArtifact } from '../src/raw-artifacts/artifact-store.js';
import { writePageGraph } from '../src/graph/graph-store.js';
import type { PageGraph } from '../src/graph/graph-types.js';
import type { RequiredRoutesCaptureReport } from '../src/browser-oracle/browser-oracle-types.js';
import { validateBrowserOracle } from '../src/validation/validate-browser-oracle.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-oracle-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function makeCapture(overrides: Partial<RequiredRoutesCaptureReport> = {}): RequiredRoutesCaptureReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    baseUrl: 'https://m3.material.io',
    routes: [{
      route: '/components/switch/overview',
      requestedUrl: 'https://m3.material.io/components/switch/overview',
      finalUrl: 'https://m3.material.io/components/switch/overview',
      navigationError: null,
      networkResources: [],
      dom: { headings: ['Switch'], visibleTableLabels: [] },
    }],
    ...overrides,
  };
}

async function writeMatchingPageGraph(): Promise<void> {
  const pageGraph: PageGraph = {
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    pages: [{
      pageId: 'switch-overview',
      route: '/components/switch/overview',
      title: 'Switch',
      section: 'components',
      tabs: [],
      headings: ['Switch'],
      sections: [],
      chunks: [],
      resourceIds: [],
      tokenTableIds: [],
      unsupportedChunkTypes: [],
      provenance: { sourceArtifacts: [], sourceRoute: '/components/switch/overview', canonicalRoute: '/components/switch/overview', virtualRoute: null },
    }],
  };
  await writePageGraph(pageGraph, cacheDir);
}

describe('validateBrowserOracle', () => {
  it('fails (strict by default) when the capture function throws, reporting external-blocked/not-ready', async () => {
    const result = await validateBrowserOracle({
      cacheDir,
      captureRequiredRoutesFn: async () => {
        throw new Error('No Chromium binary available');
      },
    });
    expect(result.passed).toBe(false);
    expect(result.details?.skipped).toBe(true);
    expect(result.details?.strict).toBe(true);
    expect(result.reasons[0]).toMatch(/external-blocked|not-ready/i);
  });

  it('reports a skipped pass (not a hard failure) when strict:false and the capture function throws', async () => {
    const result = await validateBrowserOracle({
      cacheDir,
      strict: false,
      captureRequiredRoutesFn: async () => {
        throw new Error('No Chromium binary available');
      },
    });
    expect(result.passed).toBe(true);
    expect(result.details?.skipped).toBe(true);
    expect(result.reasons[0]).toMatch(/skipped/i);
  });

  it('passes when the capture matches the raw snapshot and page graph', async () => {
    await writeMatchingPageGraph();
    const result = await validateBrowserOracle({
      cacheDir,
      captureRequiredRoutesFn: async () => makeCapture(),
    });
    expect(result.passed).toBe(true);
    expect(result.details?.skipped).toBe(false);
  });

  it('fails when a captured network resource is missing from the raw snapshot', async () => {
    await writeMatchingPageGraph();
    const result = await validateBrowserOracle({
      cacheDir,
      captureRequiredRoutesFn: async () => makeCapture({
        routes: [{
          route: '/components/switch/overview',
          requestedUrl: 'https://m3.material.io/components/switch/overview',
          finalUrl: 'https://m3.material.io/components/switch/overview',
          navigationError: null,
          networkResources: [{
            resourceId: '/_dsm/content/m3/v1/missing-resource.json',
            url: 'https://m3.material.io/_dsm/content/m3/v1/missing-resource.json',
            kind: 'dsm-content',
            httpStatus: 200,
          }],
          dom: { headings: ['Switch'], visibleTableLabels: [] },
        }],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('missing from raw snapshot'))).toBe(true);
  });

  it('fails when a captured heading is missing from the page graph', async () => {
    await writeMatchingPageGraph();
    const result = await validateBrowserOracle({
      cacheDir,
      captureRequiredRoutesFn: async () => makeCapture({
        routes: [{
          route: '/components/switch/overview',
          requestedUrl: 'https://m3.material.io/components/switch/overview',
          finalUrl: 'https://m3.material.io/components/switch/overview',
          navigationError: null,
          networkResources: [],
          dom: { headings: ['Switch', 'Anatomy'], visibleTableLabels: [] },
        }],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('missing headings'))).toBe(true);
  });

  it('fails when navigation itself fails for a required route', async () => {
    await writeMatchingPageGraph();
    const result = await validateBrowserOracle({
      cacheDir,
      captureRequiredRoutesFn: async () => makeCapture({
        routes: [{
          route: '/components/switch/overview',
          requestedUrl: 'https://m3.material.io/components/switch/overview',
          finalUrl: null,
          navigationError: 'Timeout',
          networkResources: [],
          dom: null,
        }],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('navigation failed'))).toBe(true);
  });

  it('persists the capture and comparison reports to disk', async () => {
    await writeMatchingPageGraph();
    await validateBrowserOracle({ cacheDir, captureRequiredRoutesFn: async () => makeCapture() });
    const { readRequiredRoutesCapture, readBrowserOracleComparison } = await import('../src/browser-oracle/browser-oracle-store.js');
    expect(await readRequiredRoutesCapture(cacheDir)).not.toBeNull();
    expect(await readBrowserOracleComparison(cacheDir)).not.toBeNull();
  });
});
