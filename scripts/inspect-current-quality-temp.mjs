import { chromium } from 'playwright';
import { extractContentPageToMaterialPage } from '../dist/json-extraction/extract-content-page.js';
import { fetchCarbonContentByReference } from '../dist/json-extraction/fetch-json-page.js';

const baseUrl = 'https://m3.material.io';
const carbonVersion = '2026-08-12_10-00-15';
const cases = [
  {
    name: 'components',
    url: `${baseUrl}/components`,
    file: '1624d6a1-96ea-437d-b846-dc6f00ebb49c.json',
    sectionIndices: undefined,
    titleOverride: undefined,
  },
  {
    name: 'typography-type-scale-tokens',
    url: `${baseUrl}/styles/typography/type-scale-tokens`,
    file: 'f6a1d89a-1bbf-46d1-a177-f13b074897a5.json',
    sectionIndices: [2],
    titleOverride: 'Type scale & tokens',
  },
];

for (const item of cases) {
  const result = await fetchCarbonContentByReference(baseUrl, carbonVersion, item.file);
  if (result.status !== 'ok') throw new Error(`${item.name}: Carbon fetch ${result.status}`);
  const extracted = await extractContentPageToMaterialPage({
    url: item.url,
    pageData: null,
    contentPage: result.data,
    fetchResource: async () => null,
    sectionIndices: item.sectionIndices,
    titleOverride: item.titleOverride,
    routeValidation: {
      sourceRoute: new URL(item.url).pathname,
      canonicalRoute: new URL(item.url).pathname,
      virtualRoute: new URL(item.url).pathname,
      exportedCarbonFileId: item.file,
    },
  });
  console.log(`\n=== EXTRACTION ${item.name} ===`);
  console.log(JSON.stringify({
    fallbackReason: extracted.fallbackReason,
    diagnostic: extracted.pageDiagnostic,
    markdownPreview: extracted.page.markdown.slice(0, 1800),
  }, null, 2));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const urls = new Set();
page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/_dsm/data/') || url.includes('TYPOGRAPHY')) urls.add(url);
});
await page.goto(`${baseUrl}/styles/typography/type-scale-tokens`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(10_000);
console.log('\n=== TYPOGRAPHY NETWORK ===');
for (const url of [...urls].sort()) console.log(url);
await browser.close();
