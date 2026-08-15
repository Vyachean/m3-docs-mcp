import { describe, expect, it } from 'vitest';
import {
  materialPageId,
  materialPagePath,
  normalizeMaterialPublicDocPath,
  normalizeMaterialUrl,
  sectionFromPagePath
} from '../src/crawler-utils.js';

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

  it('rejects each downloadable/asset extension only when it is the final path extension', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'pdf', 'zip', 'xml', 'json', 'txt']) {
      expect(normalizeMaterialUrl(`/assets/file.${extension}`, baseUrl)).toBeNull();
      expect(normalizeMaterialUrl(`/assets/file.${extension.toUpperCase()}`, baseUrl)).toBeNull();
    }
    expect(normalizeMaterialUrl('/components/json-viewer/overview', baseUrl)).toBe('https://m3.material.io/components/json-viewer/overview');
    expect(normalizeMaterialUrl('/components/file.json/overview', baseUrl)).toBe('https://m3.material.io/components/file.json/overview');
  });

  it('returns null for invalid URLs', () => {
    expect(normalizeMaterialUrl('http://[invalid', baseUrl)).toBeNull();
  });
});

describe('normalizeMaterialPublicDocPath', () => {
  it('normalizes duplicate and trailing slashes while keeping documentation paths', () => {
    expect(normalizeMaterialPublicDocPath('/components//buttons/overview/', baseUrl)).toBe('/components/buttons/overview');
    expect(normalizeMaterialPublicDocPath('styles/color/roles', `${baseUrl}/components/buttons`)).toBe('/styles/color/roles');
    expect(normalizeMaterialPublicDocPath('/', baseUrl)).toBe('/');
  });

  it('rejects all known non-document path prefixes', () => {
    const rejected = [
      '/assets/icon',
      '/static/chunk',
      '/_dsm/data/page',
      '/m3/pages/internal',
      '/favicon',
      '/favicon-anything',
      '/manifest',
      '/manifest-anything',
      '/robots.txt',
      '/robots.txt-extra',
      '/sitemap',
      '/sitemap-index'
    ];
    for (const path of rejected) expect(normalizeMaterialPublicDocPath(path, baseUrl)).toBeNull();
  });

  it('does not reject documentation paths that merely contain a reserved word later in the path', () => {
    expect(normalizeMaterialPublicDocPath('/components/assets/overview', baseUrl)).toBe('/components/assets/overview');
    expect(normalizeMaterialPublicDocPath('/foundations/manifest/overview', baseUrl)).toBe('/foundations/manifest/overview');
  });

  it('preserves URL rejection from normalizeMaterialUrl', () => {
    expect(normalizeMaterialPublicDocPath('https://example.com/components/buttons', baseUrl)).toBeNull();
    expect(normalizeMaterialPublicDocPath('/assets/icon.svg', baseUrl)).toBeNull();
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
