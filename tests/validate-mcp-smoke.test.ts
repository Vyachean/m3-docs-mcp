import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePageGraph } from '../src/graph/graph-store.js';
import type { PageNode } from '../src/graph/graph-types.js';
import { validateMcpSmoke } from '../src/validation/validate-mcp-smoke.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-mcp-smoke-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const REQUIRED_ROUTES = ['/components/switch/specs'];

function makePage(overrides: Partial<PageNode> = {}): PageNode {
  return {
    pageId: 'switch-specs',
    route: '/components/switch/specs',
    title: 'Switch',
    section: 'components',
    tabs: [],
    headings: ['Switch'],
    sections: [{ sectionId: 'sec-1', title: 'Specs', headingLevel: 1, chunkIds: ['chunk-1'] }],
    chunks: [{ chunkId: 'chunk-1', chunkType: 'resource', resourceId: 'token-table:switch', textExcerpt: null }],
    resourceIds: ['token-table:switch'],
    tokenTableIds: ['token-table:switch'],
    unsupportedChunkTypes: [],
    provenance: { sourceArtifacts: [], sourceRoute: '/components/switch/specs', canonicalRoute: '/components/switch/specs', virtualRoute: null },
    ...overrides,
  };
}

describe('validateMcpSmoke', () => {
  it('fails when graph/pages.json is not available', async () => {
    const result = await validateMcpSmoke({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/graph\/pages\.json is not available/);
  });

  it('fails when the required route has no matching page', async () => {
    await writePageGraph({ schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', pages: [] }, cacheDir);
    const result = await validateMcpSmoke({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('no page for required route'))).toBe(true);
  });

  it('passes when the structured page has sections, chunks, resources, and token tables', async () => {
    await writePageGraph({ schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', pages: [makePage()] }, cacheDir);
    const result = await validateMcpSmoke({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails when a specs route has no tokenTableIds', async () => {
    await writePageGraph({ schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', pages: [makePage({ tokenTableIds: [] })] }, cacheDir);
    const result = await validateMcpSmoke({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('no tokenTableIds'))).toBe(true);
  });

  it('fails when sections/chunks/resourceIds are empty', async () => {
    await writePageGraph({
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      pages: [makePage({ sections: [], chunks: [], resourceIds: [] })],
    }, cacheDir);
    const result = await validateMcpSmoke({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('no sections'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('no chunks'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('no resourceIds'))).toBe(true);
  });
});
