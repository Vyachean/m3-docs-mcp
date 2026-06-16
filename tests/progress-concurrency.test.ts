import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeEta, formatDurationMs } from '../src/progress.js';
import { createCliProgressRenderer } from '../src/index.js';
import type { CrawlProgress } from '../src/types.js';

// ── ETA / progress utilities ─────────────────────────────────────────────────

describe('computeEta', () => {
  it('returns null before enough pages are processed', () => {
    expect(computeEta(2, 100, 30_000)).toBeNull();
  });

  it('returns null before enough elapsed time', () => {
    expect(computeEta(10, 100, 5_000)).toBeNull();
  });

  it('returns rate and ETA after threshold is met', () => {
    // 5 pages in 20 s → 0.25 pages/s; 95 remaining → 380 s
    const result = computeEta(5, 100, 20_000);
    expect(result).not.toBeNull();
    expect(result!.ratePagesPerSecond).toBeCloseTo(0.25, 5);
    expect(result!.estimatedRemainingMs).toBeCloseTo(380_000, -2);
  });

  it('ETA is never negative when more pages than target are processed', () => {
    const result = computeEta(120, 100, 20_000);
    expect(result).not.toBeNull();
    expect(result!.estimatedRemainingMs).toBe(0);
  });

  it('returns null when rate would be zero (zero elapsed)', () => {
    expect(computeEta(10, 100, 0)).toBeNull();
  });

  it('returns null at exact threshold boundary (2 pages / 9999 ms)', () => {
    expect(computeEta(2, 100, 9_999)).toBeNull();
  });

  it('returns result at minimum threshold (3 pages, 10000 ms)', () => {
    const result = computeEta(3, 100, 10_000);
    expect(result).not.toBeNull();
    expect(result!.ratePagesPerSecond).toBeCloseTo(0.3, 5);
  });
});

describe('formatDurationMs', () => {
  it('formats sub-minute durations as Ns', () => {
    expect(formatDurationMs(0)).toBe('0s');
    expect(formatDurationMs(42_000)).toBe('42s');
    expect(formatDurationMs(59_499)).toBe('59s');
  });

  it('formats minute-range durations as NmNs', () => {
    expect(formatDurationMs(60_000)).toBe('1m');
    expect(formatDurationMs(78_000)).toBe('1m18s');
    expect(formatDurationMs(120_000)).toBe('2m');
  });

  it('formats hour-range durations as NhNm', () => {
    expect(formatDurationMs(3_600_000)).toBe('1h');
    expect(formatDurationMs(3_660_000)).toBe('1h1m');
    expect(formatDurationMs(7_200_000)).toBe('2h');
  });
});

// ── DSDB concurrency via crawlMaterialDocs ───────────────────────────────────

const fetchJsonConcurrencyTracker = vi.hoisted(() => {
  let currentConcurrent = 0;
  let peakConcurrent = 0;

  return {
    fn: vi.fn(async () => {
      currentConcurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, currentConcurrent);
      await new Promise<void>((r) => setTimeout(r, 20));
      currentConcurrent -= 1;
      return {
        pageData: null,
        contentPage: null,
        responses: [],
        fetchResource: async () => null,
        selectionReasons: []
      };
    }),
    reset: () => { currentConcurrent = 0; peakConcurrent = 0; },
    getPeak: () => peakConcurrent
  };
});

vi.mock('../src/json-extraction/fetch-json-page.js', () => ({
  fetchJsonPageBundle: fetchJsonConcurrencyTracker.fn
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => {
      throw new Error('playwright not available in concurrency test');
    })
  }
}));

const ROUTE_COUNT = 12;

function makeDsdbFetchStub(): ReturnType<typeof vi.fn> {
  const baseHtml = '<html><script src="/static/angular/main.deadbeef.js"></script></html>';
  const routeParts = Array.from(
    { length: ROUTE_COUNT },
    (_, i) => `{"slug":"route-${i}","documentId":"doc${i}","collectionId":"col${i}"}`
  ).join(',');
  const mainJs = `"carbonVersion":"1.0.0" var routes=[${routeParts}]`;

  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = String(url instanceof Request ? url.url : url);
    if (urlStr === 'https://m3.material.io') {
      return { ok: true, text: async () => baseHtml };
    }
    if (urlStr.includes('main.deadbeef.js')) {
      return { ok: true, text: async () => mainJs };
    }
    // sitemap and anything else → 404
    return { ok: false, status: 404, text: async () => '' };
  });
}

describe('DSDB phase concurrency', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-concurrency-test-'));
    fetchJsonConcurrencyTracker.reset();
    fetchJsonConcurrencyTracker.fn.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('does not exceed concurrency=1 in the direct-json phase', async () => {
    vi.stubGlobal('fetch', makeDsdbFetchStub());

    const { crawlMaterialDocs } = await import('../src/crawler.js');
    await crawlMaterialDocs({
      cacheDir,
      maxPages: ROUTE_COUNT,
      minPageCount: 0,
      concurrency: 1,
      force: true
    });

    expect(fetchJsonConcurrencyTracker.fn).toHaveBeenCalledTimes(ROUTE_COUNT);
    expect(fetchJsonConcurrencyTracker.getPeak()).toBe(1);
  }, 10_000);

  it('does not exceed concurrency=4 in the direct-json phase', async () => {
    vi.stubGlobal('fetch', makeDsdbFetchStub());

    const { crawlMaterialDocs } = await import('../src/crawler.js');
    await crawlMaterialDocs({
      cacheDir,
      maxPages: ROUTE_COUNT,
      minPageCount: 0,
      concurrency: 4,
      force: true
    });

    expect(fetchJsonConcurrencyTracker.fn).toHaveBeenCalledTimes(ROUTE_COUNT);
    expect(fetchJsonConcurrencyTracker.getPeak()).toBeGreaterThan(1);
    expect(fetchJsonConcurrencyTracker.getPeak()).toBeLessThanOrEqual(4);
  }, 10_000);

  it('respects the max cap (MAX_CRAWL_CONCURRENCY = 8)', async () => {
    vi.stubGlobal('fetch', makeDsdbFetchStub());

    const { MAX_CRAWL_CONCURRENCY } = await import('../src/constants.js');
    const { parseBoundedPositiveIntegerOption } = await import('../src/options.js');

    expect(() =>
      parseBoundedPositiveIntegerOption('--concurrency', MAX_CRAWL_CONCURRENCY + 1, 1, MAX_CRAWL_CONCURRENCY)
    ).toThrow();
    expect(MAX_CRAWL_CONCURRENCY).toBe(8);
  });

  it('rejects non-positive concurrency values', async () => {
    const { parsePositiveIntegerOption } = await import('../src/options.js');
    expect(() => parsePositiveIntegerOption('--concurrency', 0)).toThrow();
    expect(() => parsePositiveIntegerOption('--concurrency', -1)).toThrow();
    expect(() => parsePositiveIntegerOption('--concurrency', 'abc')).toThrow();
  });
});

// ── onProgress phase reporting ────────────────────────────────────────────────

describe('progress phase reporting', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-progress-test-'));
    fetchJsonConcurrencyTracker.reset();
    fetchJsonConcurrencyTracker.fn.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('emits discovering and direct-json phases via onProgress', async () => {
    vi.stubGlobal('fetch', makeDsdbFetchStub());

    const { crawlMaterialDocs } = await import('../src/crawler.js');
    const phases: CrawlProgress['phase'][] = [];
    await crawlMaterialDocs({
      cacheDir,
      maxPages: ROUTE_COUNT,
      minPageCount: 0,
      concurrency: 2,
      force: true,
      onProgress: (p) => phases.push(p.phase)
    });

    expect(phases).toContain('discovering');
    expect(phases).toContain('direct-json');
    expect(phases[phases.length - 1]).toBe('complete');
  }, 10_000);

  it('emits processedPageCount = savedPageCount + failedPageCount', async () => {
    vi.stubGlobal('fetch', makeDsdbFetchStub());

    const { crawlMaterialDocs } = await import('../src/crawler.js');
    const snapshots: Pick<CrawlProgress, 'processedPageCount' | 'savedPageCount' | 'failedPageCount'>[] = [];
    await crawlMaterialDocs({
      cacheDir,
      maxPages: ROUTE_COUNT,
      minPageCount: 0,
      concurrency: 2,
      force: true,
      onProgress: (p) => snapshots.push({
        processedPageCount: p.processedPageCount,
        savedPageCount: p.savedPageCount,
        failedPageCount: p.failedPageCount
      })
    });

    for (const s of snapshots) {
      expect(s.processedPageCount).toBe(s.savedPageCount + s.failedPageCount);
    }
  }, 10_000);

  it('emits concurrency in every progress snapshot', async () => {
    vi.stubGlobal('fetch', makeDsdbFetchStub());

    const { crawlMaterialDocs } = await import('../src/crawler.js');
    const concurrencies: number[] = [];
    await crawlMaterialDocs({
      cacheDir,
      maxPages: ROUTE_COUNT,
      minPageCount: 0,
      concurrency: 3,
      force: true,
      onProgress: (p) => concurrencies.push(p.concurrency)
    });

    expect(concurrencies.length).toBeGreaterThan(0);
    expect(concurrencies.every((c) => c === 3)).toBe(true);
  }, 10_000);

  it('emits elapsedMs that is non-negative and increasing', async () => {
    vi.stubGlobal('fetch', makeDsdbFetchStub());

    const { crawlMaterialDocs } = await import('../src/crawler.js');
    const elapsed: number[] = [];
    await crawlMaterialDocs({
      cacheDir,
      maxPages: ROUTE_COUNT,
      minPageCount: 0,
      concurrency: 2,
      force: true,
      onProgress: (p) => elapsed.push(p.elapsedMs)
    });

    expect(elapsed.every((ms) => ms >= 0)).toBe(true);
    // elapsed should be non-decreasing
    for (let i = 1; i < elapsed.length; i++) {
      expect(elapsed[i]).toBeGreaterThanOrEqual(elapsed[i - 1]!);
    }
  }, 10_000);
});

// ── CLI renderer ─────────────────────────────────────────────────────────────

function makeProgress(overrides: Partial<CrawlProgress> = {}): CrawlProgress {
  return {
    phase: 'direct-json',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    running: true,
    maxPages: 100,
    concurrency: 4,
    elapsedMs: 30_000,
    processedPageCount: 10,
    targetPageCount: 100,
    attemptedPageCount: 10,
    savedPageCount: 8,
    failedPageCount: 2,
    queuedPageCount: 90,
    activeWorkerCount: 4,
    ratePagesPerSecond: null,
    estimatedRemainingMs: null,
    currentUrls: [],
    lastSavedUrl: null,
    lastFailedUrl: null,
    error: null,
    ...overrides
  };
}

describe('CLI progress renderer', () => {
  let writtenLines: string[];
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    writtenLines = [];
    originalIsTTY = process.stderr.isTTY;
    // Force non-TTY so renderer writes full lines (not \r-overwrite)
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writtenLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stderr, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('formats ETA as "eta=calculating" before enough progress', () => {
    const { onProgress } = createCliProgressRenderer();
    onProgress(makeProgress({ ratePagesPerSecond: null, estimatedRemainingMs: null }));
    expect(writtenLines.join('')).toContain('eta=calculating');
  });

  it('formats ETA with duration when available on direct-json phase', () => {
    const { onProgress } = createCliProgressRenderer();
    onProgress(makeProgress({ estimatedRemainingMs: 78_000, ratePagesPerSecond: 0.42, phase: 'direct-json' }));
    const output = writtenLines.join('');
    expect(output).toContain('eta=1m18s');
  });

  it('formats ETA with "eta≈" prefix on browser-crawl phase', () => {
    const { onProgress } = createCliProgressRenderer();
    onProgress(makeProgress({ estimatedRemainingMs: 42_000, ratePagesPerSecond: 0.5, phase: 'browser-crawl' }));
    const output = writtenLines.join('');
    expect(output).toContain('eta≈42s');
  });

  it('includes phase, elapsed, saved, failed, queued, active, concurrency in output', () => {
    const { onProgress } = createCliProgressRenderer();
    onProgress(makeProgress({
      phase: 'direct-json',
      elapsedMs: 30_000,
      savedPageCount: 8,
      failedPageCount: 2,
      queuedPageCount: 90,
      activeWorkerCount: 4,
      concurrency: 4
    }));
    const output = writtenLines.join('');
    expect(output).toContain('phase=direct-json');
    expect(output).toContain('elapsed=30s');
    expect(output).toContain('saved=8/100');
    expect(output).toContain('failed=2');
    expect(output).toContain('queued=90');
    expect(output).toContain('active=4/4');
  });

  it('throttles output — does not emit a second line within THROTTLE_MS', () => {
    const { onProgress } = createCliProgressRenderer();
    onProgress(makeProgress());
    const countAfterFirst = writtenLines.length;
    // Immediate second call should be suppressed by 1s throttle
    onProgress(makeProgress());
    expect(writtenLines.length).toBe(countAfterFirst);
  });

  it('onBeforeLog writes a newline on TTY when progress line is active', () => {
    // Override to TTY mode for this test
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    const chunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    const { onProgress, onBeforeLog } = createCliProgressRenderer();
    // Render a progress line (writes \r...)
    onProgress(makeProgress());
    // Then simulate a log message needing a clean line
    onBeforeLog();
    expect(chunks.some((c) => c === '\n')).toBe(true);
  });

  it('onBeforeLog does nothing when no progress line has been written', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    const chunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    const { onBeforeLog } = createCliProgressRenderer();
    onBeforeLog(); // no progress rendered yet → should not write newline
    expect(chunks.filter((c) => c === '\n').length).toBe(0);
  });
});

// ── verbose-only per-route logs ───────────────────────────────────────────────

describe('verbose-only per-route log behavior', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-verbose-test-'));
    fetchJsonConcurrencyTracker.reset();
    fetchJsonConcurrencyTracker.fn.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('does not call onBeforeLog in normal (non-verbose) mode when routes silently fail', async () => {
    vi.stubGlobal('fetch', makeDsdbFetchStub());

    const { crawlMaterialDocs } = await import('../src/crawler.js');
    const beforeLogCalls: number[] = [];
    await crawlMaterialDocs({
      cacheDir,
      maxPages: ROUTE_COUNT,
      minPageCount: 0,
      concurrency: 2,
      force: true,
      verbose: false,
      onBeforeLog: () => { beforeLogCalls.push(1); }
    });

    // In non-verbose mode, per-route failures (all routes return null bundle)
    // should not trigger onBeforeLog
    expect(beforeLogCalls.length).toBe(0);
  }, 10_000);
});
