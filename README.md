# m3-docs-mcp

MCP server that provides agents with locally cached documentation from the official Material 3 site: <https://m3.material.io/>.

The package does **not** vendor a full copy of Material documentation. It crawls the official SPA with Playwright and stores a cache on the user's machine. This keeps installation lightweight and avoids publishing a public copy of Google's documentation text and images.

## Why this exists

`m3.material.io` is a JavaScript application. Simple fetch/curl-based agents often cannot read the documentation reliably. This server makes the docs available through deterministic MCP tools backed by a local cache.

## Install

```bash
npm install -g m3-docs-mcp
npx playwright install chromium
```

Or use it without global install:

```bash
npx -y m3-docs-mcp serve
```

## MCP client config

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

By default the server refreshes the cache when it is older than 24 hours.

## CLI

```bash
m3-docs-mcp status
m3-docs-mcp update
m3-docs-mcp update --max-pages 500
m3-docs-mcp serve
m3-docs-mcp serve --max-age-hours 12
```

## Cache location

Default cache locations:

- Linux: `$XDG_CACHE_HOME/m3-docs-mcp` or `~/.cache/m3-docs-mcp`
- macOS: `~/Library/Caches/m3-docs-mcp`
- Windows: `%LOCALAPPDATA%/m3-docs-mcp`

Override:

```bash
M3_DOCS_CACHE_DIR=/path/to/cache m3-docs-mcp serve
```

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

### `refresh_material_docs`

Forces a cache refresh through Playwright.

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
