import { describe, expect, it } from 'vitest';
import { materialPageId, materialPagePath, normalizeMaterialUrl, sectionFromPagePath } from '../src/crawler-utils.js';

const baseUrl = 'https://m3.material.io';

describe('normalizeMaterialUrl', () => {
  it('keeps same-origin documentation URLs and removes hash, search, and trailing slash', () => {
    expect(normalizeMaterialUrl('/components/dialogs/overview/?foo=bar#usage', baseUrl)).toBe('https://m3.material.io/components/dialogs/overview');
  });

  it('resolves relative URLs against the Material origin rather than the current nested path', () => {
    expect(normalizeMaterialUrl('components/buttons', `${baseUrl}/components/dialogs/overview`)).toBe('https://m3.material.io/components/buttons');
  });

  it('resolves root-relative, query-only, and hash-only URLs against the same origin', () => {
    expect(normalizeMaterialUrl('/styles/color', `${baseUrl}/components/dialogs/overview`)).toBe('https://m3.material.io/styles/color');
    expect(normalizeMaterialUrl('?foo=bar', `${baseUrl}/components/dialogs/overview`)).toBe('https://m3.material.io/components/dialogs/overview');
    expect(normalizeMaterialUrl('#usage', `${baseUrl}/components/dialogs/overview`)).toBe('https://m3.material.io/components/dialogs/overview');
  });

  it('rejects external URLs and protocol-relative external URLs', () => {
    expect(normalizeMaterialUrl('https://example.com/components/dialogs', baseUrl)).toBeNull();
    expect(normalizeMaterialUrl('//example.com/components/dialogs', baseUrl)).toBeNull();
  });

  it('rejects downloadable and asset URLs only when the skipped extension is the final path extension', () => {
    expect(normalizeMaterialUrl('/assets/dialogs.png', baseUrl)).toBeNull();
    expect(normalizeMaterialUrl('/specs/dialogs.pdf', baseUrl)).toBeNull();
    expect(normalizeMaterialUrl('/components/json-viewer/overview', baseUrl)).toBe('https://m3.material.io/components/json-viewer/overview');
  });

  it('returns null for invalid URLs', () => {
    expect(normalizeMaterialUrl('http://[invalid', baseUrl)).toBeNull();
  });
});

describe('materialPagePath', () => {
  it('maps the site root to index markdown', () => {
    expect(materialPagePath('https://m3.material.io')).toBe('index.md');
  });

  it('maps nested documentation URLs to markdown paths and strips surrounding slashes', () => {
    expect(materialPagePath('https://m3.material.io/components/dialogs/overview')).toBe('components/dialogs/overview.md');
    expect(materialPagePath('https://m3.material.io//components/dialogs/overview//')).toBe('components/dialogs/overview.md');
  });
});

describe('sectionFromPagePath', () => {
  it('returns root for top-level pages', () => {
    expect(sectionFromPagePath('index.md')).toBe('root');
  });

  it('returns the parent path for nested pages and only strips a final markdown extension', () => {
    expect(sectionFromPagePath('components/dialogs/overview.md')).toBe('components/dialogs');
    expect(sectionFromPagePath('components/md.tokens/overview.md')).toBe('components/md.tokens');
  });
});

describe('materialPageId', () => {
  it('is deterministic and short enough for cache identifiers', () => {
    const first = materialPageId('https://m3.material.io/components/dialogs/overview');
    const second = materialPageId('https://m3.material.io/components/dialogs/overview');
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
  });

  it('changes when the source URL changes', () => {
    expect(materialPageId('https://m3.material.io/components/dialogs/overview')).not.toBe(materialPageId('https://m3.material.io/components/buttons/overview'));
  });
});
