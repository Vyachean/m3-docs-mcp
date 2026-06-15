import { describe, expect, it } from 'vitest';
import { extractMaterialPageFromHtml } from '../src/crawler.js';

const LIGHT_TAG = 'designSystems/ds1/contextTagGroups/theme/tags/light';
const DARK_TAG = 'designSystems/ds1/contextTagGroups/theme/tags/dark';
const ANDROID_TAG = 'designSystems/ds1/contextTagGroups/platform/tags/android';
const AUDIENCE_3P_TAG = 'designSystems/ds1/contextTagGroups/audience/tags/3p';
const AUDIENCE_1P_TAG = 'designSystems/ds1/contextTagGroups/audience/tags/1p.baseline';
const DEFAULT_CONTRAST_TAG = 'designSystems/ds1/contextTagGroups/contrast/tags/default';

function makeTokenSystem() {
  return {
    tokens: [
      {
        name: 'designSystems/ds1/tokenSets/ts1/tokens/tok1',
        tokenName: 'md.comp.button.container.color',
        displayName: 'Container color',
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
        ],
      },
    },
  };
}

describe('Material markdown extraction regressions', () => {
  it('converts HTML tables to markdown tables without flattening nested table rows or cells', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Tables</h1>
        <table>
          <thead>
            <tr><th>Attribute</th><th>Value</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Top margin</td>
              <td>72dp<table><tr><td>Nested value</td></tr></table></td>
            </tr>
            <tr><td>Width</td><td>Full width</td></tr>
          </tbody>
        </table>
      </main>
    `, 'https://m3.material.io/components/bottom-sheets/specs', '2026-05-18T00:00:00.000Z');

    expect(page.markdown).toContain('| Attribute | Value |');
    expect(page.markdown).toContain('| --- | --- |');
    expect(page.markdown).toContain('| Top margin | 72dp');
    expect(page.markdown).toContain('| Width | Full width |');
    expect(page.markdown).not.toContain('| Nested value |');
  });

  it('converts token-viewer table-shaped content to markdown tables', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Tokens</h1>
        <token-viewer>
          <div class="token-row"><span class="name">Container color</span><span class="value">Surface</span></div>
          <div class="token-row"><span class="name">Shape</span><span class="value">Corner full</span></div>
        </token-viewer>
      </main>
    `, 'https://m3.material.io/components/chips/specs', '2026-05-18T00:00:00.000Z');

    expect(page.markdown).toContain('| Name | Value |');
    expect(page.markdown).toContain('| Container color | Surface |');
    expect(page.markdown).toContain('| Shape | Corner full |');
  });

  it('extracts token-viewer <token> custom elements into a Name/Token/Value table', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Design Tokens</h1>
        <token-viewer>
          <token aria-label="Container color">
            <div class="token">
              <div class="token-content">
                <div class="display-name"><div class="display-name-container"><span class="display-name__text"> Container color </span></div></div>
                <div class="column"><div class="token-name"><span class="text-value"> md.comp.list.list-item.container.color </span><button aria-label="Copy token name"><mat-icon>content_copy</mat-icon></button></div></div>
              </div>
              <div class="token-value-container">
                <div class="token-value-wrapper">
                  <token-value-color><div class="token-value-color-container"><div class="token-value-color"><span class="token-value-color-content"><span class="display-name-container"> #FEF7FF </span></span></div></div></token-value-color>
                </div>
              </div>
            </div>
          </token>
          <token aria-label="Divider height">
            <div class="token">
              <div class="token-content">
                <div class="display-name"><div class="display-name-container"><span class="display-name__text"> Divider height </span></div></div>
                <div class="column"><div class="token-name"><span class="text-value"> md.comp.list.divider.height </span><button aria-label="Copy token name"><mat-icon>content_copy</mat-icon></button></div></div>
              </div>
              <div class="token-value-container">
                <div class="token-value-wrapper">
                  <token-value-length><div class="token-value-length-container"><div class="token-value-length"><span> 1dp </span></div></div></token-value-length>
                </div>
              </div>
            </div>
          </token>
        </token-viewer>
      </main>
    `, 'https://m3.material.io/components/lists/specs', '2026-05-18T00:00:00.000Z');

    expect(page.markdown).toContain('| Name | Token | Value |');
    expect(page.markdown).toContain('| Container color | md.comp.list.list-item.container.color | #FEF7FF |');
    expect(page.markdown).toContain('| Divider height | md.comp.list.divider.height | 1dp |');
  });

  it('falls back to token-viewer key-value lines when no row structure is available', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Measurements</h1>
        <token-viewer>
          Attribute
          Value
          Top margin
          72dp
        </token-viewer>
      </main>
    `, 'https://m3.material.io/components/bottom-sheets/specs', '2026-05-18T00:00:00.000Z');

    expect(page.markdown).toContain('| Name | Value |');
    expect(page.markdown).toContain('| Attribute | Value |');
    expect(page.markdown).toContain('| Top margin | 72dp |');
  });

  it('keeps the larger responsive image variant even when markdown images have whitespace between them', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Images</h1>
        <p>
          <img alt="Example" src="https://example.com/image=w1200">
          <img alt="Example" src="https://example.com/image=s0">
        </p>
      </main>
    `, 'https://m3.material.io/components/images', '2026-05-18T00:00:00.000Z');

    expect(page.markdown).toContain('![Example](https://example.com/image=w1200)');
    expect(page.markdown).not.toContain('image=s0');
  });

  it('upscales tiny Material image width parameters before embedding markdown images', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Images</h1>
        <p><img alt="Tiny" src="https://example.com/image=w40"></p>
        <div style="background-image: url('https://example.com/background=w80')">Background</div>
        <p><img alt="Cropped" src="https://example.com/cropped=w40-c"></p>
      </main>
    `, 'https://m3.material.io/components/images', '2026-05-18T00:00:00.000Z');

    expect(page.markdown).toContain('![Tiny](https://example.com/image=w1600)');
    expect(page.markdown).toContain('![Background](https://example.com/background=w1600)');
    expect(page.markdown).toContain('![Cropped](https://example.com/cropped=w1600-c)');
    expect(page.markdown).not.toContain('=w40');
    expect(page.markdown).not.toContain('=w80');
  });

  it('renders TOKEN_TABLE data inline where the token-viewer appears, not at the end', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Button</h1>
        <p>Button specs.</p>
        <h2>Design tokens</h2>
        <token-viewer display-token-sets="[&quot;Button - Common&quot;]">
          <token aria-label="Container color">
            <div class="display-name"><span class="display-name__text">Container color</span></div>
            <span class="text-value">md.comp.button.container.color</span>
            <div class="token-value-container">#6100ED</div>
          </token>
        </token-viewer>
        <h2>Usage</h2>
        <p>Usage guidelines follow.</p>
      </main>
    `, 'https://m3.material.io/components/buttons/specs', '2026-05-18T00:00:00.000Z', undefined, makeTokenSystem() as any);

    // Full TOKEN_TABLE columns should be present
    expect(page.markdown).toContain('| Token | Name | sys alias | ref alias | Light | Dark |');
    expect(page.markdown).toContain('md.comp.button.container.color');
    expect(page.markdown).toContain('md.sys.color.primary');

    // Token table appears BEFORE the Usage section (inline position)
    const tokenTableIndex = page.markdown.indexOf('| Token | Name');
    const usageIndex = page.markdown.indexOf('## Usage');
    expect(tokenTableIndex).toBeGreaterThan(0);
    expect(usageIndex).toBeGreaterThan(0);
    expect(tokenTableIndex).toBeLessThan(usageIndex);

    // No duplicate tables: simplified Name|Token|Value should not appear separately
    const tokenColHeaderCount = (page.markdown.match(/\| Token \|/g) ?? []).length;
    expect(tokenColHeaderCount).toBe(1);

    // No duplicate "Design Tokens" headings — the page's own <h2> and the token table should not both emit one
    const designTokensHeadingCount = (page.markdown.match(/^## Design [Tt]okens/gm) ?? []).length;
    expect(designTokensHeadingCount).toBe(1);
  });

  it('falls back to DOM extraction when no tokenSystem is provided', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Button</h1>
        <token-viewer display-token-sets="[&quot;Button - Common&quot;]">
          <token aria-label="Container color">
            <div class="display-name"><span class="display-name__text">Container color</span></div>
            <span class="text-value">md.comp.button.container.color</span>
            <div class="token-value-container">#6100ED</div>
          </token>
        </token-viewer>
      </main>
    `, 'https://m3.material.io/components/buttons/specs', '2026-05-18T00:00:00.000Z');

    // Without tokenSystem, falls back to DOM-extracted Name/Token/Value
    expect(page.markdown).toContain('| Name | Token | Value |');
    expect(page.markdown).toContain('Container color');
    expect(page.markdown).toContain('md.comp.button.container.color');
    // Full TOKEN_TABLE columns should NOT be present (no tokenSystem)
    expect(page.markdown).not.toContain('sys alias');
    expect(page.markdown).not.toContain('Light | Dark');
  });

  it('discovers token sets from picker button text when display-token-sets="[]"', () => {
    // Simulates component pages where token-viewer shows a picker UI with buttons
    // labelled by token set name. The button text contains the set name + icon names.
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Button</h1>
        <h2>Tokens and specs</h2>
        <token-viewer display-token-sets="[]">
          <button>Button - Common arrow_drop_down</button>
          <button>visibility</button>
          <button>grid_view</button>
          <button>expand_all</button>
          <button>Default, Light arrow_drop_down</button>
        </token-viewer>
      </main>
    `, 'https://m3.material.io/components/buttons/specs', '2026-05-18T00:00:00.000Z', undefined, makeTokenSystem() as any);

    // Token data should be extracted via button text discovery
    expect(page.markdown).toContain('| Token | Name | sys alias | ref alias | Light | Dark |');
    expect(page.markdown).toContain('md.comp.button.container.color');

    // The page h2 "Tokens and specs" should be the only heading in that area (no duplicate from tokenTableToMarkdown)
    const designTokensHeadingCount = (page.markdown.match(/^## (Tokens|Design [Tt]okens)/gm) ?? []).length;
    expect(designTokensHeadingCount).toBe(1);

    // No garbled UI noise should appear in the token section
    expect(page.markdown).not.toContain('visibility');
    expect(page.markdown).not.toContain('expand_all');
    expect(page.markdown).not.toContain('arrow_drop_down');
  });

  it('suppresses token-viewer picker noise when no tokenSystem is provided and viewer contains buttons', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Bottom Sheet</h1>
        <h2>Tokens and specs</h2>
        <token-viewer display-token-sets="[]">
          <button>Sheets - Bottom arrow_drop_down</button>
          <button>visibility</button>
          <button>expand_all</button>
        </token-viewer>
      </main>
    `, 'https://m3.material.io/components/bottom-sheets/specs', '2026-05-18T00:00:00.000Z');

    // Without tokenSystem, picker UI should be suppressed entirely (no garbled table)
    expect(page.markdown).not.toContain('visibility');
    expect(page.markdown).not.toContain('expand_all');
    expect(page.markdown).not.toContain('arrow_drop_down');
    expect(page.markdown).not.toContain('| Sheets');
    // Section heading is still present from the HTML
    expect(page.markdown).toContain('## Tokens and specs');
  });
});
