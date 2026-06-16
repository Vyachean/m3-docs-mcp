import { appendFile, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export type UpdateRunDiagnostics = {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  cacheDir: string;
  stagingDir: string | null;
  logFile: string;
  attemptedPages: number;
  savedPages: number;
  failedPages: number;
  failedRoutes: string[];
  skippedBlogCount: number;
  tokenTablesRequested: number;
  tokenTablesResolved: number;
  tokenTablesDecoded: number;
  tokenTablesRendered: number;
  tokenTablesRenderedAsPlaceholder: number;
  tokenTablesUnsupportedSchema: number;
  statusTablesRequested: number;
  statusTablesResolved: number;
  statusTablesDecoded: number;
  statusTablesRendered: number;
  statusTablesRenderedAsPlaceholder: number;
  statusTablesUnsupportedSchema: number;
  resourceChunksRequested: number;
  resourceChunksResolved: number;
  resourceChunksDecoded: number;
  resourceChunksRendered: number;
  resourceChunksPlaceholder: number;
  promotionDecision: 'promoted' | 'rejected' | 'error' | 'pending';
  hasPreviousCache: boolean;
  preservedFailedStagingPath: string | null;
  coverageHealth: string | null;
  elapsedMs?: number | null;
  lastPhase?: string | null;
  concurrency?: number | null;
  lastRatePagesPerSecond?: number | null;
  lastEstimatedRemainingMs?: number | null;
  lastActiveWorkerCount?: number | null;
  lastQueuedPageCount?: number | null;
  directJsonAttemptedPageCount?: number | null;
  browserAttemptedPageCount?: number | null;
  lastCurrentUrls?: string[] | null;
  latestProgress?: ProgressSnapshot | null;
};

export type ProgressSnapshot = {
  phase: string;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
  ratePagesPerSecond: number | null;
  savedPageCount: number;
  failedPageCount: number;
  attemptedPageCount: number;
  directJsonAttemptedPageCount: number;
  browserAttemptedPageCount: number;
  queuedPageCount: number;
  activeWorkerCount: number;
  concurrency: number;
  currentUrls: string[];
  targetPageCount: number | null;
};

const MAX_STRING_LEN = 500;

function truncateSafe(value: string): string {
  if (value.length <= MAX_STRING_LEN) return value;
  return `${value.slice(0, MAX_STRING_LEN)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"_serializationError":true}';
  }
}

function sanitizeLogData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (typeof v === 'string') {
      out[k] = truncateSafe(v);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 30).map((x) => (typeof x === 'string' ? truncateSafe(x) : x));
    } else if (typeof v === 'object') {
      out[k] = v;
    }
  }
  return out;
}

export class UpdateLogger {
  readonly runId: string;
  readonly logFile: string;
  readonly diagnosticsFile: string;
  private readonly command: string;
  private readonly cacheDir: string;
  private readonly verbose: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor({
    cacheDir,
    logDir,
    diagnosticsDir,
    command = 'update',
    verbose = false
  }: {
    cacheDir: string;
    logDir: string;
    diagnosticsDir: string;
    command?: string;
    verbose?: boolean;
  }) {
    this.runId = randomBytes(8).toString('hex');
    this.command = command;
    this.cacheDir = cacheDir;
    this.verbose = verbose;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.logFile = path.join(logDir, `update-${ts}-${this.runId}.jsonl`);
    this.diagnosticsFile = path.join(diagnosticsDir, 'latest-update.json');
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.logFile), { recursive: true });
    await mkdir(path.dirname(this.diagnosticsFile), { recursive: true });
  }

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    if (level === 'debug' && !this.verbose) return;
    const entry = sanitizeLogData({
      timestamp: new Date().toISOString(),
      level,
      runId: this.runId,
      command: this.command,
      cacheDir: this.cacheDir,
      event,
      ...data
    });
    const line = `${safeStringify(entry)}\n`;
    this.writeQueue = this.writeQueue.then(() =>
      appendFile(this.logFile, line, 'utf8').catch(() => undefined)
    );
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async writeFinalDiagnostics(diag: UpdateRunDiagnostics): Promise<void> {
    await this.flush();
    const latestLog = path.join(path.dirname(this.logFile), 'latest.jsonl');
    await copyFile(this.logFile, latestLog).catch(() => undefined);
    const content = JSON.stringify({ ...diag, logFile: this.logFile }, null, 2);
    await writeFile(this.diagnosticsFile, `${content}\n`, 'utf8').catch(() => undefined);
  }
}
