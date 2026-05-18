# m3-docs-mcp

MCP server that provides agents with locally cached documentation from the official Material 3 site: <https://m3.material.io/>.

The package does **not** vendor a full copy of Material documentation. It crawls the official SPA with Playwright and stores a cache on the user's machine. This keeps installation lightweight and avoids publishing a public copy of Google's documentation text and images.

## Why this exists

`m3.material.io` is a JavaScript application. Simple fetch/curl-based agents often cannot read the documentation reliably. This server makes the docs available through deterministic MCP tools backed by a local cache.

## Recommended setup

Add the server to your MCP client config. No global install is required.

```json
{
  "mcpServers": {
    "material3": {
      "command": "npx",
      "args": ["-y", "m3-docs-mcp", "serve"]
    }
  }
}
```

The MCP server starts without downloading a browser during npm install. Browser installation is only needed when refreshing the local documentation cache. This keeps normal MCP startup fast enough for clients with short stdio initialization timeouts.

Install the package-local browser before the first cache refresh:

```bash
npx -y m3-docs-mcp install-browser
```

On Linux, Chromium may also need system packages. Use this variant when Playwright reports missing host dependencies:

```bash
npx -y m3-docs-mcp install-browser --with-deps
```

Then build or refresh the documentation cache:

```bash
npx -y m3-docs-mcp update
```

On startup, the server checks the local cache. If the cache is missing or stale, it starts a Playwright refresh in the background. Normal read/search tool calls do not wait for the crawl and therefore should not hit short MCP client tool timeouts. While the first cache is being built, read/search tools return cache status and ask the client to retry after the background refresh completes.

If the cache exists but is stale, tools continue answering from the existing cache and include cache status plus background refresh metadata. Concurrent startup and manual refresh requests are deduplicated inside the running server so only one crawl promotes the cache at a time.

## Codex setup

Codex uses TOML MCP configuration. It also applies a short startup timeout unless configured otherwise, so give this server enough time for `npx` cold starts and tool listing.

Add this to `~/.codex/config.toml` or the project-level `.codex/config.toml`:

```toml
[mcp_servers.material3]
command = "npx"
args = ["-y", "m3-docs-mcp", "serve"]
startup_timeout_sec = 120
tool_timeout_sec = 300
enabled = true
```

For a first-time setup, run the browser/cache prewarm outside Codex:

```bash
npx -y m3-docs-mcp install-browser
npx -y m3-docs-mcp update
```

If you intentionally want to test the GitHub version before npm publishing, use the GitHub package reference but keep the same timeouts:

```toml
[mcp_servers.material3]
command = "npx"
args = ["-y", "github:Vyachean/m3-docs-mcp", "serve"]
startup_timeout_sec = 120
tool_timeout_sec = 300
enabled = true
```

The GitHub variant is slower on cold start because npm may build the TypeScript package from source before the MCP server starts. Prefer the published npm package for normal Codex usage.

## Use directly from GitHub before npm publishing

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

## Optional CLI usage

```bash
npx -y m3-docs-mcp status
npx -y m3-docs-mcp install-browser
npx -y m3-docs-mcp install-browser --with-deps
npx -y m3-docs-mcp update
npx -y m3-docs-mcp update --max-pages 500
npx -y m3-docs-mcp update --min-pages 25
npx -y m3-docs-mcp update --force
npx -y m3-docs-mcp serve
npx -y m3-docs-mcp serve --max-age-hours 12
npx -y m3-docs-mcp serve --startup-max-pages 500
npx -y m3-docs-mcp serve --no-auto-update
```

`--max-age-hours` marks cache status as fresh/stale and controls whether startup auto-update is needed. It does not make read/search tool calls block on a refresh.

`update` refuses to replace an existing cache when the new crawl is suspiciously degraded: fewer than 80% of the previous cache pages, more than 20% failed attempted pages after at least 10 attempts, duplicate page bodies, or component URLs that rendered unrelated/parent content. Use `--force` only when you intentionally want to replace the existing cache despite these safeguards.

Global install is optional and mainly useful for development or repeated manual diagnostics:

```bash
npm install -g m3-docs-mcp
```

## Cache location

Default cache locations:

- Linux: `$XDG_CACHE_HOME/m3-docs-mcp` or `~/.cache/m3-docs-mcp`
- macOS: `~/Library/Caches/m3-docs-mcp`
- Windows: `%LOCALAPPDATA%/m3-docs-mcp`

Override:

```bash
M3_DOCS_CACHE_DIR=/path/to/cache npx -y m3-docs-mcp serve
```

Cache refresh is staged in a temporary directory and promoted only after the crawl result passes basic validation and safety checks against the previous cache. A failed or suspicious crawl should not replace the previous cache. A running MCP server re-reads cache metadata before serving tools and rebuilds its in-memory search index when the cache changes externally.

The crawler normalizes component landing links such as `/components/buttons` to their stable SPA route `/components/buttons/overview` before navigation. It then waits for the rendered `main` content, final browser URL, page title, and text snapshot to stabilize before extraction. Cached lookup still accepts both forms, so `components/buttons` and `components/buttons/overview.md` resolve to the same cached page when the overview page was stored.

Each refreshed index includes a `qualityReport` with duplicate page bodies, suspicious route/content mismatches, short pages, duplicate titles, and page counts by section. This helps diagnose SPA route failures such as `/components/buttons` rendering the parent `Components` listing instead of the Buttons documentation.

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

Returns local cache status and startup background refresh status.

### `refresh_material_docs`

Forces a cache refresh through Playwright. This is an explicit long-running operation.

Arguments:

```json
{
  "maxPages": 250
}
```

## Project rules

- The official source is always `https://m3.material.io/`.
- Google implementation repositories are not treated as authoritative design guidelines.
- Cached docs are stored locally for the user running the MCP server.
- The npm package should not include a full public mirror of Material documentation.
- Normal read/search tools must not trigger or wait for a long crawl.
- Startup cache warming may run a crawl in the background so first-time users do not need manual setup.
- npm install must not download Playwright browsers, because MCP clients such as Codex can time out before the stdio handshake completes.

## Current limitations

This is an initial implementation. It extracts text/Markdown and page metadata. Image downloading, stronger route discovery, per-page diffing, and richer section normalization should be added in later PRs.
