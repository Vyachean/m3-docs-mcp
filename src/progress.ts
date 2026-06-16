const ETA_MIN_PROCESSED = 3;
const ETA_MIN_ELAPSED_MS = 10_000;

export type EtaResult = {
  ratePagesPerSecond: number;
  estimatedRemainingMs: number;
};

/**
 * Computes rate and remaining-time estimate.
 * Returns null when insufficient data (fewer than 3 processed pages or less than 10 s elapsed).
 * estimatedRemainingMs is always non-negative.
 */
export function computeEta(
  processedPageCount: number,
  targetPageCount: number,
  elapsedMs: number
): EtaResult | null {
  if (processedPageCount < ETA_MIN_PROCESSED || elapsedMs < ETA_MIN_ELAPSED_MS) return null;
  const elapsedSeconds = elapsedMs / 1000;
  const rate = processedPageCount / elapsedSeconds;
  if (rate <= 0) return null;
  const remaining = Math.max(0, targetPageCount - processedPageCount);
  return {
    ratePagesPerSecond: rate,
    estimatedRemainingMs: (remaining / rate) * 1000
  };
}

export function formatDurationMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  if (minutes < 60) return remainSeconds > 0 ? `${minutes}m${remainSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h${remainMinutes}m` : `${hours}h`;
}
