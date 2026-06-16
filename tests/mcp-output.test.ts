/**
 * MCP-level output tests for agent-visible content.
 *
 * These tests verify that search and get operations return real Material 3
 * token/spec/status values — not placeholder-only output — as agents would
 * receive them through the MCP protocol.
 *
 * Tests use the full extraction pipeline on representative fixture payloads.
 * This matches exactly what agents see: the markdown stored in the cache is
 * produced by the same extractContentPageToMaterialPage function exercised here.
 */
import MiniSearch from 'minisearch';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractContentPageToMaterialPage } from '../src/json-extraction/extract-content-page.js';
import { stripMarkdown } from '../src/json-extraction/render-markdown.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/json-extraction', name), 'utf8'));

// ── Page content fixtures ─────────────────────────────────────────────────────

const TOKEN_RESOURCE_NAME = 'designSystems/20543ce18892f7d9/components/6c818a16475113bd';
const STATUS_RESOURCE_NAME = 'designSystems/20543ce18892f7d9/components/31a0fe91b6f4e8d2';

const LIST_TOKEN_RESOURCE = {
  system: {
    tokens: [
      { name: 'ds/ts/tok1', tokenName: 'md.comp.list.item.container.color', displayName: 'Container color', tokenValueType: 'COLOR', state: 'ACTIVE' },
      { name: 'ds/ts/tok2', tokenName: 'md.comp.list.item.trailing.icon.color', displayName: 'Trailing icon color', tokenValueType: 'COLOR', state: 'ACTIVE' },
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
          { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.comp.list.item.trailing.icon.color', childNodes: [{ tokenName: 'md.sys.color.on-surface-variant', childNodes: [] }] }, resolvedValue: { color: { red: 0.28, green: 0.27, blue: 0.32 } } },
          { contextTags: ['ds/tags/dark'], referenceTree: { tokenName: 'md.comp.list.item.trailing.icon.color', childNodes: [{ tokenName: 'md.sys.color.on-surface-variant', childNodes: [] }] }, resolvedValue: { color: { red: 0.74, green: 0.73, blue: 0.78 } } },
        ],
      },
    },
  },
};

const DIALOG_TOKEN_RESOURCE = {
  system: {
    tokens: [
      { name: 'ds/ts/tok1', tokenName: 'md.comp.dialog.container.color', displayName: 'Container color', tokenValueType: 'COLOR', state: 'ACTIVE' },
      { name: 'ds/ts/tok2', tokenName: 'md.comp.dialog.headline.color', displayName: 'Headline color', tokenValueType: 'COLOR', state: 'ACTIVE' },
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
          { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.comp.dialog.headline.color', childNodes: [{ tokenName: 'md.sys.color.on-surface', childNodes: [] }] }, resolvedValue: { color: { red: 0.11, green: 0.1, blue: 0.15 } } },
          { contextTags: ['ds/tags/dark'], referenceTree: { tokenName: 'md.comp.dialog.headline.color', childNodes: [{ tokenName: 'md.sys.color.on-surface', childNodes: [] }] }, resolvedValue: { color: { red: 0.9, green: 0.9, blue: 0.95 } } },
        ],
      },
    },
  },
};

// ── In-memory page store ──────────────────────────────────────────────────────

type PageRecord = {
  id: string;
  title: string;
  url: string;
  path: string;
  section: string;
  markdown: string;
};

type SearchDoc = PageRecord & { headings: string; body: string };

const pages: PageRecord[] = [];
let search: MiniSearch<SearchDoc>;

async function buildPage(url: string, contentPage: unknown, fetchResource: (name: string, type?: string) => Promise<unknown>): Promise<PageRecord> {
  const result = await extractContentPageToMaterialPage({
    url,
    pageData: null,
    contentPage,
    fetchResource,
  });
  const { page } = result;
  return {
    id: page.id,
    title: page.title,
    url: page.url,
    path: page.path,
    section: page.section,
    markdown: page.markdown,
  };
}

// Build an in-memory page store and search index before all tests run.
beforeAll(async () => {
  const buttonPage = await buildPage(
    'https://m3.material.io/components/button/specs',
    fixture('content-token-table.json'),
    async (name, type) => type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? fixture('token-table-resource.json') : null,
  );

  const listPage = await buildPage(
    'https://m3.material.io/components/list/specs',
    {
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
    },
    async (name, type) => type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? LIST_TOKEN_RESOURCE : null,
  );

  const dialogPage = await buildPage(
    'https://m3.material.io/components/dialog/specs',
    {
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
    },
    async (name, type) => type === 'TOKEN_TABLE' && name === TOKEN_RESOURCE_NAME ? DIALOG_TOKEN_RESOURCE : null,
  );

  const statusPage = await buildPage(
    'https://m3.material.io/components/status/overview',
    fixture('content-status-table.json'),
    async (_, type) => type === 'STATUS_TABLE' ? fixture('status-table-resource.json') : null,
  );

  pages.push(buttonPage, listPage, dialogPage, statusPage);

  const docs: SearchDoc[] = pages.map((p) => ({
    ...p,
    headings: p.title,
    body: stripMarkdown(p.markdown.replace(/^---[\s\S]*?---/, '')).slice(0, 30000),
  }));

  search = new MiniSearch<SearchDoc>({
    fields: ['title', 'section', 'headings', 'body'],
    storeFields: ['title', 'url', 'path', 'section', 'headings', 'body'],
  });
  search.addAll(docs);
});

// ── Search tests ──────────────────────────────────────────────────────────────

describe('MCP search – agent-visible results', () => {
  it('search "button tokens" returns button specs page', () => {
    const results = search.search('button tokens', { prefix: true, fuzzy: 0.2 });
    expect(results.length).toBeGreaterThan(0);
    const first = results[0]!;
    expect(first.path).toContain('components/button');
  });

  it('search "button tokens" result includes real token data', () => {
    const results = search.search('button tokens', { prefix: true, fuzzy: 0.2 });
    const body = String(results[0]?.body ?? '');
    expect(body).toContain('md.comp.button');
  });

  it('search "list specs" returns list specs page', () => {
    const results = search.search('list specs', { prefix: true, fuzzy: 0.2 });
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => String(r.path));
    expect(paths.some((p) => p.includes('list'))).toBe(true);
  });

  it('search "dialog" returns dialog specs page', () => {
    const results = search.search('dialog', { prefix: true, fuzzy: 0.2 });
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => String(r.path));
    expect(paths.some((p) => p.includes('dialog'))).toBe(true);
  });
});

// ── Get page content tests (agent-visible markdown) ───────────────────────────

describe('MCP get – /components/button/specs agent-visible output', () => {
  it('page exists and has title', () => {
    const page = pages.find((p) => p.path.includes('components/button'));
    expect(page).toBeDefined();
    expect(page!.title).toBeTruthy();
  });

  it('includes real token names (md.comp.button.*)', () => {
    const page = pages.find((p) => p.path.includes('components/button'))!;
    expect(page.markdown).toContain('md.comp.button.container.color');
  });

  it('includes real resolved values (color hex or alias)', () => {
    const page = pages.find((p) => p.path.includes('components/button'))!;
    // Token values appear as sys aliases (e.g. md.sys.color.primary) or hex colors
    const hasSysAlias = page.markdown.includes('md.sys.color.primary');
    const hasHex = /\|[^|]*#[0-9a-f]{6}[^|]*\|/i.test(page.markdown);
    expect(hasSysAlias || hasHex).toBe(true);
  });

  it('does not return placeholder-only output', () => {
    const page = pages.find((p) => p.path.includes('components/button'))!;
    expect(page.markdown).not.toContain('Material resource placeholder:');
  });

  it('markdown contains table header row', () => {
    const page = pages.find((p) => p.path.includes('components/button'))!;
    expect(page.markdown).toContain('| Token | Name');
  });
});

describe('MCP get – /components/list/specs agent-visible output', () => {
  it('page exists and has title', () => {
    const page = pages.find((p) => p.path.includes('components/list'));
    expect(page).toBeDefined();
    expect(page!.title).toBeTruthy();
  });

  it('includes real list token names', () => {
    const page = pages.find((p) => p.path.includes('components/list'))!;
    expect(page.markdown).toContain('md.comp.list.item.container.color');
  });

  it('includes resolved color values', () => {
    const page = pages.find((p) => p.path.includes('components/list'))!;
    expect(page.markdown).toMatch(/#[0-9a-f]{6}/i);
  });

  it('does not return placeholder-only output', () => {
    const page = pages.find((p) => p.path.includes('components/list'))!;
    expect(page.markdown).not.toContain('Material resource placeholder:');
  });
});

describe('MCP get – /components/dialog/specs agent-visible output', () => {
  it('page exists and has title', () => {
    const page = pages.find((p) => p.path.includes('components/dialog'));
    expect(page).toBeDefined();
    expect(page!.title).toBeTruthy();
  });

  it('includes real dialog token names', () => {
    const page = pages.find((p) => p.path.includes('components/dialog'))!;
    expect(page.markdown).toContain('md.comp.dialog.container.color');
    expect(page.markdown).toContain('md.comp.dialog.headline.color');
  });

  it('does not return placeholder-only output', () => {
    const page = pages.find((p) => p.path.includes('components/dialog'))!;
    expect(page.markdown).not.toContain('Material resource placeholder:');
  });
});

describe('MCP get – status table agent-visible output', () => {
  it('page exists with status section', () => {
    const page = pages.find((p) => p.path.includes('status'));
    expect(page).toBeDefined();
  });

  it('includes state names and descriptions (real values)', () => {
    const page = pages.find((p) => p.path.includes('status'))!;
    expect(page.markdown).toContain('Enabled');
    expect(page.markdown).toContain('Disabled');
  });

  it('includes table headers from status table', () => {
    const page = pages.find((p) => p.path.includes('status'))!;
    expect(page.markdown).toContain('| State | Description |');
  });

  it('does not return placeholder-only output for status table', () => {
    const page = pages.find((p) => p.path.includes('status'))!;
    expect(page.markdown).not.toContain('Material resource placeholder:');
  });
});
