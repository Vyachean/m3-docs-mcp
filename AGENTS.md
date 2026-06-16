# Agent instructions

This repository provides the `material3` MCP server for reading the official Material 3 documentation from `https://m3.material.io/`.

## Using the MCP server

When making Material 3 UI, UX, or design-guideline decisions in a project that has this MCP server configured:

1. Call `material_docs_cache_status` first.
2. If a cache is available, call `search_material_docs` before making claims about Material 3 guidance.
3. Use `get_material_page` for exact page content when search returns a relevant page.
4. Use `get_component_docs` when the task concerns a specific Material component.
5. If the cache is missing or a refresh is running, say that the local Material 3 docs are not ready instead of guessing.

The official source is always `https://m3.material.io/`. Google implementation repositories are useful references, but they are not authoritative design-guideline sources for this project.

The MCP server is considered useful only when core documentation pages expose real token names, resolved values, and status/spec data — not placeholder-only output. If `get_material_page` for a spec page returns only `Material resource placeholder:` lines, the cache is degraded and should be refreshed.

## Timeout-sensitive clients

Codex and similar stdio MCP clients can time out if package installation performs slow side effects before the MCP handshake. Keep the server startup path lightweight:

- Do not add lifecycle scripts that download Playwright browsers during `npm install`.
- Do not make `serve` block on a documentation crawl.
- Keep long operations behind explicit tools or CLI commands, such as `refresh_material_docs`, `install-browser`, and `update`.
- Keep read/search tools responsive. When cache data is unavailable, return a clear status object rather than starting a blocking crawl.

For Codex configuration, document `startup_timeout_sec` and `tool_timeout_sec` in README whenever the recommended MCP command changes.

## Runtime validation and type safety

External JSON payloads from `m3.material.io`, `_dsm`, DSDB, page-data, network captures, cache files, CLI input, and MCP tool input must enter the system as `unknown`.

Rules:

- Unstable external payloads must be validated with zod (`safeParse` / `parse` / `transform`).
- TypeScript types for decoded payloads must be derived from zod schemas via `z.infer` / `z.output` — not hand-written interfaces.
- Renderers and business logic must accept decoded internal models only.
- `as SomeExternalType`, `as any`, broad `as Record<string, unknown>`, and `as JsonObject` casts are **forbidden** for trusting external data.
- Private schema helper functions (`asObject`, `asArray`, etc.) exist inside `schemas.ts` as private implementation details only — they are **not exported** and must not be imported by other modules.
- Other modules that need to inspect unknown JSON must use zod schemas (`safeParse`) or local type predicates (`function isRecord(v): v is Record<string,unknown>`) — never import private helpers from `schemas.ts`.
- Malformed external structures must produce unsupported placeholders or diagnostics, not raw `TypeError`s.
- **No bypass mechanism**: there are no allowlist files and no magic comments (`// zod-boundary-internal-cast` or similar) that suppress the type-safety guard. If TypeScript cannot prove a type from the check alone, refactor the code using a zod schema, a typed decoder function, or a local type predicate. Do not suppress the guard.
- Decode before render: add a `decodeXxx(raw: unknown): Decoded | Unsupported` boundary function and pass only the decoded value to the renderer.

**Safe narrowing patterns (use these instead of casts):**

```ts
// Type predicate for local runtime narrowing
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Then use it to narrow before accessing properties
if (isRecord(value)) {
  const label = value.label; // TypeScript knows label: unknown
}
```

**Expected flow:**

```ts
// external payload → zod boundary → decoded internal model → renderer
const raw: unknown = await fetchResource(name);
const result = TokenTableSystemSchema.safeParse(raw);
if (!result.success) return placeholder(diagnostics);
renderTokenTable(result.data);   // accepts DecodedTokenTableSystem
```

**Forbidden flow:**

```ts
// do NOT do this
const system = raw as TokenTableSystem;
renderTokenTable(system);

// do NOT do this either
function renderTokenTable(resource: Record<string, unknown>) { ... }

// do NOT suppress the guard with magic comments
const obj = value as Record<string, unknown>; // zod-boundary-internal-cast  ← FORBIDDEN
```

## Validation

Before opening or updating a PR, run:

```bash
npm run check
npm test
npm run verify:docs-values
```

Run targeted mutation tests when changing JSON extraction, decoders, or value coverage logic:

```bash
npm run test:mutation:json-extraction
```

Run full mutation tests for a complete quality gate (manual / nightly / release):

```bash
npm run test:mutation:full
```

**Why not run full mutation tests on every PR iteration?**
Full mutation testing (`test:mutation:full`) covers the entire source tree and takes several minutes. For extraction changes, `test:mutation:json-extraction` is faster and covers the critical decoder/renderer paths. Reserve `test:mutation:full` for major refactors, release candidates, or when the CI schedule triggers it overnight.

Run mutation tests when behavior around cache promotion, crawling safeguards, or MCP availability changes:

```bash
npm run test:mutation:full
```
