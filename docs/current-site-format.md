# Current Material site discovery contract

As of August 2026, `https://m3.material.io/site_meta.js` is no longer available. The live site still exposes `sitemap.xml` for public URL discovery and an Angular main bundle for page-reference metadata (`collectionId`, `documentId`, tabs, and `carbonVersion`).

Crawler ownership must therefore be:

- `sitemap.xml`: public route discovery and coverage boundary;
- Angular main bundle: extraction metadata and tab-parent reconciliation;
- `site_meta.js`: optional legacy enrichment only when available;
- browser navigation/network capture: validation or explicitly enabled recovery, never the default crawl source.

A full refresh must fail closed when neither sitemap discovery nor the required bundle metadata is usable.
