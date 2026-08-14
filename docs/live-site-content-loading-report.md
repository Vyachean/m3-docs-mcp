# Live Site Content Loading Report

Date of research: 2026-06-29

## Inspected routes

- `/`
- `/components/switch/overview`
- `/components/switch/specs`
- `/components/buttons/overview`
- `/components/buttons/specs`
- `/components/lists/overview`
- `/components/lists/specs`
- `/components/segmented-buttons/overview`
- `/components/segmented-buttons/specs`
- `/styles/color/roles`
- `/foundations/design-tokens/overview`

## Methods used

- Direct HTTP fetches against `https://m3.material.io`
- Live Angular bundle parsing
- Live `site_meta.js` inspection
- Live `sitemap.xml` inspection
- Playwright browser capture of render-time requests and visible DOM
- Direct fetches of representative `page-data`, Carbon content, and DSDB resource JSON

## High-confidence findings

### 1. Direct route HTML is mostly a shell, not the primary docs payload

Direct route HTML responses such as `/components/switch/specs` return a valid HTML document with:

- route-specific `<title>`
- route-specific meta description / canonical URL
- the shared app shell
- script tags that boot the Angular app

The useful documentation body is not embedded as a stable, crawler-ready structured payload in the HTML response. The browser loads the actual page content from JSON after boot.

### 2. The live route-resolution model is:

`route HTML shell -> Angular main bundle route table -> page-data JSON -> Carbon content JSON -> DSDB resources -> rendered DOM`

This is the current evidence-backed loading model.

### 3. `site_meta.js` is not sufficient for current content resolution

Observed on 2026-06-29:

- `site_meta.js` parsed successfully and contained 376 routes.
- It did **not** contain current routes such as:
  - `/components/switch`
  - `/components/switch/overview`
  - `/components/switch/specs`
  - `/styles/color/roles`
  - `/foundations/design-tokens/overview`
- It still contains older / legacy routes such as `/components/switches`.

Conclusion:

- `site_meta.js` is useful as a secondary route hint source and legacy alias source.
- It is not sufficient for current M3 docs route resolution.
- Current `collectionId`, `documentId`, `exportedCarbonFileId`, tab labels, and many canonical current routes come from the Angular bundle route table, not `site_meta.js`.

### 4. The Angular bundle is required

Observed from the live main bundle:

- `carbonVersion` is embedded in the bundle. On 2026-06-29 it was:
  - `2026-06-24_09-00-10`
- The bundle contains the route table entries used for current docs resolution.
- Representative live bundle entries:

`components/switch`

- `documentId`: `6665545327575040`
- `collectionId`: `ComponentsM3`
- `exportedCarbonFileId`: `a4ad43f1-5c39-44b2-ae15-a7110bdf4fa6.json`
- `carbonPath`: `m3/pages/switch`
- tabs: `Overview`, `Specs`, `Guidelines`, `Accessibility`

`components/buttons`

- `documentId`: `5047690081337344`
- `collectionId`: `ComponentsM3`
- `exportedCarbonFileId`: `e31df68a-59d4-41dc-8743-8c48b476d4f8.json`
- `carbonPath`: `m3/pages/common-buttons`
- tabs: `Overview`, `Specs`, `Guidelines`, `Accessibility`

`components/segmented-buttons`

- `alternateSlugs`: `m3/pages/segmented-button`, `components/segmented-button`

`foundations/design-tokens`

- tabs: `Overview`, `How to use tokens`
- tab-level `alternateSlugs` exist for `Overview`

Conclusion:

- The Angular bundle is the authoritative current route table.
- `site_meta.js` alone cannot drive correct current route resolution.

## Observed request patterns

### Root HTML shell

Example:

- `GET https://m3.material.io/`

Returns HTML shell.

### Direct route HTML shell

Example:

- `GET https://m3.material.io/components/switch/specs`

Returns route-specific HTML shell with correct title / meta, then bootstraps the app.

### `site_meta.js`

Example:

- `GET https://m3.material.io/site_meta.js`

### Angular main bundle

Observed from shell HTML:

- `/static/angular/main.<hash>.js`

### Sitemap

Example:

- `GET https://m3.material.io/sitemap.xml`

Observed:

- sitemap exists
- it contains many current public routes
- it includes media URLs for image/video-rich routes

Conclusion:

- sitemap is useful as a discovery / coverage source
- sitemap is not enough to resolve page-data / Carbon / DSDB identities

### Page-data URL pattern

Observed browser pattern:

- `https://m3.material.io/page-data/{collectionId}/{documentId}.json?cachebust=<n>`

Observed direct-fetch pattern:

- `https://m3.material.io/page-data/{collectionId}/{documentId}.json`

Representative examples:

- `https://m3.material.io/page-data/ComponentsM3/6665545327575040.json`
- `https://m3.material.io/page-data/ComponentsM3/5047690081337344.json`
- `https://m3.material.io/page-data/GuidelinesM3/6620357365202944.json`
- `https://m3.material.io/page-data/GuidelinesM3/5348033117814784.json`

Observed browser behavior:

- overview and specs tabs for the same parent route reuse the same page-data document
- example:
  - `/components/switch/overview`
  - `/components/switch/specs`
  both request the same page-data document:
  - `page-data/ComponentsM3/6665545327575040.json`

### Carbon content URL pattern

Observed pattern:

- `https://m3.material.io/_dsm/content/m3/{carbonVersion}/{exportedCarbonFileId}`

Representative examples:

- `https://m3.material.io/_dsm/content/m3/2026-06-24_09-00-10/a4ad43f1-5c39-44b2-ae15-a7110bdf4fa6.json`
- `https://m3.material.io/_dsm/content/m3/2026-06-24_09-00-10/e31df68a-59d4-41dc-8743-8c48b476d4f8.json`
- `https://m3.material.io/_dsm/content/m3/2026-06-24_09-00-10/6d4033c2-f92c-4c43-b585-b3bce8468d48.json`

Observed browser behavior:

- overview and specs tabs for the same parent route reuse the same Carbon content file
- example:
  - `/components/switch/overview`
  - `/components/switch/specs`
  both request:
  - `a4ad43f1-5c39-44b2-ae15-a7110bdf4fa6.json`

### DSDB resource URL patterns

Observed patterns:

- status-table / generic DSDB component resource:
  - `https://m3.material.io/_dsm/data/dsdb-m3/{carbonVersion}/designSystems_<designSystemId>_components_<componentId>.json`
- token-table resource:
  - `https://m3.material.io/_dsm/data/dsdb-m3/{carbonVersion}/TOKEN_TABLE.<componentId>.json`
- typography token-system resource:
  - `https://m3.material.io/_dsm/data/dsdb-m3/{carbonVersion}/TYPOGRAPHY.<designSystemId>.json`

Representative examples:

- switch status table:
  - `https://m3.material.io/_dsm/data/dsdb-m3/2026-06-24_09-00-10/designSystems_030656e0a1083ef1_components_0fe2e78f2f029241.json`
- switch token table:
  - `https://m3.material.io/_dsm/data/dsdb-m3/2026-06-24_09-00-10/TOKEN_TABLE.33b1b2925d9ff561.json`
- buttons status table:
  - `https://m3.material.io/_dsm/data/dsdb-m3/2026-06-24_09-00-10/designSystems_030656e0a1083ef1_components_4c66f2c4b2f2cb18.json`
- buttons token table:
  - `https://m3.material.io/_dsm/data/dsdb-m3/2026-06-24_09-00-10/TOKEN_TABLE.1c4257f8804f9478.json`
- typography type-scale resource (observed 2026-08-14):
  - `https://m3.material.io/_dsm/data/dsdb-m3/2026-08-12_10-00-15/TYPOGRAPHY.20543ce18892f7d9.json`

## Route/reference resolution model

### Where route/reference fields come from

`collectionId`

- current source: Angular bundle route table

`documentId`

- current source: Angular bundle route table

`exportedCarbonFileId`

- current source: Angular bundle route table

`pageCanonId`

- current source: Carbon content JSON top-level `pageCanonId`
- may also be present in route planning outputs, but the live raw Carbon file is authoritative and directly observed

tabs

- current source: Angular bundle route table labels
- section backing for each tab comes from the Carbon content sections

aliases / alternate slugs

- current source: Angular bundle `alternateSlugs`
- `site_meta.js` still provides additional legacy aliases, but not enough for current routes

canonical routes

- current source: Angular bundle `slug`
- virtual tab routes are derived from the bundle slug plus tab slug

### Current practical resolver model

For current M3 docs pages:

1. Resolve the parent route in the Angular bundle route table.
2. Use bundle `collectionId` + `documentId` for page-data.
3. Use bundle `exportedCarbonFileId` + bundle `carbonVersion` for Carbon content.
4. For tabbed pages, derive virtual tab routes from the parent route and bundle tab labels.
5. Split the shared Carbon content into tab views using the Carbon section list.

## Page-data / Carbon / DSDB relationship

### Page-data

Observed live page-data for current routes is not the primary source of route identity.

The fetched page-data documents for current component pages were mostly content metadata payloads and did not expose the route-resolution fields the crawler actually needs as reliably as the bundle does.

### Carbon content

Observed live Carbon content is the primary structured documentation payload.

Representative top-level keys from the switch Carbon file:

- `pageId`
- `pageCanonId`
- `title`
- `slug`
- `headerTitle`
- `description`
- `updatedTimestamp`
- `sections`

Observed section structure:

- page sections have stable IDs:
  - `pageSectionId`
  - `pageSectionCanonId`
- blocks have stable IDs:
  - `pageContentBlockId`
  - `pageContentBlockCanonId`
- chunks have stable IDs:
  - `pageContentChunkId`
  - `pageContentChunkCanonId`

Observed chunk structure:

- `contentChunkType`
- `htmlValue`
- `imageUrl`
- `videoUrl`
- `resourceName`
- `libraryModuleType`
- `pageContentChunkId`
- `pageContentChunkCanonId`

Conclusion:

- raw content chunks do expose stable IDs
- deterministic positional IDs are only a fallback for unsupported / synthetic cases
- they should not be the primary ID scheme when these raw IDs exist

### DSDB resources

Carbon `RESOURCE` chunks directly reference DSDB resources by:

- `resourceName`
- `libraryModuleType`

Observed live examples for switch:

- status table chunk:
  - `resourceName`: `designSystems/030656e0a1083ef1/components/0fe2e78f2f029241`
  - `libraryModuleType`: `STATUS_TABLE`
- token table chunk:
  - `resourceName`: `designSystems/20543ce18892f7d9/components/33b1b2925d9ff561`
  - `libraryModuleType`: `TOKEN_TABLE`

Conclusion:

- token/status resources are referenced directly from Carbon content before Markdown render
- graph/resource linking should be built from those raw chunk references

## Tab handling model

### Tabs are virtual views over one shared parent content file

Observed for all inspected tabbed component pages:

- `/components/switch/overview` and `/components/switch/specs`
- `/components/buttons/overview` and `/components/buttons/specs`
- `/components/lists/overview` and `/components/lists/specs`
- `/components/segmented-buttons/overview` and `/components/segmented-buttons/specs`

Each pair shares:

- the same page-data document
- the same Carbon content document

Conclusion:

- `overview` and `specs` are not separate fetched content files
- they are virtual route views over different sections of one Carbon content page

### How the browser knows which section belongs to which tab

Observed live Carbon content uses page sections with human-readable names that match the bundle tabs.

Representative switch Carbon section names:

- `Overview`
- `Specs`
- `Guidelines`
- `Accessibility`

The bundle route entry for `components/switch` exposes the same tab labels:

- `Overview`
- `Specs`
- `Guidelines`
- `Accessibility`

Conclusion:

- tab-to-section matching is evidence-backed by bundle tab labels and Carbon section names / positions
- virtual tab routes should preserve:
  - parent source route
  - virtual route
  - tab label
  - tab slug
  - matched section index
  - matched section ID
  - match reason

## Token/status table resolution model

### Token tables

Observed specs pages request DSDB token tables during render.

Examples:

- switch specs:
  - `TOKEN_TABLE.33b1b2925d9ff561.json`
- buttons specs:
  - `TOKEN_TABLE.1c4257f8804f9478.json`
- lists specs:
  - `TOKEN_TABLE.6c818a16475113bd.json`
- segmented buttons specs:
  - `TOKEN_TABLE.67e2613d87ca6f98.json`

### Status tables

Observed overview/specs pages also request DSDB component resources that function as status/resource tables.

Examples:

- switch:
  - `designSystems_030656e0a1083ef1_components_0fe2e78f2f029241.json`
- buttons:
  - `designSystems_030656e0a1083ef1_components_4c66f2c4b2f2cb18.json`

### Before-vs-after render visibility

Available before Markdown/browser rendering:

- route slug
- document / collection identity
- carbon version
- Carbon page / section / block / chunk IDs
- section names
- resource references
- token table resource names
- status table resource names
- images/videos and their URLs

Only visible after browser render:

- exact DOM tab widgets
- final tab-active state
- rendered token table UI controls / menus
- visible text extracted from DSDB-rendered token table / status table components

Conclusion:

- the graph should be built from pre-render structured facts
- the browser oracle should validate the final rendered result, not act as the primary source of truth

## Browser oracle role

The browser is necessary for:

- validating that the live site still renders the expected routes
- capturing the real request graph
- confirming visible tab navigation and token/status table presence

The browser is **not** necessary as the primary crawler path for current M3 docs pages, because the site still exposes deterministic raw artifacts:

- bundle route table
- page-data JSON
- Carbon content JSON
- DSDB resource JSON

## Which current PR 29 assumptions are confirmed

- Raw snapshot first is the right direction.
- Markdown should be a derived compatibility output, not the source of truth.
- The Angular bundle is required for reliable current route resolution.
- Tab pages are virtual views over a parent content page.
- DSDB token/status resources are directly referenced from raw content.
- Browser oracle belongs in validation, not primary extraction.

## Which current PR 29 assumptions are wrong or too speculative

- `site_meta.js` is not sufficient for current route resolution.
- Graph facts should not be reconstructed from `MaterialIndex` page headings / aggregate counters when raw Carbon sections and chunks already expose real IDs and refs.
- Current tab pages should not be treated as secondary decorations on a parent route node only; they are first-class virtual routes.
- Route identity should not mix path routes, full URLs, and cache paths like `components/switch.md`.
- `carbonVersion` should not remain null when the live bundle exposes it directly.
- Deterministic positional IDs should not replace real raw section/chunk IDs where raw IDs already exist.

## Implementation changes required in PR 29

1. Build graph facts from raw decoded artifacts, not from `MaterialIndex` summaries.
2. Treat the Angular bundle route table as the primary live route-reference source.
3. Populate route references with real `collectionId`, `documentId`, `exportedCarbonFileId`, `pageCanonId`, and `carbonVersion`.
4. Represent virtual tab routes as first-class route/page nodes:
   - `/components/switch/overview`
   - `/components/switch/specs`
   - `/components/buttons/overview`
   - `/components/buttons/specs`
   - `/components/lists/overview`
   - `/components/lists/specs`
   - `/components/segmented-buttons/overview`
   - `/components/segmented-buttons/specs`
5. Use raw Carbon section / block / chunk IDs when building page and section graphs.
6. Build page graph sections/chunks from decoded Carbon content, not heading lists plus diagnostic counters.
7. Build resource graph from real Carbon `RESOURCE` chunks and media chunks, with virtual tab route association.
8. Build token-table graph from real DSDB token systems and route them to the virtual tab pages where used.
9. Normalize route identity to route paths everywhere; do not persist `.md` paths or full URLs as route identity.
10. Batch artifact-index writes; do not write one index file per artifact.
11. Make manifest health reflect actual validation state:
    - `verified` only after validation passes
    - `failed` after validation fails
    - `unverified` when validation did not run
12. Keep `verify:cache:full` strict and fail when graph/raw validation is broken even if Markdown exists.

## Short evidence list

- Live direct JSON inspection on 2026-06-29:
  - `site_meta.js`: 376 routes, but missing current component/style tab routes listed above
  - Angular bundle `carbonVersion`: `2026-06-24_09-00-10`
- Playwright capture on 2026-06-29:
  - `/components/switch/specs` requested:
    - `page-data/ComponentsM3/6665545327575040.json`
    - `_dsm/content/m3/2026-06-24_09-00-10/a4ad43f1-5c39-44b2-ae15-a7110bdf4fa6.json`
    - `_dsm/data/dsdb-m3/2026-06-24_09-00-10/TOKEN_TABLE.33b1b2925d9ff561.json`
    - `_dsm/data/dsdb-m3/2026-06-24_09-00-10/designSystems_030656e0a1083ef1_components_0fe2e78f2f029241.json`
- Live Carbon inspection on 2026-06-29:
  - switch Carbon file contains sections named `Overview`, `Specs`, `Guidelines`, `Accessibility`
  - those sections expose stable `pageSectionId` / `pageSectionCanonId`
  - chunks expose stable `pageContentChunkId` / `pageContentChunkCanonId`
