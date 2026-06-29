# m3-docs-mcp

MCP server that provides agents with locally cached documentation from the official Material 3 site: <https://m3.material.io/>.

This repository is intended to be used directly from GitHub through `npx`. The package is not planned to be published to npm, so examples intentionally use `github:Vyachean/m3-docs-mcp`. Do not use `npx -y m3-docs-mcp ...` unless you have made a local or global install yourself.

The package does **not** vendor a full copy of Material documentation. It fetches the official Material 3 JSON content and stores a cache on the user's machine, with Playwright kept as a fallback path for route discovery and pages whose JSON output is missing or suspicious. This keeps the Git package lightweight and avoids publishing a public copy of Google's documentation text and images.

## Why this exists

`m3.material.io` is a JavaScript application. Simple fetch/curl-based agents often cannot read the documentation reliably. This server makes the docs available through deterministic MCP tools backed by a local cache, using the site's JSON/DSDB responses first and browser extraction only when needed.

## Requirements

- Node.js 20 or newer.
- Playwright Chromium for cache refreshes.
- On Linux, Playwright may also need host system packages.

## Recommended setup

Add the server to your MCP client config. No global install is required.

```json
{
  "mcpServers": {
    "material3": {
      "command": "npx",
      "args": ["-y", "github:Vyachean/m3-docs-mcp", "serve"]
    }
  }
}
```

The MCP server starts without downloading a browser during package installation. Browser installation is still needed for fallback extraction and route coverage discovery during cache refreshes, but normal page content extraction is now JSON-first. This keeps normal MCP startup fast enough for clients with short stdio initialization timeouts.

Install the Playwright-managed Chromium browser required by this Git package version before the first cache refresh:

```bash
npx -y github:Vyachean/m3-docs-mcp install-browser
```

On Linux, use this variant when Playwright reports missing host dependencies:

```bash
npx -y github:Vyachean/m3-docs-mcp install-browser --with-deps
```

Then build or refresh the documentation cache:

```bash
npx -y github:Vyachean/m3-docs-mcp update
```

On startup, the server checks the local cache. If the cache is missing or stale and Playwright Chromium is installed, it starts a Playwright refresh in the background. Normal read/search tool calls do not wait for the crawl and therefore should not hit short MCP client tool timeouts. While the first cache is being built, read/search tools return cache status and ask the client to retry after the background refresh completes.

If the cache exists but is stale, tools continue answering from the existing cache and include cache status plus background refresh metadata. Concurrent startup and manual refresh requests are deduplicated inside the running server so only one crawl promotes the cache at a time.

If Playwright Chromium is missing, background refresh cannot build the cache. Run `install-browser` first, then run `update` or restart the MCP server.

## Codex setup

Codex uses TOML MCP configuration. It also applies a short startup timeout unless configured otherwise, so give this server enough time for `npx` GitHub cold starts and tool listing.

Add this to `~/.codex/config.toml` or the project-level `.codex/config.toml`:

```toml
[mcp_servers.material3]
command = "npx"
args = ["-y", "github:Vyachean/m3-docs-mcp", "serve"]
startup_timeout_sec = 120
tool_timeout_sec = 300
enabled = true
```

For a first-time setup, run the browser/cache prewarm outside Codex:

```bash
npx -y github:Vyachean/m3-docs-mcp install-browser
npx -y github:Vyachean/m3-docs-mcp update
```

The GitHub package reference is slower on cold start because npm may fetch the repository and build the TypeScript package from source before the MCP server starts. Keep the configured timeouts unless the package is installed locally.

## Optional CLI usage

```bash
npx -y github:Vyachean/m3-docs-mcp status
npx -y github:Vyachean/m3-docs-mcp status --cache-dir /path/to/cache
npx -y github:Vyachean/m3-docs-mcp install-browser
npx -y github:Vyachean/m3-docs-mcp install-browser --with-deps
npx -y github:Vyachean/m3-docs-mcp update
npx -y github:Vyachean/m3-docs-mcp update --cache-dir /path/to/cache
npx -y github:Vyachean/m3-docs-mcp update --max-pages 500
npx -y github:Vyachean/m3-docs-mcp update --min-pages 25
npx -y github:Vyachean/m3-docs-mcp update --concurrency 2
npx -y github:Vyachean/m3-docs-mcp update --force
npx -y github:Vyachean/m3-docs-mcp update --promote-partial
npx -y github:Vyachean/m3-docs-mcp update --headed
npx -y github:Vyachean/m3-docs-mcp update --include-blog
npx -y github:Vyachean/m3-docs-mcp serve
npx -y github:Vyachean/m3-docs-mcp serve --cache-dir /path/to/cache
npx -y github:Vyachean/m3-docs-mcp serve --max-age-hours 12
npx -y github:Vyachean/m3-docs-mcp serve --startup-max-pages 500
npx -y github:Vyachean/m3-docs-mcp serve --startup-concurrency 2
npx -y github:Vyachean/m3-docs-mcp serve --no-auto-update
```

`update` prints a start message after the CLI process has started. With `npx github:...`, npm may still spend time fetching and building the package before that message can appear.

For a quick crawler smoke test, use a temporary cache directory and lower `--min-pages` together with `--max-pages`. This validates startup and crawling without trying to replace a larger existing cache:

```bash
M3_DOCS_CACHE_DIR="$(mktemp -d)" npx -y github:Vyachean/m3-docs-mcp update --max-pages 3 --min-pages 1
```

For local development in this repository, the equivalent smoke helper is:

```bash
npm run verify:cache:smoke
```

This is a debugging aid only. It intentionally uses `--max-pages` and must not be treated as the final cache-quality gate.

For crawler, extraction, route-coverage, token-table, or cache-tooling work, use the full production-style verification gate:

```bash
npm run verify:cache:full
```

`verify:cache:full` builds the project, runs the built CLI against the live Material 3 site with an isolated temporary cache directory, uses production refresh settings (`--concurrency 6 --min-pages 150`, with no `--force`, no `--max-pages`, and no `--include-blog`), then checks that the resulting cache reports verified coverage, zero failed/unresolved/partial route coverage, required component pages, and no unresolved token-table placeholders in generated specs pages.

On failure, it preserves the temp cache directory and prints:

- the CLI exit code
- the temp cache directory path
- the last 100 lines of `logs/latest.jsonl`, if present
- `diagnostics/latest-update.json`, if present
- `coverageDiagnostics.routeCoverageSummary`, if `index.json` exists
- problematic route coverage examples, if available

The default minimum is 10 pages, so interrupting the command or crawling fewer than 10 accepted pages intentionally leaves the existing cache unchanged.

`--max-age-hours` marks cache status as fresh/stale and controls whether startup auto-update is needed. The default is 168 hours, or 7 days. It does not make read/search tool calls block on a refresh.

`--concurrency` controls the maximum number of simultaneous page workers across **all** crawl phases — both the direct JSON fetch phase and the browser crawl fallback phase. The default is 1 (sequential). Values above 8 are rejected. A higher value speeds up the crawl at the cost of more network connections; the same limit applies uniformly to every phase so no single phase can silently exceed the requested cap.

Progress output is printed to stderr throughout the crawl and shows which phase is active, how long the crawl has been running, the approximate ETA and pages/s rate, and how many pages have been saved, failed, and queued. Example:

```
Material 3 docs cache refresh: phase=browser-crawl elapsed=42s eta≈1m18s rate=0.42/s saved=12/20 failed=4 attempted=22 queued=58 active=6/6 current=https://m3.material.io/components/buttons/specs
```

ETA is calculated from the elapsed average rate and is only shown after at least 3 pages have been processed and 10 seconds have elapsed. During the browser-crawl phase, where the queue size is still growing, ETA is prefixed with `≈` to indicate it is approximate. When insufficient data is available the field shows `eta=calculating`.

`update` refuses to replace an existing cache when the new crawl is suspiciously degraded: fewer than 80% of the previous cache pages, more than 20% failed attempted pages after at least 10 attempts, duplicate page bodies, or component URLs that rendered unrelated/parent content. Use `--force` only when you intentionally want to replace the existing cache despite these safeguards.

`--promote-partial` is a separate, narrower override: by default, a limited/partial crawl (e.g. with `--max-pages`) is never promoted when there is no previous cache yet, or when the previous cache was a full verified run — this prevents a smoke-sized crawl from silently becoming the only cache on disk, or silently replacing a complete one. Pass `--promote-partial` only when you intentionally want a limited crawl's results promoted anyway (this is what `scripts/verify-full-cache-refresh.mjs` does against its disposable temp cache directory, since that directory never has a previous cache to compare against).

By default, `update` excludes blog, news, and article routes (`/blog/**`, `/articles/**`, `/news/**`) from the crawl. The MCP server is primarily intended for Material 3 component specifications, guidelines, design tokens, styles, foundations, and implementation documentation. Blog content is secondary and is excluded by default so it does not consume crawl capacity ahead of core documentation routes. Pass `--include-blog` to include blog routes in the crawl for full-site archival.

The crawler uses a fixed priority order when queuing discovered routes:

1. Core docs (`/components/**`, `/styles/**`, `/foundations/**`)
2. Development / getting started (`/develop/**`, `/get-started/**`, `/designing/**`)
3. Resources / secondary (`/resources/**`, `/templates/**`, `/case-studies/**`)
4. Blog / news / articles (`/blog/**`, `/articles/**`, `/news/**`) — excluded by default
5. Unknown or low-value routes

When `--max-pages` is lower than the total discovered routes, the crawler fills pages in priority order: core docs first, blog last (or never, if `--include-blog` is not passed). Skipped blog routes are recorded in `coverageDiagnostics` as policy-skipped and do not cause coverage failures.

Global install is optional and mainly useful for development or repeated manual diagnostics:

```bash
npm install -g github:Vyachean/m3-docs-mcp
```

After a global install, the binary can be used as `m3-docs-mcp`, but the supported distribution source is still this Git repository.

## Cache schema v2: raw snapshot, structured graph, and derived Markdown

The cache directory now has three layers, written in this order during a crawl:

1. **Raw snapshot (`raw/**`)** — byte-for-byte/text-for-text captures of what was fetched from the
   live site, persisted as artifact records (`src/raw-artifacts/`). Artifact kinds: `site-shell`,
   `site-meta`, `angular-bundle`, `sitemap`, `page-data`, `carbon-content`, `dsdb-resource`, and
   `network-capture` (browser oracle captures). Each artifact record stores `id`, `kind`,
   `sourceUrl`, `localPath` (relative to the cache dir, e.g.
   `raw/page-data/<collectionId>/<documentId>.json`), `httpStatus`, `contentType`, a SHA-256
   `sha256` of the persisted bytes, `fetchedAt`, the `sourceRoute` it served, `sourceMethod`
   (`static-plan` / `browser-capture` / `manual-required-route`), and any `error`/`diagnostics`.
   All artifact records are indexed in `raw/artifact-index.json` (a flat JSON array of artifact
   records). This is the provenance layer everything else is built from.
2. **Structured documentation graph (`graph/*.json`)** — built from the raw snapshot by
   `src/graph/build-graph.ts`, validated with zod, never hand-cast:
   - `graph/routes.json` — one `RouteNode` per discovered route: canonical route, aliases, title,
     section, tabs, route origin(s) (`site_meta`, `bundle`, `sitemap`, `nav_drawer`, etc.), source
     artifacts, expected/generated output paths, and a `RouteCoverageInfo` (status, reasons,
     `originalStatus` before any shared-alias-group reconciliation, `sharedCoverageGroup`). Coverage
     status is one of `covered`, `partial`, `failed`, `skipped`, `unresolved`, `nonContent`,
     `policySkipped`, `aliasOnly`, `ambiguous`, `stale`. Each `tabs[]` entry carries a real
     `matchedSectionId`/`matchReason` (`slug` / `label` / `position` / `unmatched`) backfilled from
     the same tab/section match decision made at crawl time (`matchTabToSection`), not a hardcoded
     placeholder — `get_route` on a tab route (e.g. `/components/switch/specs`) explains it as a
     virtual/tab route backed by its parent source route's artifacts.
   - `graph/pages.json` — one `PageNode` per page: headings, `sections` (with `chunkIds`), `chunks`
     (typed `text` / `image` / `video` / `resource` / `unsupported`, each `resource` chunk carrying
     a real `resourceId` that resolves in `graph/resources.json`), real `resourceIds`/`tokenTableIds`
     cross-references (not empty placeholders — see `src/graph/resource-identity.ts`, the shared
     id scheme `page-graph.ts`/`resource-graph.ts` both use), and provenance (source artifacts,
     source/canonical/virtual route). Tab pages (e.g. `/components/switch/specs`) carry a
     `tabs[0].sectionIndex` pointing at the matched section in the shared decoded content page.
   - `graph/resources.json` — one `ResourceNode` per referenced resource (token table, status
     table, image, video, or unknown): resolution `status` (`resolved`/`unresolved`), the routes,
     `pageIds`, and chunks that reference it, and an `unresolvedReason` when applicable.
   - `graph/token-tables.json` — one `TokenTableNode` per token-table resource: real token sets,
     token names, display names, alias chains, and resolved/unresolved values per role (`light`,
     `dark`, `light-high-contrast`, `dark-high-contrast`).
   - `graph/sections.json` — a flat per-section projection of `graph/pages.json` (one entry per
     heading/section across all pages), useful for section-level lookups without walking page chunks.
   - `graph/provenance.json` — maps each `route:`/`page:`/`resource:` subject to the raw artifact
     ids it was built from, so any graph fact can be traced back to the exact raw capture.
3. **Markdown (`pages/**/*.md`, `index.json`)** — now a *derived* output, rebuilt from the route
   graph + page graph + raw snapshot by `src/rendered/markdown-renderer.ts`'s
   `rebuildMarkdownFromRaw`, which re-invokes the same `extractContentPageToMaterialPage` renderer
   the live crawl uses, but fed with page-data/carbon-content/dsdb-resource JSON read back from
   `raw/**` — no network access, no Playwright. This proves Markdown can be regenerated from the
   raw snapshot alone, **including tab-split virtual pages**: when a source route's `PageGraph`
   group contains more than one tabbed page (e.g. `/components/switch/{overview,specs}`,
   `/components/buttons/{overview,specs}`, `/components/lists/{overview,specs}`), the rebuild
   renders one Markdown page per tab from the single shared raw artifact, using each
   `PageTabRef.sectionIndex` to pick the matched section — the same mechanism the live crawler's
   tab-splitting loop uses, just driven from the graph instead of a live bundle lookup. Routes that
   were only ever extracted via DOM/browser fallback (no persisted page-data/carbon-content
   artifact) are skipped during a from-raw rebuild and reported as `renderedMarkdownPath: null`
   rather than silently dropped. **`index.json`/`pages/**` remain the primary compatibility
   surface**: `MaterialDocsStore` (`src/store.ts`) and all seven original Markdown-oriented MCP
   tools read only from this layer, unchanged.

`manifest.json` (cache schema v2, `schemaVersion: 2`) is the small top-level entry point describing
what exists: `generatedAt`, `baseUrl`, `carbonVersion`, `siteMetaHash`, `angularBundleHash`,
`sitemapHash`, `counts` (`rawArtifacts`, `routes`, `pages`, `markdownPages`, `dsdbResources`,
`tokenTables`), and a `health` summary (`rawSnapshot`, `graph`, `markdown`, `coverage`, each one of
`unverified` / `verified` / `partial` / `degraded` / `failed`). It sits alongside, not instead of,
`index.json`.

A renderer diagnostics report (`diagnostics/renderer-report.json`) records, per route, unsupported
chunk types, unresolved resources/token/status tables, section/heading coverage, and whether the
route is one of the fixed required routes (see below) — any error-severity finding on a required
route is surfaced in `requiredRouteFailures`.

## Graph-oriented MCP tools

Prefer these tools for component, route, or token questions — they read the structured
documentation graph directly and return decoded data (real token names/values/roles), not just
Markdown text:

- `list_routes` — list the route catalog from `graph/routes.json`, with section/coverage/search filters.
- `get_route` — route metadata (canonical route, aliases, references, tabs, source artifacts, coverage status) for one route.
- `get_page` — one page in a chosen view: `structured` (sections/chunks/resources/tokens from `graph/pages.json`), `markdown` (the existing Markdown-compatible view), or `raw-summary` (artifact/provenance metadata only).
- `get_component_tokens` — token/status tables (real token names, values, roles, source artifacts) for a component, from `graph/token-tables.json`.
- `get_component_tabs` — tabs per route for a component, from `graph/routes.json`.
- `get_component_resources` — resources (images, videos, token tables, status tables) referenced by a component's routes, from `graph/resources.json`.
- `get_route_artifacts` — raw artifact ids/kinds/source URLs/hashes associated with a route (metadata only, not content).
- `get_raw_artifact` — debug/provenance tool: metadata plus a truncated content preview for one raw artifact; never dumps large raw JSON by default.
- `explain_route_coverage` — explains why a route has its current coverage status (reasons, shared coverage group, policy-skip reason).
- `explain_resource_resolution` — explains a resource's resolved/unresolved status and which routes/chunks reference it.
- `search_structured_docs` — searches the graph (route paths/titles, section headings, chunk text, token names/display names/aliases, resource names) by query text, without parsing Markdown or raw JSON. Complements `search_material_docs` (Markdown full-text) with structured-fact search — e.g. a query like `switch selected track color` or a token alias finds the owning token table and route directly.

The original Markdown-oriented tools (`search_material_docs`, `get_material_page`,
`get_component_docs`, `list_material_components`, `material_docs_cache_status`,
`material_docs_cache_diagnostics`, `refresh_material_docs`) are unchanged and remain the tools to
use for full-text search and for compatibility with existing agent prompts.

## Browser oracle (validation only, not the crawler)

The browser oracle (`src/browser-oracle/`) is a Playwright-driven *validation* layer, not a primary
crawl path. It loads a fixed set of 8 required routes in a real browser, captures network JSON and
a DOM text snapshot, and compares that capture against the persisted raw snapshot
(`raw/artifact-index.json`) and documentation graph (`graph/*.json`) to catch resources or headings
the deterministic direct-JSON crawl silently missed. The 8 required routes
(`REQUIRED_BROWSER_ORACLE_ROUTES`, also used by the renderer report as `REQUIRED_RENDERER_ROUTES`):

```
/components/switch/overview
/components/switch/specs
/components/buttons/overview
/components/buttons/specs
/components/lists/overview
/components/lists/specs
/styles/color/roles
/foundations/design-tokens/overview
```

The browser oracle compares, per route, captured network resources against `raw/artifact-index.json`
(flagging any with no match), captured DOM headings against `graph/pages.json` (flagging any
missing), and captured visible token/status table labels against `graph/token-tables.json`
(flagging any unresolved). Its capture report is persisted as a `network-capture` raw artifact at
`raw/network/required-routes.capture.json`; the comparison result is written to
`diagnostics/browser-oracle-comparison.json`.

`validateBrowserOracle`'s `strict` option controls what a capture failure (no Chromium binary, no
network) means: **`strict: true` (the default, and what `verify:cache:full` uses) fails the stage**
— browser oracle is a required validation oracle in full mode, not an optional cross-check, so "we
couldn't check" must not be reported as a pass. **`strict: false`** (smoke mode, or explicitly
passing `skipBrowserOracle`) reports a `passed: true, details.skipped: true` result instead — clearly
labeled as skipped, never confused with a genuine pass. `verify:cache:full` explicitly skipping the
browser oracle (`--skip-browser-oracle`) is itself treated as a stage failure in full mode, for the
same reason.

## The `verify:cache:full` / `verify:cache:smoke` pipeline

`npm run verify:cache:full` (and the lighter `npm run verify:cache:smoke`) build the project, run
the built CLI's `update` command into an isolated temporary cache directory with `--promote-partial`
(so the verify run's first-ever crawl actually promotes instead of being skipped by the
first-cache partial-promotion safeguard), then run a strict superset of 7 ordered validation stages
(`src/validation/run-full-verification.ts`) against the resulting cache:

1. **raw-snapshot** (`validate-raw-snapshot.ts`) — site shell / site_meta / Angular bundle /
   carbon version present and hashed.
2. **route-graph** (`validate-route-graph.ts`) — no missing artifacts, no ambiguous/unresolved
   required routes (full mode only for the fixed-required-route check).
3. **browser-oracle** (`validate-browser-oracle.ts`) — live Playwright capture vs. raw
   snapshot/graph; **strict in full mode** (a capture failure fails this stage, not a skipped pass —
   see "Browser oracle" above).
4. **structured-graph** (`validate-structured-graph.ts`) — no unresolved required DSDB/token/status
   resources, no unknown chunk types (full mode only for the fixed-required-route check).
5. **rendered-output** (`validate-rendered-output.ts`) — renderer report's `requiredRouteFailures`
   empty, no unresolved token placeholders, required generated pages present on disk.
6. **search-index** (`validate-search-index.ts`) — `MaterialDocsStore.searchDocs` smoke proxy, plus
   a `search_structured_docs` structured-search check against the documentation graph.
7. **coverage-summary** (`validate-coverage-summary.ts`) — `coverageHealth` plus zero
   problematic/unresolved/failed route counts.

`verify:cache:smoke` runs the same 7 stages with a small `--max-pages` budget, skips the
fixed-required-route checks in stages 2 and 4 (a small page budget is not guaranteed to include
every required route), and runs the browser oracle non-strictly (a capture failure is reported as a
skipped pass, not a failure); every other check in every stage still runs unconditionally. Treat
smoke as a fast sanity check, not the quality gate — `verify:cache:full` is the stricter superset and
the one that must pass before finishing crawler/cache/graph/renderer/MCP-tool work (see AGENTS.md).

### Cache promotion strictness and manifest health

The `update` CLI (and `crawlMaterialDocs`/`crawlIntoCache` programmatically) accept a
`--strict-graph` flag (`strictGraph` option), which `verify:cache:full` always passes for its
underlying full crawl. With `--strict-graph`:

- A failure to write the raw artifact index, fetch report, renderer report, documentation graph, or
  manifest aborts promotion (throws) instead of being logged as non-fatal.
- After those writes, the same no-network validation stages used by `verify:cache:full`
  (raw-snapshot, structured-graph, rendered-output, coverage-summary) run against the result; any
  failure aborts promotion with a detailed error.
- `manifest.json`'s `health` summary (`rawSnapshot`, `graph`, `markdown`, `coverage`) is set from
  those real validation results (`verified`/`failed`), not a loose approximation.

Without `--strict-graph` (the default — used by smoke/dev runs and most existing tests), these
failures are logged and promotion continues, and `health` falls back to the cheaper approximation
(`rawSnapshot: verified` once at least one artifact exists, `graph` always `unverified`, `markdown`
derived from `coverageHealth`). `unverified` always means "this validation stage hasn't run" — never
treated as a substitute for `verified`. A promotion aborted by `--strict-graph` leaves the staging
directory in place for inspection (same failed-staging mechanism as other promotion safety checks),
never promotes a cache where raw/graph/manifest generation failed.

On failure, `scripts/verify-full-cache-refresh.mjs` preserves the temp cache directory (it is never
deleted on failure) and prints: the CLI exit code, the temp cache directory path, the last 100
lines of `logs/latest.jsonl`, a summary of `diagnostics/latest-update.json`, and
`coverageDiagnostics.routeCoverageSummary` (plus problematic route examples and failure reasons
grouped by cause) from both the temp cache's `index.json` and, if present, a sibling
`<tempCacheDir>.failed-staging/index.json` — the staging directory `update` itself preserves when a
crawl fails safety checks before being promoted. Inspect both to distinguish "the crawl itself
failed validation" from "the verification pipeline found a problem in an otherwise-promoted cache."

## Environment variables

- `M3_DOCS_CACHE_DIR`: override the local cache directory.
- `M3_DOCS_MAX_AGE_HOURS`: override the cache freshness threshold used by `serve`.
- `M3_DOCS_AUTO_UPDATE=false`: disable startup background refresh.
- `M3_DOCS_STARTUP_MAX_PAGES`: override the automatic startup crawl page limit.
- `M3_DOCS_STARTUP_CONCURRENCY`: override automatic startup crawl concurrency.

## Cache location

Default cache locations:

- Linux: `$XDG_CACHE_HOME/m3-docs-mcp` or `~/.cache/m3-docs-mcp`
- macOS: `~/Library/Caches/m3-docs-mcp`
- Windows: `%LOCALAPPDATA%/m3-docs-mcp`

Override:

```bash
M3_DOCS_CACHE_DIR=/path/to/cache npx -y github:Vyachean/m3-docs-mcp serve
```

Cache refresh is staged in a temporary directory and promoted only after the crawl result passes basic validation and safety checks against the previous cache. A failed, interrupted, or suspicious crawl should not replace the previous cache. A running MCP server re-reads cache metadata before serving tools and rebuilds its in-memory search index when the cache changes externally.

The crawler tracks two separate quality dimensions:

- **extraction quality**: whether the accepted page content was extracted correctly (JSON vs DOM path, token tables rendered, status tables resolved, unknown chunk types).
- **coverage quality**: whether enough public Material documentation URLs were discovered and crawled to treat the cache as broadly representative.

### Coverage health states

Each cache index stores a `coverageHealth` field alongside `coverageWarnings` in `coverageDiagnostics`. The possible values are:

| State | Meaning |
|---|---|
| `verified` | Discovery found all expected URLs and the crawl accepted all of them without gaps or regressions. |
| `partial` | The crawl was intentionally limited by `--max-pages`. Coverage is incomplete by design. |
| `unverified` | The crawl extracted content successfully but coverage cannot be confirmed — for example, because Playwright was unavailable or URL discovery returned nothing. |
| `failed` | A significant unexpected coverage gap or regression was detected. Promotion is blocked unless `--force` is used. |

A `partial` or `unverified` cache remains fully usable for search and page retrieval. `material_docs_cache_status` exposes `coverageHealth` directly so agents can decide how to interpret results without receiving the full diagnostics payload by default.

First-cache coverage policy: if a crawl that was not intentionally limited by `--max-pages` discovers substantially more public documentation URLs than it accepted, the cache promotion is rejected — the same coverage gap check that applies to subsequent crawls is also enforced on the first cache. Use `--force` to promote anyway if you have confirmed the gap is expected.

The crawler now tries JSON extraction first for discovered Material documentation routes:

- it reads `/page-data/.../page-data.json` when available;
- it resolves `/_dsm/content/m3/...` content JSON when available;
- it resolves referenced DSDB resources such as token tables from `/_dsm/data/dsdb-m3/...`;
- it falls back to Playwright DOM extraction only when JSON extraction fails or looks incomplete.

Direct JSON is a fast content path, not the only coverage source. During `update`, the crawler also performs public URL discovery from sitemap data, rendered site navigation/shell links, Angular route metadata hints, and previous cache routes. A direct JSON success can still trigger browser discovery on a first cache build so route coverage is checked independently from per-page extraction quality.

The browser crawler still opens links exactly as discovered on `m3.material.io`. For component landing links such as `/components/buttons`, it may also try `/components/buttons/overview` as a fallback when the discovered route does not render stable matching content. Before extraction, it waits for rendered `main` content, final browser URL, page title, and text snapshot to stabilize. Cached lookup accepts both landing and overview forms, so `components/buttons` and `components/buttons/overview.md` resolve to the same cached page when the overview page was stored.

Each refreshed cache now writes:

- `index.json` as a compact public manifest with cache-level metadata plus page lookup/search metadata only;
- `pages/**/*.md` as the cached page bodies;
- `diagnostics/latest-update.json` as the verbose refresh/debug record, including extraction and coverage diagnostics.

This helps diagnose both SPA route failures such as `/components/buttons` rendering the parent `Components` listing instead of the Buttons documentation, and JSON-shape drift where a page had to fall back to the browser path.

When `--max-pages` intentionally limits the crawl, the refresh can still succeed, but the stored diagnostics mark the cache as partial instead of silently treating `min-pages` as proof of full coverage. Likewise, if Playwright is unavailable and direct JSON still produces a usable partial cache, the cache metadata records that coverage was left unverified.

Raw JSON debug output is sanitized for extraction audits. When JSON payloads are captured for an accepted page, the cache stores only the response URL/path, classified type, stable ID, and payload. It does not store request headers, cookies, or full HAR files.

## MCP tools

### `search_material_docs`

Searches locally cached Material 3 docs.

Arguments:

```json
{
  "query": "dialogs actions",
  "limit": 10
}
```

`limit` defaults to 10 and is capped at 25.

Returns compact `cache` metadata plus `results` with `title`, `path`, `sourceUrl`, `section`, `headings`, `excerpt`, and `score`.

### `get_material_page`

Returns one cached page by source URL or local cache path. URL query strings, fragments, trailing slashes, leading slashes, optional `.md` suffixes, and component overview aliases are normalized before lookup.

Arguments:

```json
{
  "pathOrUrl": "components/dialogs/overview.md"
}
```

Returns compact `cache` metadata plus a single `page` object with `meta` and `markdown`.

### `get_component_docs`

Returns cached pages matching a Material component name. By default it returns bounded page summaries, not full markdown.

Arguments:

```json
{
  "componentName": "dialogs",
  "includeMarkdown": false,
  "maxPages": 10,
  "maxMarkdownChars": 20000
}
```

### `list_material_components`

Lists compact component entries discovered under `components/*`.

### `material_docs_cache_status`

Returns local cache status and startup background refresh status. The default `status` payload is compact: cache path, freshness, age/TTL, counts, source, `coverageHealth`, and `qualitySummary`.

### `material_docs_cache_diagnostics`

Returns explicit cache diagnostics from `diagnostics/latest-update.json`. Summary-only by default, with filters for route/path/failed/skipped subsets and an explicit full-dump opt-in.

### `refresh_material_docs`

Forces a cache refresh through Playwright. This is an explicit long-running operation. Set `force` only when intentionally replacing an existing cache despite safety checks.

Arguments:

```json
{
  "maxPages": 250,
  "concurrency": 2,
  "force": false
}
```

`maxPages` is capped at 1000. `concurrency` defaults to 1 and is capped by the crawler maximum.

## Project rules

- The official source is always `https://m3.material.io/`.
- Google implementation repositories are not treated as authoritative design guidelines.
- Cached docs are stored locally for the user running the MCP server.
- The Git package should not include a full public mirror of Material documentation.
- Normal read/search tools must not trigger or wait for a long crawl.
- Startup cache warming may run a crawl in the background when Playwright Chromium is installed.
- Package installation must not download Playwright browsers, because MCP clients such as Codex can time out before the stdio handshake completes.

## Current limitations

This implementation extracts text/Markdown and page metadata. Image references are embedded as remote Markdown image URLs, but image assets are not downloaded or stored locally. The JSON extraction layer is schema-tolerant and preserves unknown content with explicit placeholders, but route discovery, per-page diffing, and richer section normalization can still be improved in later PRs.
