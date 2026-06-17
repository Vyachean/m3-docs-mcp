#!/usr/bin/env node
// Live-data inspection tool. Documents the deterministic site_meta -> bundle -> page-data -> Carbon
// pipeline against the real m3.material.io site, for the representative routes that the cache
// pipeline must support. Prints diagnostics, never writes anything.
//
// Usage: npm run inspect:site-data [-- --base-url https://m3.material.io]

import { fetchSiteMeta } from '../dist/json-extraction/fetch-site-meta.js';
import {
  fetchAngularBundleText,
  extractCarbonVersion,
  extractBundleRouteTable,
  resolvePageReference,
} from '../dist/json-extraction/page-reference-resolver.js';

const baseUrlArgIndex = process.argv.indexOf('--base-url');
const baseUrl = baseUrlArgIndex >= 0 ? process.argv[baseUrlArgIndex + 1] : 'https://m3.material.io';

const REPRESENTATIVE_ROUTES = [
  '/',
  '/components/buttons/specs',
  '/components/lists/specs',
  '/styles/color/roles',
  '/foundations/design-tokens/overview',
];

function stripTabSuffix(path) {
  const segments = path.replace(/^\/+|\/+$/g, '').split('/');
  return { parentSlug: segments.slice(0, -1).join('/'), possibleTabSlug: segments.at(-1) ?? '' };
}

async function main() {
  console.log(`Inspecting ${baseUrl} ...\n`);

  let siteMeta;
  let siteMetaError = null;
  try {
    siteMeta = await fetchSiteMeta(baseUrl);
  } catch (err) {
    siteMetaError = err instanceof Error ? err.message : String(err);
  }
  console.log('site_meta.js:', siteMetaError ? `FAILED — ${siteMetaError}` : `ok, ${Object.keys(siteMeta.routes).length} routes`);

  const bundleText = await fetchAngularBundleText(baseUrl);
  const carbonVersion = extractCarbonVersion(bundleText);
  const bundleRoutes = extractBundleRouteTable(bundleText);
  console.log('Angular bundle:', `carbonVersion=${carbonVersion}, ${bundleRoutes.length} route entries\n`);

  for (const routePath of REPRESENTATIVE_ROUTES) {
    console.log(`--- ${routePath} ---`);
    const normalizedPath = routePath.replace(/^\/+/, '');
    const siteMetaKey = siteMeta?.routes[routePath] ? routePath : 'missing';
    console.log('  site_meta route key:', siteMetaKey);
    if (siteMeta?.routes[routePath]) {
      const r = siteMeta.routes[routePath];
      console.log('  site_meta.route:', r.route);
      console.log('  site_meta.other_routes:', r.other_routes);
      console.log('  site_meta.public:', r.public);
      console.log('  site_meta.redirect_external_url:', r.redirect_external_url ?? null);
      console.log('  site_meta.reference.collection_id:', r.reference?.collection_id ?? null);
      console.log('  site_meta.reference.document_id:', r.reference?.document_id ?? null);
      console.log('  site_meta.reference.repo_id:', r.reference?.repo_id ?? null);
    }

    let directRef = resolvePageReference(normalizedPath, bundleRoutes);
    let matchedTab = null;
    if (directRef.pageReferenceSource === 'missing') {
      const { parentSlug, possibleTabSlug } = stripTabSuffix(normalizedPath);
      const parentRef = resolvePageReference(parentSlug, bundleRoutes);
      if (parentRef.pageReferenceSource === 'bundle-table') {
        directRef = parentRef;
        matchedTab = parentRef.entry.tabs?.find(
          (t) => normalizeLabel(t.label) === normalizeLabel(possibleTabSlug)
        ) ?? null;
      }
    }

    console.log('  pageReferenceSource:', directRef.pageReferenceSource);
    if (directRef.pageReferenceSource === 'bundle-table') {
      const entry = directRef.entry;
      console.log('  resolved slug:', entry.slug, matchedTab ? `(tab: ${matchedTab.label})` : '');
      console.log('  collectionId:', entry.collectionId, 'documentId:', entry.documentId, 'repoId:', entry.repoId ?? null);
      const pageDataUrl = `${baseUrl}/page-data/${entry.collectionId}/${entry.documentId}.json`;
      console.log('  page-data URL:', pageDataUrl);
      const pdStatus = await safeFetchStatus(pageDataUrl);
      console.log('  page-data fetch status:', pdStatus);

      if (entry.exportedCarbonFileId) {
        const carbonUrl = `${baseUrl}/_dsm/content/m3/${carbonVersion}/${entry.exportedCarbonFileId}`;
        console.log('  carbon URL:', carbonUrl);
        const carbonStatus = await safeFetchStatus(carbonUrl);
        console.log('  carbon fetch status:', carbonStatus);
      } else {
        console.log('  carbon URL: (no exportedCarbonFileId)');
      }
    }
    console.log();
  }
}

function normalizeLabel(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function safeFetchStatus(url) {
  try {
    const res = await fetch(url);
    return res.status;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
