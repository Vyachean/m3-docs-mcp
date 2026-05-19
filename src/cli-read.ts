import { getDefaultCacheDir } from './cache.js';
import { parsePositiveNumberOption } from './options.js';
import { MaterialDocsStore } from './store.js';

export const CACHE_MISSING_UPDATE_COMMAND = 'npx -y github:Vyachean/m3-docs-mcp update';

export type ReadCommandOptions = {
  cacheDir?: string;
  maxAgeHours: string | number | undefined;
};

export type CachedCliResult = {
  value: unknown;
  exitCode?: number;
};

export async function readCachedResult(
  options: ReadCommandOptions,
  resultKey: string,
  unavailableFallback: unknown,
  read: (store: MaterialDocsStore) => Promise<unknown>
): Promise<CachedCliResult> {
  const cacheDir = options.cacheDir ?? getDefaultCacheDir();
  const maxAgeHours = parsePositiveNumberOption('--max-age-hours', options.maxAgeHours);
  const store = new MaterialDocsStore(cacheDir);
  const status = await store.getStatus(maxAgeHours);

  if (!status.hasCache) {
    return {
      exitCode: 2,
      value: {
        status,
        message: `Material 3 docs cache is not available. Run: ${CACHE_MISSING_UPDATE_COMMAND}`,
        [resultKey]: unavailableFallback
      }
    };
  }

  return {
    value: {
      status,
      [resultKey]: await read(store)
    }
  };
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
