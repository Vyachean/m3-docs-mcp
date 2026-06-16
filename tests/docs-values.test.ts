/**
 * Core docs value coverage verification.
 *
 * Verifies that the JSON extraction pipeline produces real token/spec/status
 * values for core Material 3 pages, not placeholder-only output.
 *
 * These tests use representative fixture payloads matching the structure of
 * real Material 3 JSON responses. They exercise the full extraction pipeline
 * (decode → render) without network access or Playwright.
 *
 * Run with: npm run verify:docs-values
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractContentPageToMaterialPage, type JsonExtractionResult } from '../src/json-extraction/extract-content-page.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/json-extraction', name), 'utf8'));

// ── Fixture helpers ───────────────────────────────────────────────────────────

const TOKEN_RESOURCE_NAME = 'designSystems/20543ce18892f7d9/components/6c818a16475113bd';
const STATUS_RESOURCE_NAME = 'designSystems/20543ce18892f7d9/components/31a0fe91b6f4e8d2';

// Synthetic token table resource matching Material 3 DSDB schema used for
// list and dialog spec pages (same structure as the button fixture).
const LIST_TOKEN_RESOURCE = {
  system: {
    tokens: [
      { name: 'ds/ts/tok1', tokenName: 'md.comp.list.item.container.color', displayName: 'Container color', tokenValueType: 'COLOR', state: 'ACTIVE' },
      { name: 'ds/ts/tok2', tokenName: 'md.comp.list.item.leading.icon.color', displayName: 'Leading icon color', tokenValueType: 'COLOR', state: 'ACTIVE' },
    ],
    tokenSets: [{ name: 'ds/ts', displayName: 'List - Common', tokenSetName: 'md.comp.list' }],
    tags: [
      { name: 'ds/tags/light', displayName: 'Light', tagName: 'light' },
      { name: 'ds/tags/dark', displayName: 'Dark', tagName: 'dark' },
    ],
    contextTagGroups: [],
    contextualReferenceTrees: {
      'ds/ts/tok1': {
        contextualReferenceTree: [
          { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.comp.list.item.container.color', childNodes: [{ tokenName: 'md.sys.color.surface', childNodes: [] }] }, resolvedValue: { color: { red: 1, green: 1, blue: 1 } } },
          { contextTags: ['ds/tags/dark'], referenceTree: { tokenName: 'md.comp.list.item.container.color', childNodes: [{ tokenName: 'md.sys.color.surface', childNodes: [] }] }, resolvedValue: { color: { red: 0.12, green: 0.12, blue: 0.12 } } },
        ],
      },
      'ds/ts/tok2': {
        contextualReferenceTree: [
          { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.comp.list.item.leading.icon.color', childNodes: [{ tokenName: 'md.sys.color.on-surface-variant', childNodes: [] }] }, resolvedValue: { color: { red: 0.28, green: 0.27, blue: 0.32 } } },
          { contextTags: ['ds/tags/dark'], referenceTree: { tokenName: 'md.comp.list.item.leading.icon.color', childNodes: [{ tokenName: 'md.sys.color.on-surface-variant', childNodes: [] }] }, resolvedValue: { color: { red: 0.74, green: 0.73, blue: 0.78 } } },
        ],
      },
    },
  },
};

const DIALOG_TOKEN_RESOURCE = {
  system: {
    tokens: [
      { name: 'ds/ts/tok1', tokenName: 'md.comp.dialog.container.color', displayName: 'Container color', tokenValueType: 'COLOR', state: 'ACTIVE' },
      { name: 'ds/ts/tok2', tokenName: 'md.comp.dialog.container.shape', displayName: 'Container shape', tokenValueType: 'SHAPE', state: 'ACTIVE' },
    ],
    tokenSets: [{ name: 'ds/ts', displayName: 'Dialog - Common', tokenSetName: 'md.comp.dialog' }],
    tags: [
      { name: 'ds/tags/light', displayName: 'Light', tagName: 'light' },
      { name: 'ds/tags/dark', displayName: 'Dark', tagName: 'dark' },
    ],
    contextTagGroups: [],
    contextualReferenceTrees: {
      'ds/ts/tok1': {
        contextualReferenceTree: [
          { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.comp.dialog.container.color', childNodes: [{ tokenName: 'md.sys.color.surface-container-high', childNodes: [] }] }, resolvedValue: { color: { red: 0.92, green: 0.91, blue: 0.95 } } },
          { contextTags: ['ds/tags/dark'], referenceTree: { tokenName: 'md.comp.dialog.container.color', childNodes: [{ tokenName: 'md.sys.color.surface-container-high', childNodes: [] }] }, resolvedValue: { color: { red: 0.17, green: 0.16, blue: 0.21 } } },
        ],
      },
      'ds/ts/tok2': {
        contextualReferenceTree: [
          { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.comp.dialog.container.shape', childNodes: [] }, resolvedValue: { shape: { family: 'ROUNDED', defaultSize: { value: 28, unit: 'DIPS' } } } },
          { contextTags: ['ds/tags/dark'], referenceTree: { tokenName: 'md.comp.dialog.container.shape', childNodes: [] }, resolvedValue: { shape: { family: 'ROUNDED', defaultSize: { value: 28, unit: 'DIPS' } } } },
        ],
      },
    },
  },
};

// Synthetic content pages representing the standard structure of Material 3 spec pages.
const BUTTON_SPECS_CONTENT = fixture('content-token-table.json');
const BUTTON_TOKEN_RESOURCE = fixture('token-table-resource.json');
const STATUS_RESOURCE = fixture('status-table-resource.json');

const LIST_SPECS_CONTENT = {
  title: 'List specs',
  sections: [{
    name: 'Tokens and specs',
    isVisible: true,
    contentBlocks: [{
      title: 'Design tokens',
      contentChunks: [{
        contentChunkType: 'RESOURCE',
        libraryModuleType: 'TOKEN_TABLE',
        resourceName: TOKEN_RESOURCE_NAME,
        moduleConfigurationOverrides: { tokenSets: ['List - Common'] },
      }],
    }],
  }],
};

const DIALOG_SPECS_CONTENT = {
  title: 'Dialog specs',
  sections: [{
    name: 'Tokens and specs',
    isVisible: true,
    contentBlocks: [{
      title: 'Design tokens',
      contentChunks: [{
        contentChunkType: 'RESOURCE',
        libraryModuleType: 'TOKEN_TABLE',
        resourceName: TOKEN_RESOURCE_NAME,
        moduleConfigurationOverrides: { tokenSets: ['Dialog - Common'] },
      }],
    }],
  }],
};

const COLOR_CONTENT = {
  title: 'Color',
  sections: [{
    name: 'Overview',
    isVisible: true,
    contentBlocks: [{
      title: null,
      contentChunks: [{
        contentChunkType: 'TEXT',
        htmlValue: '<p>Material You color system uses dynamic color to create harmonious color schemes. The color roles are primary, secondary, tertiary, and their corresponding containers.</p>',
      }],
    }],
  }, {
    name: 'Color roles',
    isVisible: true,
    contentBlocks: [{
      title: 'System roles',
      contentChunks: [{
        contentChunkType: 'TEXT',
        htmlValue: '<p>Primary: Used for key components and actions. Secondary: Used for less prominent components. Tertiary: Used for contrasting accents.</p>',
      }],
    }],
  }],
};

const TYPOGRAPHY_CONTENT = {
  title: 'Typography',
  sections: [{
    name: 'Overview',
    isVisible: true,
    contentBlocks: [{
      title: null,
      contentChunks: [{
        contentChunkType: 'TEXT',
        htmlValue: '<p>Material You typography system uses type scale with semantic roles: Display, Headline, Title, Body, and Label sizes from Large to Small.</p>',
      }],
    }],
  }, {
    name: 'Type scale',
    isVisible: true,
    contentBlocks: [{
      title: 'Display',
      contentChunks: [{
        contentChunkType: 'TEXT',
        htmlValue: '<p>Display Large: 57sp. Display Medium: 45sp. Display Small: 36sp.</p>',
      }],
    }],
  }],
};

const FOUNDATIONS_OVERVIEW_CONTENT = {
  title: 'Foundations Overview',
  sections: [{
    name: 'Design foundations',
    isVisible: true,
    contentBlocks: [{
      title: null,
      contentChunks: [{
        contentChunkType: 'TEXT',
        htmlValue: '<p>Material 3 design foundations include color, typography, elevation, shape, icons, and motion. Together these foundations create cohesive and accessible user interfaces.</p>',
      }],
    }],
  }],
};

// ── Verification helpers ──────────────────────────────────────────────────────

const PLACEHOLDER_PATTERN = /Material resource placeholder:/;

function countPlaceholders(markdown: string): number {
  return (markdown.match(/Material resource placeholder:/g) ?? []).length;
}

function assertRealValues(result: JsonExtractionResult, description: string): void {
  const { page, pageDiagnostic } = result;

  expect(page.title, `${description}: page title must be present`).toBeTruthy();
  expect(page.markdown.length, `${description}: markdown must be non-empty`).toBeGreaterThan(100);

  const placeholders = countPlaceholders(page.markdown);
  expect(
    placeholders,
    `${description}: too many placeholders (${placeholders}) — real values expected`,
  ).toBe(0);

  if (pageDiagnostic.tokenTables > 0) {
    expect(
      pageDiagnostic.tokenTablesRendered,
      `${description}: token tables must render, not fall back to placeholder`,
    ).toBe(pageDiagnostic.tokenTables);
  }

  if ((pageDiagnostic.statusTablesRequested ?? 0) > 0) {
    expect(
      pageDiagnostic.statusTablesRenderedAsPlaceholder ?? 0,
      `${description}: status tables must not render as placeholder`,
    ).toBe(0);
  }

  expect(
    pageDiagnostic.unsupportedStatusTableSchemaCount ?? 0,
    `${description}: unsupported status table schema count must be 0 for core docs`,
  ).toBe(0);
}

// ── Core spec page tests ──────────────────────────────────────────────────────

describe('core docs value coverage – /components/button/specs', () => {
  it('extracts page title', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/button/specs',
      pageData: null,
      contentPage: BUTTON_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? BUTTON_TOKEN_RESOURCE : null,
    });
    expect(result.page.title).toBeTruthy();
  });

  it('renders token table with real token names', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/button/specs',
      pageData: null,
      contentPage: BUTTON_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? BUTTON_TOKEN_RESOURCE : null,
    });
    expect(result.page.markdown).toContain('md.comp.button.container.color');
    expect(result.page.markdown).toContain('| Token | Name');
  });

  it('renders token table with real resolved values (not placeholder)', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/button/specs',
      pageData: null,
      contentPage: BUTTON_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? BUTTON_TOKEN_RESOURCE : null,
    });
    expect(result.page.markdown).toContain('md.sys.color.primary');
    expect(result.page.markdown).not.toMatch(PLACEHOLDER_PATTERN);
  });

  it('shows alias chain in token table (sys → ref)', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/button/specs',
      pageData: null,
      contentPage: BUTTON_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? BUTTON_TOKEN_RESOURCE : null,
    });
    expect(result.page.markdown).toContain('md.ref.palette.primary40');
  });

  it('passes assertRealValues', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/button/specs',
      pageData: null,
      contentPage: BUTTON_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? BUTTON_TOKEN_RESOURCE : null,
    });
    assertRealValues(result, '/components/button/specs');
  });
});

describe('core docs value coverage – /components/list/specs', () => {
  it('extracts page title', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/list/specs',
      pageData: null,
      contentPage: LIST_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? LIST_TOKEN_RESOURCE : null,
    });
    expect(result.page.title).toBe('List specs');
  });

  it('renders list token names', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/list/specs',
      pageData: null,
      contentPage: LIST_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? LIST_TOKEN_RESOURCE : null,
    });
    expect(result.page.markdown).toContain('md.comp.list.item.container.color');
    expect(result.page.markdown).toContain('md.comp.list.item.leading.icon.color');
  });

  it('renders resolved color values (not placeholder)', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/list/specs',
      pageData: null,
      contentPage: LIST_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? LIST_TOKEN_RESOURCE : null,
    });
    expect(result.page.markdown).toMatch(/#[0-9a-f]{6}/i);
    expect(result.page.markdown).not.toMatch(PLACEHOLDER_PATTERN);
  });

  it('passes assertRealValues', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/list/specs',
      pageData: null,
      contentPage: LIST_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? LIST_TOKEN_RESOURCE : null,
    });
    assertRealValues(result, '/components/list/specs');
  });
});

describe('core docs value coverage – /components/dialog/specs', () => {
  it('extracts page title', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/dialog/specs',
      pageData: null,
      contentPage: DIALOG_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? DIALOG_TOKEN_RESOURCE : null,
    });
    expect(result.page.title).toBe('Dialog specs');
  });

  it('renders dialog token names and shape values', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/dialog/specs',
      pageData: null,
      contentPage: DIALOG_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? DIALOG_TOKEN_RESOURCE : null,
    });
    expect(result.page.markdown).toContain('md.comp.dialog.container.color');
    expect(result.page.markdown).toContain('md.comp.dialog.container.shape');
  });

  it('renders resolved values (not placeholder)', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/dialog/specs',
      pageData: null,
      contentPage: DIALOG_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? DIALOG_TOKEN_RESOURCE : null,
    });
    expect(result.page.markdown).not.toMatch(PLACEHOLDER_PATTERN);
  });

  it('passes assertRealValues', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/dialog/specs',
      pageData: null,
      contentPage: DIALOG_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? DIALOG_TOKEN_RESOURCE : null,
    });
    assertRealValues(result, '/components/dialog/specs');
  });
});

describe('core docs value coverage – /styles/color', () => {
  it('extracts page title', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/styles/color',
      pageData: null,
      contentPage: COLOR_CONTENT,
      fetchResource: async () => null,
    });
    expect(result.page.title).toBe('Color');
  });

  it('renders color overview sections', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/styles/color',
      pageData: null,
      contentPage: COLOR_CONTENT,
      fetchResource: async () => null,
    });
    expect(result.page.markdown).toContain('Material You color system');
    expect(result.page.markdown).toContain('## Overview');
  });

  it('renders color role descriptions', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/styles/color',
      pageData: null,
      contentPage: COLOR_CONTENT,
      fetchResource: async () => null,
    });
    expect(result.page.markdown).toContain('Primary');
    expect(result.page.markdown).toContain('Secondary');
  });

  it('produces no placeholders (no resource chunks on text-only page)', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/styles/color',
      pageData: null,
      contentPage: COLOR_CONTENT,
      fetchResource: async () => null,
    });
    expect(countPlaceholders(result.page.markdown)).toBe(0);
  });
});

describe('core docs value coverage – /styles/typography', () => {
  it('extracts page title', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/styles/typography',
      pageData: null,
      contentPage: TYPOGRAPHY_CONTENT,
      fetchResource: async () => null,
    });
    expect(result.page.title).toBe('Typography');
  });

  it('renders type scale information', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/styles/typography',
      pageData: null,
      contentPage: TYPOGRAPHY_CONTENT,
      fetchResource: async () => null,
    });
    expect(result.page.markdown).toContain('Display');
    expect(result.page.markdown).toContain('57sp');
  });

  it('produces no placeholders', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/styles/typography',
      pageData: null,
      contentPage: TYPOGRAPHY_CONTENT,
      fetchResource: async () => null,
    });
    expect(countPlaceholders(result.page.markdown)).toBe(0);
  });
});

describe('core docs value coverage – /foundations/overview', () => {
  it('extracts page title', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/overview',
      pageData: null,
      contentPage: FOUNDATIONS_OVERVIEW_CONTENT,
      fetchResource: async () => null,
    });
    expect(result.page.title).toBe('Foundations Overview');
  });

  it('renders foundations overview text', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/overview',
      pageData: null,
      contentPage: FOUNDATIONS_OVERVIEW_CONTENT,
      fetchResource: async () => null,
    });
    expect(result.page.markdown).toContain('color');
    expect(result.page.markdown).toContain('typography');
    expect(result.page.markdown).toContain('elevation');
  });

  it('produces no placeholders', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/overview',
      pageData: null,
      contentPage: FOUNDATIONS_OVERVIEW_CONTENT,
      fetchResource: async () => null,
    });
    expect(countPlaceholders(result.page.markdown)).toBe(0);
  });
});

describe('core docs value coverage – status/spec values', () => {
  it('renders status table with state descriptions (not placeholder)', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/status/overview',
      pageData: null,
      contentPage: fixture('content-status-table.json'),
      fetchResource: async (_, type) => (type === 'STATUS_TABLE' ? STATUS_RESOURCE : null),
    });
    expect(result.page.markdown).toContain('| State | Description |');
    expect(result.page.markdown).toContain('| Enabled | Default interactive state |');
    expect(result.page.markdown).toContain('| Disabled |');
    expect(countPlaceholders(result.page.markdown)).toBe(0);
  });

  it('status table diagnostics confirm resolved and rendered', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/status/overview',
      pageData: null,
      contentPage: fixture('content-status-table.json'),
      fetchResource: async (_, type) => (type === 'STATUS_TABLE' ? STATUS_RESOURCE : null),
    });
    expect(result.pageDiagnostic.statusTablesResolved).toBe(1);
    expect(result.pageDiagnostic.statusTablesRenderedAsPlaceholder ?? 0).toBe(0);
    expect(result.pageDiagnostic.unsupportedStatusTableSchemaCount ?? 0).toBe(0);
  });
});

describe('placeholder threshold guard – extraction pipeline must not resolve-then-placeholder', () => {
  it('fails when a core spec page resolves a token table resource but renders placeholder', async () => {
    const badResource = { payload: { unexpected_structure: true } };
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/button/specs',
      pageData: null,
      contentPage: BUTTON_SPECS_CONTENT,
      fetchResource: async (name, type) =>
        type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? badResource : null,
    });
    // The pipeline should produce a placeholder — this test confirms the guard detects it
    expect(countPlaceholders(result.page.markdown)).toBeGreaterThan(0);
    // And that the diagnostic records the failure
    expect(result.pageDiagnostic.tokenTablesRendered).toBe(0);
    expect(result.pageDiagnostic.unresolvedResourceCount).toBeGreaterThan(0);
  });

  it('counter: tokenTables > tokenTablesRendered is suspicious', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/button/specs',
      pageData: null,
      contentPage: BUTTON_SPECS_CONTENT,
      fetchResource: async () => null,
    });
    // When resource is missing, tokenTables increments but tokenTablesRendered stays 0
    expect(result.pageDiagnostic.tokenTables).toBe(1);
    expect(result.pageDiagnostic.tokenTablesRendered).toBe(0);
    expect(result.pageDiagnostic.unresolvedResourceCount).toBeGreaterThan(0);
  });
});
