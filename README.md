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

The default minimum is 10 pages, so interrupting the command or crawling fewer than 10 accepted pages intentionally leaves the existing cache unchanged.

`--max-age-hours` marks cache status as fresh/stale and controls whether startup auto-update is needed. The default is 168 hours, or 7 days. It does not make read/search tool calls block on a refresh.

`update` refuses to replace an existing cache when the new crawl is suspiciously degraded: fewer than 80% of the previous cache pages, more than 20% failed attempted pages after at least 10 attempts, duplicate page bodies, or component URLs that rendered unrelated/parent content. Use `--force` only when you intentionally want to replace the existing cache despite these safeguards.

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

A `partial` or `unverified` cache remains fully usable for search and page retrieval. `material_docs_cache_status` exposes `coverageHealth` directly so agents can decide how to interpret results. Search and get tool responses include the cache status object, which contains `coverageHealth` and the full `coverageWarnings` list.

First-cache coverage policy: if a crawl that was not intentionally limited by `--max-pages` discovers substantially more public documentation URLs than it accepted, the cache promotion is rejected — the same coverage gap check that applies to subsequent crawls is also enforced on the first cache. Use `--force` to promote anyway if you have confirmed the gap is expected.

The crawler now tries JSON extraction first for discovered Material documentation routes:

- it reads `/page-data/.../page-data.json` when available;
- it resolves `/_dsm/content/m3/...` content JSON when available;
- it resolves referenced DSDB resources such as token tables from `/_dsm/data/dsdb-m3/...`;
- it falls back to Playwright DOM extraction only when JSON extraction fails or looks incomplete.

Direct JSON is a fast content path, not the only coverage source. During `update`, the crawler also performs public URL discovery from sitemap data, rendered site navigation/shell links, Angular route metadata hints, and previous cache routes. A direct JSON success can still trigger browser discovery on a first cache build so route coverage is checked independently from per-page extraction quality.

The browser crawler still opens links exactly as discovered on `m3.material.io`. For component landing links such as `/components/buttons`, it may also try `/components/buttons/overview` as a fallback when the discovered route does not render stable matching content. Before extraction, it waits for rendered `main` content, final browser URL, page title, and text snapshot to stabilize. Cached lookup accepts both landing and overview forms, so `components/buttons` and `components/buttons/overview.md` resolve to the same cached page when the overview page was stored.

Each refreshed index includes:

- `qualityReport` for duplicate page bodies, suspicious route/content mismatches, short pages, duplicate titles, and page counts by section;
- `extractionDiagnostics` for JSON-vs-DOM extraction counts, token table coverage/context diagnostics, status table placeholder diagnostics, unknown chunk/resource types, image/video counts, unresolved resources, and per-page fallback reasons;
- `coverageDiagnostics` for discovered public URL counts, discovery-source counts, uncrawled discovered routes, `max-pages` partial-crawl markers, and whether coverage was verified or left partial/unverified.

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

### `get_material_page`

Returns one cached page by source URL or local cache path. URL query strings, fragments, trailing slashes, leading slashes, optional `.md` suffixes, and component overview aliases are normalized before lookup.

Arguments:

```json
{
  "pathOrUrl": "components/dialogs/overview.md"
}
```

### `get_component_docs`

Returns all cached pages matching a Material component name.

Arguments:

```json
{
  "componentName": "dialogs"
}
```

### `list_material_components`

Lists component slugs discovered under `components/*`.

### `material_docs_cache_status`

Returns local cache status and startup background refresh status. The `status` object includes a top-level `coverageHealth` field (`"verified"`, `"partial"`, `"unverified"`, or `"failed"`) and the full `coverageDiagnostics` object with `coverageWarnings`. Search and page-retrieval tools include the same `status` object in their responses so agents can check coverage health alongside results.

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

## Operational logs

When an agent-started MCP server or `update` command runs, a persistent operational log is written next to the cache.

### Log location

```
<cacheDir>/logs/mcp.log.jsonl
```

The default cache directory is platform-dependent (see [Cache directory](#cache-directory) above). Each line in the log file is a valid JSON object.

### Log format

Every log entry includes:

| Field | Type | Description |
|---|---|---|
| `timestamp` | string | ISO 8601 timestamp |
| `level` | string | `debug`, `info`, `warn`, or `error` |
| `runId` | string | Random hex ID unique to this MCP session or CLI invocation |
| `pid` | number | OS process ID |
| `event` | string | Machine-readable event name (e.g. `refresh-start`, `route-failure`) |
| `message` | string | Human-readable description |
| `cacheDir` | string | Cache directory path |
| `command` | string | `serve` or `update` |

Optional fields when relevant:

| Field | Description |
|---|---|
| `url` | The page URL that failed or was processed |
| `path` | Local cache path |
| `source` | Extraction source: `direct-json`, `network-json`, `dom-fallback`, `crawler`, `cache`, `mcp` |
| `phase` | Crawl phase: `direct-json` or `browser-crawl` |
| `durationMs` | Elapsed time in milliseconds |
| `counters` | Key/value numeric counters (page counts, failure counts, etc.) |
| `errorClass` | Exception class name (e.g. `TypeError`) |
| `errorMessage` | Exception message |
| `errorStack` | Stack trace |

### What is NOT logged

To protect privacy and keep logs compact, the following are never written to the log:
- Cookies or authentication headers
- Request or response headers
- Full HAR payloads
- Full raw Material JSON response bodies
- Full markdown or page body content

### Retention and rotation

- The current log file is rotated when it exceeds **5 MB**.
- Up to **5 rotated** files are kept (`mcp.log.1.jsonl` … `mcp.log.5.jsonl`).
- Older rotated files are deleted automatically.
- Rotation uses atomic rename, which is safe when two processes start close together.

### Inspecting logs

```bash
# Show the last 20 log entries
tail -n 20 ~/.cache/m3-docs-mcp/logs/mcp.log.jsonl | jq .

# Show only errors
grep '"level":"error"' ~/.cache/m3-docs-mcp/logs/mcp.log.jsonl | jq .

# Show all route failures
grep '"event":"route-failure"' ~/.cache/m3-docs-mcp/logs/mcp.log.jsonl | jq '{url: .url, phase: .phase, error: .errorMessage}'

# Check when the last refresh started and finished
grep '"event":"refresh-' ~/.cache/m3-docs-mcp/logs/mcp.log.jsonl | jq '{event: .event, ts: .timestamp}'
```

### Diagnosing failed agent-started refreshes

If the MCP server was started by an agent and the refresh failed or was interrupted:

1. Check the log file: `<cacheDir>/logs/mcp.log.jsonl`
2. Look for `refresh-failure` events for the overall failure cause
3. Look for `route-failure` events for individual page failures (includes URL, phase, error class/message)
4. Look for `refresh-lock-conflict` if two processes tried to refresh simultaneously

The `status` CLI command also reports log location:

```bash
npx -y github:Vyachean/m3-docs-mcp status | jq '{logDir: .logDir, currentLogFile: .currentLogFile}'
```

## Cache staging and cleanup

### Staging directories

During a refresh, a temporary staging directory is created in the same parent directory as the cache:

```
<parentDir>/.m3-docs-mcp-staging-<random>
```

On success, the staging directory is atomically promoted to replace the active cache. On failure, it is deleted.

If a process was killed mid-refresh, stale staging directories may be left behind. The next refresh automatically removes staging directories older than **6 hours** before starting, and again after completing.

Cleanup never removes:
- The current run's staging directory
- The active cache directory
- Staging directories newer than the TTL (they may belong to an in-progress run)

### `.previous` backup

During promotion, the existing cache is temporarily renamed to `<cacheDir>.previous` as an atomic safety backup. This is deleted immediately after successful promotion. If the process exits between the backup and the final delete, a stale `.previous` backup may be left. The next cleanup pass removes it after it exceeds the 6-hour TTL.

### Cleanup counters

The `m3-docs-mcp update` command JSON output includes cleanup statistics:

```json
{
  "staleStagingDirsFound": 2,
  "staleStagingDirsRemoved": 2,
  "stalePreviousBackupsFound": 1,
  "stalePreviousBackupsRemoved": 1,
  "cleanupWarnings": []
}
```

## Refresh lock

To prevent two processes from promoting the cache simultaneously, a lock file is created before promotion:

```
<cacheDir>.lock
```

The lock contains the PID, run ID, start time, command, and cache directory of the process holding it.

Lock behavior:
- A fresh lock blocks other processes from starting a refresh. The blocked process exits with a clear error message.
- A lock older than **2 hours** is considered stale and overwritten.
- The lock is deleted after a successful or failed refresh.
- If the process exits without releasing the lock, it is automatically recovered after 2 hours.
- In-process deduplication (within the same MCP server) still applies: a second tool call to `refresh_material_docs` while a refresh is running reuses the existing refresh promise.

## Current limitations

This implementation extracts text/Markdown and page metadata. Image references are embedded as remote Markdown image URLs, but image assets are not downloaded or stored locally. The JSON extraction layer is schema-tolerant and preserves unknown content with explicit placeholders, but route discovery, per-page diffing, and richer section normalization can still be improved in later PRs.
