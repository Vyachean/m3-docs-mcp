import { describe, expect, it } from 'vitest';
import { extractMaterialPageFromHtml } from '../src/crawler.js';

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
});
