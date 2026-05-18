import { describe, expect, it } from 'vitest';
import { materialPageId, materialPagePath, normalizeMaterialUrl, sectionFromPagePath } from '../src/crawler-utils.js';

const baseUrl = 'https://m3.material.io';

describe('normalizeMaterialUrl', () => {
  it('keeps same-origin documentation URLs and removes hash, search, and trailing slash', () => {
    expect(normalizeMaterialUrl('/components/dialogs/overview/?foo=bar#usage', baseUrl)).toBe('https://m3.material.io/components/dialogs/overview');
  });

  it('resolves relative URLs against the Material base URL', () => {
    expect(normalizeMaterialUrl('components/buttons', `${baseUrl}/components/dialogs/overview`)).toBe('https://m3.material.io/components/buttons');
  });

  it('rejects external URLs', () => {
    expect(normalizeMaterialUrl('https://example.com/components/dialogs', baseUrl)).toBeNull();
  });

  it('rejects downloadable and asset URLs', () => {
    expect(normalizeMaterialUrl('/assets/dialogs.png', baseUrl)).toBeNull();
    expect(normalizeMaterialUrl('/specs/dialogs.pdf', baseUrl)).toBeNull();
  });

  it('returns null for invalid URLs', () => {
    expect(normalizeMaterialUrl('http://[invalid', baseUrl)).toBeNull();
  });
});

describe('materialPagePath', () => {
  it('maps the site root to index markdown', () => {
    expect(materialPagePath('https://m3.material.io')).toBe('index.md');
  });

  it('maps nested documentation URLs to markdown paths', () => {
    expect(materialPagePath('https://m3.material.io/components/dialogs/overview')).toBe('components/dialogs/overview.md');
  });
});

describe('sectionFromPagePath', () => {
  it('returns root for top-level pages', () => {
    expect(sectionFromPagePath('index.md')).toBe('root');
  });

  it('returns the parent path for nested pages', () => {
    expect(sectionFromPagePath('components/dialogs/overview.md')).toBe('components/dialogs');
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
