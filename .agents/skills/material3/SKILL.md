# Material 3 Documentation Skill

Use this skill before UI or UX changes. Check the official Material 3 documentation through this repository before changing layouts, components, dialogs, buttons, lists, navigation, colors, typography, motion, or accessibility.

Authoritative source: official Material 3 documentation from `m3.material.io`, cached locally by `m3-docs-mcp`.

## Workflow

1. Identify the relevant Material 3 component or pattern.
2. Search the local documentation.
3. Read the most relevant page.
4. Apply the guidance to UI and UX behavior.
5. Record which Material 3 page or component was checked.

## MCP access

Preferred tools:

- `search_material_docs`
- `get_material_page`
- `get_component_docs`
- `list_material_components`
- `material_docs_cache_status`
- `refresh_material_docs`

## CLI fallback

If MCP tools are unavailable, use CLI commands:

- `npx -y github:Vyachean/m3-docs-mcp status`
- `npx -y github:Vyachean/m3-docs-mcp search "dialog actions"`
- `npx -y github:Vyachean/m3-docs-mcp page components/dialogs/overview.md`
- `npx -y github:Vyachean/m3-docs-mcp component dialogs`
- `npx -y github:Vyachean/m3-docs-mcp components`

If the cache is missing, run `npx -y github:Vyachean/m3-docs-mcp install-browser` and then `npx -y github:Vyachean/m3-docs-mcp update`.
