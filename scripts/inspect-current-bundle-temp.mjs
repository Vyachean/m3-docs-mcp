import { fetchAngularBundleText } from '../dist/json-extraction/page-reference-resolver.js';

const bundle = await fetchAngularBundleText('https://m3.material.io');

function show(needle, before = 1800, after = 3500) {
  const index = bundle.indexOf(needle);
  console.log(`\n===== ${needle} @ ${index} =====`);
  if (index >= 0) console.log(bundle.slice(Math.max(0, index - before), index + needle.length + after));
}

console.log('length', bundle.length);
for (const key of ['collectionId', 'documentId', 'exportedCarbonFileId', 'tabs', 'reference']) {
  console.log(`${key} occurrences`, bundle.split(key).length - 1);
}
show('"slug":"components/buttons"');
show('"slug":"styles/shape"');
show('"slug":"foundations/design-tokens"');
show('collectionId', 1200, 2500);
show('documentId', 1200, 2500);
show('exportedCarbonFileId', 1200, 2500);
