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

The server does not run a long documentation crawl during normal read/search tool calls. Create or refresh the local cache explicitly:

```bash
npx -y m3-docs-mcp update
```

If the cache is missing, read/search tools return an error that asks the user to run `m3-docs-mcp update`. If the cache exists but is stale, tools still answer from the existing cache and include cache status metadata.

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
npx -y m3-docs-mcp update
npx -y m3-docs-mcp update --max-pages 500
npx -y m3-docs-mcp update --min-pages 25
npx -y m3-docs-mcp serve
npx -y m3-docs-mcp serve --max-age-hours 12
```

`--max-age-hours` only marks cache status as fresh/stale. It does not trigger implicit refresh during read/search tool calls.

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

Cache refresh is staged in a temporary directory and promoted only after the crawl result passes basic validation. A failed or suspicious crawl should not replace the previous cache.

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

Returns one cached page by source URL or local cache path.

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

Returns local cache status without refreshing it.

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

## Current limitations

This is an initial implementation. It extracts text/Markdown and page metadata. Image downloading, stronger route discovery, per-page diffing, and richer section normalization should be added in later PRs.