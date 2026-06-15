/**
 * Static type-safety guard for src/json-extraction/**
 *
 * Fails if unsafe external-data type overrides reappear in the JSON extraction
 * render/extract paths.
 *
 * Lines annotated with "// zod-boundary-internal-cast" are private schema/format
 * helpers whose casts are inside zod preprocess/transform or low-level formatting
 * implementation details and never escape the decoder boundary.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const JSON_EXTRACTION_DIR = join(import.meta.dirname, '..', 'src', 'json-extraction');

// No broadly allowlisted files — individual lines may be exempted with the
// "// zod-boundary-internal-cast" inline comment instead.

// Patterns that must not appear in boundary/render files.
const FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'as any', pattern: /\bas\s+any\b/ },
  { label: 'as TokenTableSystem (raw cast)', pattern: /\bas\s+TokenTableSystem\b/ },
  { label: 'as Status (raw cast)', pattern: /\bas\s+Status\b/ },
  { label: 'as Record<string, unknown> (external-data cast)', pattern: /\bas\s+Record<string,\s*unknown>/ },
  { label: 'as JsonObject (external-data cast)', pattern: /\bas\s+JsonObject\b/ },
  { label: 'as Decoded... (raw cast)', pattern: /\bas\s+Decoded[A-Z]/ },
  { label: 'as z.output (generic cast)', pattern: /\bas\s+z\.output/ },
  { label: 'catch({} as Decoded...)', pattern: /\.catch\s*\(\s*\{\}\s+as\s+Decoded/ },
  { label: 'renderer param typed unknown', pattern: /export\s+(?:async\s+)?function\s+render\w*\s*\([^)]*:\s*unknown[^)]*\)/ },
  { label: 'renderer param typed Record<string, unknown>', pattern: /export\s+(?:async\s+)?function\s+render\w*\s*\([^)]*:\s*Record<string,\s*unknown>[^)]*\)/ },
];

function getFiles(): string[] {
  return readdirSync(JSON_EXTRACTION_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(JSON_EXTRACTION_DIR, f));
}

describe('type-safety guard – json-extraction boundary files', () => {
  const files = getFiles();

  for (const filePath of files) {
    const fileName = filePath.split('/').pop()!;
    const source = readFileSync(filePath, 'utf-8');
    const lines = source.split('\n');

    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      it(`${fileName}: no "${label}"`, () => {
        const violations = lines
          .map((line, i) => ({ line: line.trim(), lineNum: i + 1 }))
          .filter(({ line }) =>
            !line.startsWith('//')
            && !line.includes('// zod-boundary-internal-cast')
            && pattern.test(line)
          );

        expect(violations, `Found forbidden pattern "${label}" in ${fileName}`).toHaveLength(0);
      });
    }
  }
});
