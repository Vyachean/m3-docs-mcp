/**
 * Static type-safety guard for src/json-extraction/**
 *
 * Fails if unsafe external-data type overrides reappear in the JSON extraction
 * render/extract paths.  Files in INTERNAL_ALLOWLIST are schema/format helpers
 * whose casts are inside zod preprocess/transform implementation details and
 * never escape the decoder boundary.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const JSON_EXTRACTION_DIR = join(import.meta.dirname, '..', 'src', 'json-extraction');

// Files whose internal implementation casts are documented and allowed:
//   schemas.ts       – asObject/asArray/walkObjects/stableStringify internal helpers + z.output<S> cast in _parseItems
//   render-markdown.ts – formatValueNode/stableStringify private formatting utilities
const INTERNAL_ALLOWLIST = new Set(['schemas.ts', 'render-markdown.ts']);

// Patterns that must not appear in boundary/render files.
const FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'as any', pattern: /\bas\s+any\b/ },
  { label: 'as TokenTableSystem (raw cast)', pattern: /\bas\s+TokenTableSystem\b/ },
  { label: 'as Status (raw cast)', pattern: /\bas\s+Status\b/ },
  { label: 'as Record<string, unknown> (external-data cast)', pattern: /\bas\s+Record<string,\s*unknown>/ },
  { label: 'as JsonObject (external-data cast)', pattern: /\bas\s+JsonObject\b/ },
  { label: 'renderer param typed Record<string, unknown>', pattern: /function\s+\w+\s*\([^)]*:\s*Record<string,\s*unknown>[^)]*\)\s*(?::\s*\w+\s*)?\{/ },
];

function getFiles(): string[] {
  return readdirSync(JSON_EXTRACTION_DIR)
    .filter((f) => f.endsWith('.ts') && !INTERNAL_ALLOWLIST.has(f))
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
          .filter(({ line }) => !line.startsWith('//') && pattern.test(line));

        expect(violations, `Found forbidden pattern "${label}" in ${fileName}`).toHaveLength(0);
      });
    }
  }
});
