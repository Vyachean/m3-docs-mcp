import { describe, expect, it } from 'vitest';
import { extractDisplayTokenSets, tokenTableToMarkdown } from '../src/crawler.js';

const LIGHT_TAG = 'designSystems/ds1/contextTagGroups/theme/tags/light';
const DARK_TAG = 'designSystems/ds1/contextTagGroups/theme/tags/dark';
const ANDROID_TAG = 'designSystems/ds1/contextTagGroups/platform/tags/android';
const AUDIENCE_3P_TAG = 'designSystems/ds1/contextTagGroups/audience/tags/3p';
const AUDIENCE_1P_TAG = 'designSystems/ds1/contextTagGroups/audience/tags/1p';
const HIGH_CONTRAST_TAG = 'designSystems/ds1/contextTagGroups/contrast/tags/hc';
const DEFAULT_CONTRAST_TAG = 'designSystems/ds1/contextTagGroups/contrast/tags/default';

function makeSystem(overrides = {}) {
  return {
    tokens: [
      {
        name: 'designSystems/ds1/tokenSets/ts1/tokens/tok1',
        tokenName: 'md.comp.button.container.color',
        displayName: 'Button container color',
        tokenValueType: 'COLOR',
        state: 'ACTIVE',
      },
    ],
    tokenSets: [{ name: 'designSystems/ds1/tokenSets/ts1', displayName: 'Button - Common', tokenSetName: 'md.comp.button' }],
    tags: [
      { name: LIGHT_TAG, displayName: 'Light', tagName: 'light' },
      { name: DARK_TAG, displayName: 'Dark', tagName: 'dark' },
      { name: ANDROID_TAG, displayName: 'Android', tagName: 'android' },
      { name: AUDIENCE_3P_TAG, displayName: '3P', tagName: '3p' },
      { name: AUDIENCE_1P_TAG, displayName: '1P Baseline', tagName: '1p.baseline' },
      { name: HIGH_CONTRAST_TAG, displayName: 'High contrast', tagName: 'high.contrast' },
      { name: DEFAULT_CONTRAST_TAG, displayName: 'Default', tagName: 'default' },
    ],
    contextTagGroups: [
      { name: 'designSystems/ds1/contextTagGroups/theme', displayName: 'Theme', defaultTag: LIGHT_TAG },
      { name: 'designSystems/ds1/contextTagGroups/platform', displayName: 'Platform', defaultTag: ANDROID_TAG },
      { name: 'designSystems/ds1/contextTagGroups/audience', displayName: 'Audience', defaultTag: AUDIENCE_1P_TAG },
      { name: 'designSystems/ds1/contextTagGroups/contrast', displayName: 'Contrast', defaultTag: DEFAULT_CONTRAST_TAG },
    ],
    contextualReferenceTrees: {
      'designSystems/ds1/tokenSets/ts1/tokens/tok1': {
        contextualReferenceTree: [
          {
            contextTags: [LIGHT_TAG, ANDROID_TAG, AUDIENCE_3P_TAG],
            referenceTree: {
              tokenName: 'md.comp.button.container.color',
              childNodes: [{ tokenName: 'md.sys.color.primary', childNodes: [{ tokenName: 'md.ref.palette.primary40' }] }],
            },
            resolvedValue: { color: { red: 0.38, green: 0.0, blue: 0.93, alpha: 1 } },
          },
          {
            contextTags: [DARK_TAG, ANDROID_TAG, AUDIENCE_3P_TAG],
            referenceTree: {
              tokenName: 'md.comp.button.container.color',
              childNodes: [{ tokenName: 'md.sys.color.primary', childNodes: [{ tokenName: 'md.ref.palette.primary80' }] }],
            },
            resolvedValue: { color: { red: 0.82, green: 0.68, blue: 1, alpha: 1 } },
          },
          {
            contextTags: [LIGHT_TAG, ANDROID_TAG, AUDIENCE_3P_TAG, HIGH_CONTRAST_TAG],
            referenceTree: {
              tokenName: 'md.comp.button.container.color',
              childNodes: [{ tokenName: 'md.sys.color.primary', childNodes: [{ tokenName: 'md.ref.palette.primary20' }] }],
            },
            resolvedValue: { color: { red: 0.12, green: 0.0, blue: 0.55, alpha: 1 } },
          },
          {
            contextTags: [DARK_TAG, ANDROID_TAG, AUDIENCE_3P_TAG, HIGH_CONTRAST_TAG],
            referenceTree: {
              tokenName: 'md.comp.button.container.color',
              childNodes: [{ tokenName: 'md.sys.color.primary', childNodes: [{ tokenName: 'md.ref.palette.primary90' }] }],
            },
            resolvedValue: { color: { red: 0.93, green: 0.81, blue: 1, alpha: 1 } },
          },
        ],
      },
    },
    ...overrides,
  };
}

describe('tokenTableToMarkdown', () => {
  it('generates a table with Name/Token/sys/ref/Light/Dark columns', () => {
    const md = tokenTableToMarkdown(makeSystem() as any, ['Button - Common']);
    expect(md).toContain('## Design Tokens');
    expect(md).toContain('### Button - Common');
    expect(md).toContain('| Token | Name | sys alias | ref alias | Light | Dark |');
    expect(md).toContain('md.comp.button.container.color');
    expect(md).toContain('md.sys.color.primary');
    expect(md).toContain('md.ref.palette.primary40');
  });

  it('converts color resolved values to hex', () => {
    const md = tokenTableToMarkdown(makeSystem() as any, ['Button - Common']);
    // Light: rgb(97, 0, 237) ≈ #6100ed, Dark: rgb(209, 173, 255) ≈ #d1adff
    expect(md).toMatch(/#[0-9a-f]{6}/i);
  });

  it('includes high-contrast columns when HC data is present', () => {
    const md = tokenTableToMarkdown(makeSystem() as any, ['Button - Common']);
    expect(md).toContain('Light (High contrast)');
    expect(md).toContain('Dark (High contrast)');
  });

  it('omits HC columns when no high-contrast data exists', () => {
    const sys = makeSystem();
    // Remove HC entries
    (sys.contextualReferenceTrees['designSystems/ds1/tokenSets/ts1/tokens/tok1'] as any).contextualReferenceTree =
      (sys.contextualReferenceTrees['designSystems/ds1/tokenSets/ts1/tokens/tok1'] as any).contextualReferenceTree.filter(
        (e: any) => !e.contextTags.includes(HIGH_CONTRAST_TAG)
      );
    const md = tokenTableToMarkdown(sys as any, ['Button - Common']);
    expect(md).not.toContain('High contrast');
  });

  it('returns empty string when no matching token sets', () => {
    const md = tokenTableToMarkdown(makeSystem() as any, ['NonExistent Set']);
    expect(md).toBe('');
  });

  it('returns empty string when no tokens have tree data', () => {
    const sys = makeSystem({ contextualReferenceTrees: {} });
    const md = tokenTableToMarkdown(sys as any, ['Button - Common']);
    expect(md).toBe('');
  });
});

describe('extractDisplayTokenSets', () => {
  it('parses display-token-sets attribute from HTML', () => {
    const html = '<token-viewer display-token-sets="[&quot;List - Common&quot;,&quot;List - Expand&quot;]"></token-viewer>';
    expect(extractDisplayTokenSets(html)).toEqual(['List - Common', 'List - Expand']);
  });

  it('returns empty array when attribute is missing', () => {
    expect(extractDisplayTokenSets('<token-viewer></token-viewer>')).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    expect(extractDisplayTokenSets('<token-viewer display-token-sets="not-json"></token-viewer>')).toEqual([]);
  });
});
