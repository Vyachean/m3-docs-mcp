import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleRoutesUnderPrefix,
  extractBundleRouteTable,
  extractCarbonVersion,
  findSubtreesWithoutCoverage,
  matchTabToSection,
  resolvePageReference,
} from '../src/json-extraction/page-reference-resolver.js';

// Trimmed real bundle text captured from a live Angular main.<hash>.js (see scripts/inspect-site-data.mjs).
const FIXTURE_PATH = join(__dirname, 'fixtures/bundle/route-table-slice.js');
const fixtureText = readFileSync(FIXTURE_PATH, 'utf8');

describe('extractCarbonVersion', () => {
  it('extracts the literal carbonVersion from the fixture', () => {
    expect(extractCarbonVersion(fixtureText)).toBe('2026-06-10_13-00-05');
  });

  it('returns null when carbonVersion is absent', () => {
    expect(extractCarbonVersion('no version here')).toBeNull();
  });
});

describe('extractBundleRouteTable (real fixture)', () => {
  const routes = extractBundleRouteTable(fixtureText);

  it('parses all 4 representative route entries', () => {
    expect(routes.map((r) => r.slug).sort()).toEqual([
      'components/buttons',
      'components/lists',
      'foundations/design-tokens',
      'styles/color/roles',
    ]);
  });

  it('parses collectionId/documentId/exportedCarbonFileId for components/buttons', () => {
    const buttons = routes.find((r) => r.slug === 'components/buttons');
    expect(buttons).toMatchObject({
      documentId: '5047690081337344',
      collectionId: 'ComponentsM3',
      exportedCarbonFileId: 'e31df68a-59d4-41dc-8743-8c48b476d4f8.json',
    });
    expect(buttons?.tabs?.map((t) => t.label)).toEqual(['Overview', 'Specs', 'Guidelines', 'Accessibility']);
  });

  it('parses top-level alternateSlugs for styles/color/roles (no tabs)', () => {
    const roles = routes.find((r) => r.slug === 'styles/color/roles');
    expect(roles?.alternateSlugs).toEqual([
      'styles/color/the-color-system/key-colors-tones',
      'styles/color/the-color-system',
    ]);
    expect(roles?.tabs).toBeUndefined();
  });

  it('parses tab-level alternateSlugs for foundations/design-tokens', () => {
    const tokens = routes.find((r) => r.slug === 'foundations/design-tokens');
    expect(tokens?.tabs?.[0]).toMatchObject({
      label: 'Overview',
      alternateSlugs: ['overview/825906c9-6eed-47d1-8812-450910c1356e'],
    });
    expect(tokens?.tabs?.[1]).toMatchObject({ label: 'How to use tokens' });
  });

  it('skips malformed fragments without a slug', () => {
    const routes2 = extractBundleRouteTable('{"notSlug":"x","documentId":"1"}');
    expect(routes2).toHaveLength(0);
  });
});

describe('resolvePageReference', () => {
  const routes = extractBundleRouteTable(fixtureText);

  it('resolves an exact slug match', () => {
    const result = resolvePageReference('/components/buttons', routes);
    expect(result.pageReferenceSource).toBe('bundle-table');
    if (result.pageReferenceSource === 'bundle-table') {
      expect(result.entry.documentId).toBe('5047690081337344');
    }
  });

  it('resolves via alternateSlugs when slug does not match directly', () => {
    const result = resolvePageReference('/styles/color/the-color-system', routes);
    expect(result.pageReferenceSource).toBe('bundle-table');
    if (result.pageReferenceSource === 'bundle-table') {
      expect(result.entry.slug).toBe('styles/color/roles');
    }
  });

  it('returns missing when no entry matches', () => {
    const result = resolvePageReference('/nonexistent', routes);
    expect(result.pageReferenceSource).toBe('missing');
  });
});

describe('matchTabToSection', () => {
  it('matches by tab slug/alternateSlugs first', () => {
    const tab = { label: 'Overview', alternateSlugs: ['overview/abc'] };
    const sections = [{ name: 'overview/abc' }, { name: 'Specs' }];
    const result = matchTabToSection(tab, 0, sections, 2);
    expect(result).toMatchObject({ matched: true, sectionIndex: 0, matchedBy: 'slug' });
  });

  it('matches by normalized label when slug is absent', () => {
    const tab = { label: 'Specs' };
    const sections = [{ name: 'Overview' }, { name: 'Specs' }, { name: 'Guidelines' }, { name: 'Accessibility' }];
    const result = matchTabToSection(tab, 1, sections, 4);
    expect(result).toMatchObject({ matched: true, sectionIndex: 1, matchedBy: 'label' });
  });

  it('falls back to position only when tab count equals section count and label mismatches', () => {
    const tab = { label: 'Renamed Tab' };
    const sections = [{ name: 'Overview' }, { name: 'Something Else' }];
    const result = matchTabToSection(tab, 1, sections, 2);
    expect(result).toMatchObject({ matched: true, sectionIndex: 1, matchedBy: 'position' });
  });

  it('does not match by position when tab count differs from section count and label mismatches', () => {
    const tab = { label: 'Renamed Tab' };
    const sections = [{ name: 'Overview' }, { name: 'Something Else' }, { name: 'A Third' }];
    const result = matchTabToSection(tab, 1, sections, 2);
    expect(result).toMatchObject({ matched: false, reason: 'tab-section-mismatch' });
  });
});

describe('findSubtreesWithoutCoverage / bundleRoutesUnderPrefix', () => {
  it('flags styles and foundations as uncovered when site_meta has no entries for them', () => {
    const siteMetaPaths = ['/', '/components/buttons', '/components/lists'];
    const uncovered = findSubtreesWithoutCoverage(siteMetaPaths, ['styles', 'foundations', 'components']);
    expect(uncovered.sort()).toEqual(['foundations', 'styles']);
  });

  it('does not flag a prefix that has any site_meta coverage', () => {
    const siteMetaPaths = ['/styles/color'];
    const uncovered = findSubtreesWithoutCoverage(siteMetaPaths, ['styles']);
    expect(uncovered).toEqual([]);
  });

  it('returns bundle entries under an uncovered prefix for supplementing the route list', () => {
    const routes = extractBundleRouteTable(fixtureText);
    const supplement = bundleRoutesUnderPrefix(routes, 'styles');
    expect(supplement.map((r) => r.slug)).toEqual(['styles/color/roles']);
  });
});
