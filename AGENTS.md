# Agent instructions

This repository provides the `material3` MCP server for reading the official Material 3 documentation from `https://m3.material.io/`.

## Using the MCP server

When making Material 3 UI, UX, component, token, or design-guideline decisions in a project that has this MCP server configured, use the structured documentation graph as the primary interface:

1. For a known Material component, start with `get_component_overview`. It returns the available routes, tabs, token/resource availability, and recommended routes without dumping full content.
2. When the target component or route is not known, use `search_structured_docs`; use `list_routes` when you need route/coverage filtering.
3. Use `get_page` for exact guidance from a chosen route. Its default `structured` view is preferred; request the `markdown` view only when prose context is needed.
4. Use `get_component_tokens`, `get_component_tabs`, or `get_component_resources` only when the task needs those full focused payloads.
5. Use `search_material_docs`, `get_material_page`, `get_component_docs`, and `list_material_components` as compatibility/full-text tools, not as the default path for structured component/spec/token work.
6. Use `material_docs_cache_status` when cache readiness/freshness itself matters. Normal read tools already report when the graph/cache is unavailable, so a status call is not required before every documentation lookup.
7. Use `get_route_artifacts`, `get_raw_artifact`, `explain_route_coverage`, `explain_resource_resolution`, and `material_docs_cache_diagnostics` only for troubleshooting, provenance, or extraction/coverage investigation.
8. If the requested cache/graph data is unavailable, report that state or refresh it instead of guessing Material guidance.

The official source is always `https://m3.material.io/`. Google implementation repositories are useful references, but they are not authoritative design-guideline sources for this project.

The MCP server is considered useful only when core documentation pages expose real token names, resolved values, and status/spec data — not placeholder-only output. If structured component/spec data is unexpectedly missing, inspect `get_component_overview`/`get_page` first and use the troubleshooting tools only if the graph reports a coverage or resource-resolution problem.

The original Markdown-oriented tools remain supported for compatibility and broad prose search. They read a derived, secondary view and must not be treated as the source of truth for graph-oriented facts.

## Cache architecture (schema v2)

The cache directory has three layers, raw snapshot first:

1. **Raw snapshot** (`raw/**`, indexed in `raw/artifact-index.json`, described by `manifest.json`) —
   the source of truth: byte/text captures of `site_meta.js`, the Angular bundle, page-data,
   Carbon content, and DSDB resources, persisted as `ArtifactRecord`s.
2. **Structured documentation graph** (`graph/routes.json`, `graph/pages.json`, `graph/resources.json`,
   `graph/token-tables.json`, `graph/sections.json`, `graph/provenance.json`) — the primary MCP data
   model. `PageNode.chunks[].resourceId`/`resourceIds`/`tokenTableIds` are real cross-references
   (shared id scheme in `src/graph/resource-identity.ts` between `page-graph.ts` and
   `resource-graph.ts`, backfilled into `ResourceNode.pageIds` in `build-graph.ts`) — not synthetic
   counters. `RouteNode.tabs[].matchedSectionId`/`matchReason` are backfilled from the real
   crawl-time tab/section match decision (`matchTabToSection`), not a hardcoded placeholder.
3. **Markdown** (`index.json` / `pages/**`) — a *derived compatibility output*, rebuildable from the
   raw snapshot and graph via `rebuildMarkdownFromRaw` (`src/rendered/markdown-renderer.ts`) without
   any network access or Playwright, including tab-split virtual pages (e.g.
   `/components/switch/{overview,specs}`). Markdown remains the compatibility surface read by
   `MaterialDocsStore` (`src/store.ts`) and the original seven MCP tools — it is not the source of
   truth for the graph-oriented tools.

`manifest.json` is a compact summary of the persisted snapshot. Its `counts` must be derived from
canonical persisted owners (`raw/artifact-index.json`, graph files, and `index.json`) after artifact
deduplication and graph reconciliation. Crawl-time persistence attempts or reference occurrences are
diagnostics, not alternative manifest count semantics.

A browser oracle (`src/browser-oracle/`) cross-checks a fixed set of 8 required routes by live
Playwright capture against the raw snapshot/graph; it is a validation layer, not a crawl path. It is
**strict in full verification** (`verify:cache:full`): a capture failure (no Chromium/network) fails
the stage instead of being reported as a skipped pass. Only smoke/explicit-degraded runs allow a
clearly-labeled skipped result.

Cache promotion is strict when the `update` CLI's `--strict-graph` flag (or `strictGraph` option) is
set — used by `verify:cache:full`'s underlying crawl. In that mode, a graph/manifest/renderer-report
build failure, or a failure of the no-network raw-snapshot/structured-graph/rendered-output/
coverage-summary validation stages, aborts promotion instead of being logged as non-fatal, and
`manifest.json`'s `health` summary reflects those real validation results (`verified`/`failed`), not
a loose approximation. Without `--strict-graph` (the default, used by most dev/smoke runs), these
failures stay non-fatal and `health` falls back to a cheaper approximation — `unverified` always
means "validation hasn't run," never a stand-in for `verified`.

See README.md for full structure, field-level detail, and the 8-stage `verify:cache:full` pipeline.

**When changing crawler, cache store, route planning, route coverage, JSON extraction, renderer, token
tables, browser oracle, or MCP tools, you must run `npm run check`, `npm test`, `npm run build`, and
`npm run verify:cache:full` — and you must not finish this kind of architecture work with only smoke
verification (`verify:cache:smoke`).** Smoke mode skips the fixed-required-route checks and uses a small
page budget; it is a fast sanity check during iteration, not a substitute for the full gate before
finishing.

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

When changing any of these areas, run this expanded gate before finishing:

- `src/crawler.ts`
- `src/cache.ts`
- `src/store.ts`
- `src/route-coverage.ts`
- `src/json-extraction/**`
- `src/raw-artifacts/**`
- `src/manifest.ts`
- `src/graph/**`
- `src/rendered/**`
- `src/mcp-tools/**`
- `src/browser-oracle/**`
- `src/validation/**`
- route planning / page reference resolution
- token table rendering
- MCP cache tools (both the original Markdown-oriented tools and the graph-oriented tools)

Required commands:

```bash
npm run check
npm test
npm run build
npm run verify:cache:full
```

For any change touching crawler, cache promotion, route coverage, JSON extraction, page reference resolution, token table rendering, raw artifacts, the documentation graph, the renderer, the browser oracle, the validation pipeline, or MCP cache tools, do not finish the task until all four commands above pass.

If `verify:cache:full` fails because of a real live-site extraction issue, continue debugging and fixing it; do not stop after adding diagnostics. You may stop only when the failure is clearly external and transient, such as a network outage or `m3.material.io` being unavailable, and in that case you must preserve diagnostics, summarize them, and state clearly that the PR is not ready.

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
