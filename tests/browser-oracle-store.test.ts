import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readRequiredRoutesCapture,
  requiredRoutesCapturePath,
  writeRequiredRoutesCapture,
} from '../src/browser-oracle/browser-oracle-store.js';
import type { RequiredRoutesCaptureReport } from '../src/browser-oracle/browser-oracle-types.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-browser-oracle-store-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('browser-oracle-store.ts', () => {
  it('writes the capture report under raw/network/required-routes.capture.json and reads it back', async () => {
    const report: RequiredRoutesCaptureReport = {
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      baseUrl: 'https://m3.material.io',
      routes: [
        {
          route: '/components/switch/overview',
          requestedUrl: 'https://m3.material.io/components/switch/overview',
          finalUrl: 'https://m3.material.io/components/switch/overview',
          navigationError: null,
          networkResources: [],
          dom: { headings: ['Switch'], visibleTableLabels: [] }
        }
      ]
    };

    expect(requiredRoutesCapturePath(cacheDir)).toBe(path.join(cacheDir, 'raw', 'network', 'required-routes.capture.json'));

    await writeRequiredRoutesCapture(report, cacheDir);
    const readBack = await readRequiredRoutesCapture(cacheDir);

    expect(readBack).toEqual(report);
  });

  it('returns null when no capture report has been written yet', async () => {
    const readBack = await readRequiredRoutesCapture(cacheDir);
    expect(readBack).toBeNull();
  });
});
