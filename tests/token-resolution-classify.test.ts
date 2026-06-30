/**
 * Tests for token value resolution classification and the formatValueNode improvements
 * added by the fix/token-value-resolution-completeness branch.
 *
 * Coverage:
 * - resolved alias chain (happy path)
 * - missing-context-entry: entries exist but no entry matches the requested selector (light/dark/high-contrast)
 * - upstream-empty: resolvedValue.undefined === true
 * - upstream-empty: empty context tree
 * - unsupported-value-type: non-empty resolvedValue that formats to ''
 * - missing-alias-target: reserved future category — counted when present in graph, not emitted by classifier
 * - parser-bug: reserved future category — currently always zero
 * - shape tokens now resolve (formatValueNode improvement)
 * - typography tokens now resolve (formatValueNode improvement)
 * - values-array wrapper tokens now resolve (formatValueNode improvement)
 * - buildTokenResolutionSummary.unresolvedByReason counts cells by reason
 * - examples include unresolvedReason
 * - all remaining unresolved examples carry a non-undefined unresolvedReason
 */

import { describe, expect, it } from 'vitest';
import { buildTokenTableNode } from '../src/graph/token-table-graph.js';
import { buildTokenResolutionSummary } from '../src/diagnostics/token-resolution-summary.js';
import type { DecodedTokenTableSystem } from '../src/json-extraction/schemas.js';
import type { TokenTableGraph } from '../src/graph/graph-types.js';

// ── Fixture helpers ────────────────────────────────────────────────────────────

const LIGHT_TAG = 'ds/tags/light';
const DARK_TAG = 'ds/tags/dark';
const AUDIENCE_3P_TAG = 'ds/tags/3p';
const HIGH_CONTRAST_TAG = 'ds/tags/hc';

function baseTags() {
  return [
    { name: LIGHT_TAG, displayName: 'Light', tagName: 'light' },
    { name: DARK_TAG, displayName: 'Dark', tagName: 'dark' },
    { name: AUDIENCE_3P_TAG, displayName: '3P', tagName: '3p' },
    { name: HIGH_CONTRAST_TAG, displayName: 'HC', tagName: 'high.contrast' },
  ];
}

function baseSystem(overrides: Partial<DecodedTokenTableSystem> = {}): DecodedTokenTableSystem {
  return {
    tokens: [],
    tokenSets: [],
    tags: baseTags(),
    contextTagGroups: [],
    contextualReferenceTrees: {},
    ...overrides,
  };
}

function oneTokenSystem(tokenName: string, resolvedValue: Record<string, unknown>, contextTags: string[] = [LIGHT_TAG, AUDIENCE_3P_TAG]): DecodedTokenTableSystem {
  const fullTokenName = `ds/tokenSets/ts1/tokens/${tokenName}`;
  return baseSystem({
    tokens: [{
      name: fullTokenName,
      tokenName,
      displayName: tokenName,
      tokenValueType: 'COLOR',
      state: 'ACTIVE',
    }],
    tokenSets: [{ name: 'ds/tokenSets/ts1', displayName: 'Test Set', tokenSetName: 'md.test' }],
    contextualReferenceTrees: {
      [fullTokenName]: {
        contextualReferenceTree: [
          {
            contextTags,
            referenceTree: { tokenName, childNodes: [] },
            resolvedValue,
          },
        ],
      },
    },
  });
}

function emptyTreeSystem(tokenName: string): DecodedTokenTableSystem {
  const fullTokenName = `ds/tokenSets/ts1/tokens/${tokenName}`;
  return baseSystem({
    tokens: [{
      name: fullTokenName,
      tokenName,
      displayName: tokenName,
      tokenValueType: 'COLOR',
      state: 'ACTIVE',
    }],
    tokenSets: [{ name: 'ds/tokenSets/ts1', displayName: 'Test Set', tokenSetName: 'md.test' }],
    contextualReferenceTrees: {
      [fullTokenName]: { contextualReferenceTree: [] },
    },
  });
}

function noTreeSystem(tokenName: string): DecodedTokenTableSystem {
  const fullTokenName = `ds/tokenSets/ts1/tokens/${tokenName}`;
  return baseSystem({
    tokens: [{
      name: fullTokenName,
      tokenName,
      displayName: tokenName,
      tokenValueType: 'COLOR',
      state: 'ACTIVE',
    }],
    tokenSets: [{ name: 'ds/tokenSets/ts1', displayName: 'Test Set', tokenSetName: 'md.test' }],
    contextualReferenceTrees: {},
  });
}

function buildNode(system: DecodedTokenTableSystem, requestedTokenSets: string[] = ['Test Set']) {
  return buildTokenTableNode({
    resourceId: 'token-table:test',
    resourceName: 'md.test',
    system,
    requestedTokenSets,
    routes: ['/test/specs'],
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('buildTokenTableNode: resolved alias chain', () => {
  it('resolves a color value with light/dark entries', () => {
    const system = baseSystem({
      tokens: [{
        name: 'ds/tokenSets/ts1/tokens/md.comp.button.color',
        tokenName: 'md.comp.button.color',
        displayName: 'Button color',
        tokenValueType: 'COLOR',
        state: 'ACTIVE',
      }],
      tokenSets: [{ name: 'ds/tokenSets/ts1', displayName: 'Test Set', tokenSetName: 'md.test' }],
      contextualReferenceTrees: {
        'ds/tokenSets/ts1/tokens/md.comp.button.color': {
          contextualReferenceTree: [
            {
              contextTags: [LIGHT_TAG, AUDIENCE_3P_TAG],
              referenceTree: {
                tokenName: 'md.comp.button.color',
                childNodes: [{ tokenName: 'md.sys.color.primary', childNodes: [{ tokenName: 'md.ref.palette.primary40', childNodes: [] }] }],
              },
              resolvedValue: { color: { red: 0.38, green: 0.0, blue: 0.93, alpha: 1 } },
            },
            {
              contextTags: [DARK_TAG, AUDIENCE_3P_TAG],
              referenceTree: {
                tokenName: 'md.comp.button.color',
                childNodes: [{ tokenName: 'md.sys.color.primary', childNodes: [{ tokenName: 'md.ref.palette.primary80', childNodes: [] }] }],
              },
              resolvedValue: { color: { red: 0.82, green: 0.68, blue: 1, alpha: 1 } },
            },
          ],
        },
      },
    });

    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;

    expect(token.aliases).toContain('md.sys.color.primary');
    const light = token.values.find((v) => v.role === 'light')!;
    const dark = token.values.find((v) => v.role === 'dark')!;

    expect(light.resolved).toBe(true);
    expect(light.value).toMatch(/^#[0-9a-f]{6}$/i);
    expect(light.unresolvedReason).toBeUndefined();

    expect(dark.resolved).toBe(true);
    expect(dark.value).toMatch(/^#[0-9a-f]{6}$/i);
    expect(dark.unresolvedReason).toBeUndefined();
  });
});

describe('buildTokenTableNode: unresolved reason classification', () => {
  it('classifies as upstream-empty when contextualReferenceTree is empty', () => {
    const node = buildNode(emptyTreeSystem('md.comp.foo'));
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(false);
    expect(light.value).toBeNull();
    expect(light.unresolvedReason).toBe('upstream-empty');
  });

  it('classifies as upstream-empty when token has no contextualReferenceTree entry', () => {
    const node = buildNode(noTreeSystem('md.comp.foo'));
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(false);
    expect(light.unresolvedReason).toBe('upstream-empty');
  });

  it('classifies as upstream-empty when resolvedValue has undefined===true', () => {
    const system = oneTokenSystem('md.comp.foo', { undefined: true });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(false);
    expect(light.unresolvedReason).toBe('upstream-empty');
  });

  it('classifies as upstream-empty when resolvedValue is empty {}', () => {
    const system = oneTokenSystem('md.comp.foo', {});
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(false);
    expect(light.unresolvedReason).toBe('upstream-empty');
  });

  it('classifies as missing-context-entry when context entries exist but no entry matches the selector', () => {
    // Provide only a dark entry but ask for light — light context entry won't be found
    // because the entry only has DARK_TAG and AUDIENCE_3P_TAG
    const system = oneTokenSystem('md.comp.foo', { color: { red: 0.5, green: 0.5, blue: 0.5, alpha: 1 } }, [DARK_TAG, AUDIENCE_3P_TAG]);
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;
    const dark = token.values.find((v) => v.role === 'dark')!;

    // Dark should resolve (has matching entry)
    expect(dark.resolved).toBe(true);
    // Light should fail with missing-context-entry (entries exist, but none match light selector)
    expect(light.resolved).toBe(false);
    expect(light.unresolvedReason).toBe('missing-context-entry');
  });

  it('classifies as unsupported-value-type when resolvedValue has keys but formats to empty', () => {
    // An object structure with unknown keys that formatValueNode cannot handle
    const unknownStructure = { someUnknownValueType: { x: 1, y: 2 } };
    const system = oneTokenSystem('md.comp.foo', unknownStructure);
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(false);
    expect(light.unresolvedReason).toBe('unsupported-value-type');
  });
});

describe('buildTokenTableNode: fixed value types (parser-bug fixes)', () => {
  it('resolves shape tokens (family, defaultSize, corners)', () => {
    const shapeValue = {
      shape: {
        family: 'ROUNDED',
        defaultSize: { unit: 'DIPS', value: 16 },
        corners: [{ unit: 'DIPS', value: 4 }, { unit: 'DIPS', value: 4 }, { unit: 'DIPS', value: 4 }, { unit: 'DIPS', value: 4 }],
      },
    };
    const system = oneTokenSystem('md.comp.button.shape', shapeValue);
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).not.toBeNull();
    expect(light.value).toContain('ROUNDED');
    expect(light.unresolvedReason).toBeUndefined();
  });

  it('resolves typography tokens (fontNames, fontWeight, fontSize)', () => {
    const typographyValue = {
      typography: {
        fontNames: ['Roboto'],
        fontWeight: 500,
        fontSize: { unit: 'SP', value: 14 },
        lineHeight: { unit: 'SP', value: 20 },
      },
    };
    const system = oneTokenSystem('md.sys.typescale.label.large', typographyValue);
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).not.toBeNull();
    expect(light.unresolvedReason).toBeUndefined();
  });

  it('resolves values-array wrapper tokens', () => {
    const wrapperValue = {
      compound: {
        values: [
          { unit: 'DIPS', value: 2 },
          { unit: 'DIPS', value: 4 },
        ],
      },
    };
    const system = oneTokenSystem('md.comp.elevation', wrapperValue);
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).not.toBeNull();
    expect(light.value).toContain('2dp');
    expect(light.unresolvedReason).toBeUndefined();
  });
});

describe('buildTokenResolutionSummary: unresolvedByReason', () => {
  function makeTableWithReasons(values: TokenTableGraph['tokenTables'][number]['tokenSets'][number]['tokens'][number]['values']): TokenTableGraph {
    return {
      schemaVersion: 1,
      generatedAt: '2026-06-30T00:00:00.000Z',
      tokenTables: [
        {
          resourceId: 'token-table:test',
          resourceName: 'md.test',
          requestedTokenSets: ['md.test'],
          routes: ['/test/specs'],
          unresolvedTokenCount: values.filter((v) => !v.resolved).length,
          tokenSets: [
            {
              tokenSetName: 'md.test',
              displayName: 'Test',
              tokens: [
                {
                  tokenName: 'md.test.token',
                  displayName: 'Test token',
                  aliases: [],
                  values,
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it('counts missing-alias-target cells (reserved future category)', () => {
    const graph = makeTableWithReasons([
      { role: 'light', value: null, resolved: false, unresolvedReason: 'missing-alias-target' },
      { role: 'dark', value: null, resolved: false, unresolvedReason: 'missing-alias-target' },
    ]);
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    expect(summary.unresolvedByReason['missing-alias-target']).toBe(2);
    expect(summary.unresolvedByReason['missing-context-entry']).toBe(0);
    expect(summary.unresolvedByReason['upstream-empty']).toBe(0);
    expect(summary.unresolvedByReason['unsupported-value-type']).toBe(0);
    // parser-bug is a reserved future category; the classifier does not currently emit it
    expect(summary.unresolvedByReason['parser-bug']).toBe(0);
    expect(summary.unresolvedByReason.unclassified).toBe(0);
  });

  it('counts missing-context-entry cells', () => {
    const graph = makeTableWithReasons([
      { role: 'light', value: null, resolved: false, unresolvedReason: 'missing-context-entry' },
      { role: 'dark', value: null, resolved: false, unresolvedReason: 'missing-context-entry' },
    ]);
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    expect(summary.unresolvedByReason['missing-context-entry']).toBe(2);
    expect(summary.unresolvedByReason['missing-alias-target']).toBe(0);
    expect(summary.unresolvedByReason['upstream-empty']).toBe(0);
    expect(summary.unresolvedByReason['unsupported-value-type']).toBe(0);
    expect(summary.unresolvedByReason.unclassified).toBe(0);
  });

  it('counts upstream-empty cells', () => {
    const graph = makeTableWithReasons([
      { role: 'light', value: null, resolved: false, unresolvedReason: 'upstream-empty' },
    ]);
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    expect(summary.unresolvedByReason['upstream-empty']).toBe(1);
    expect(summary.unresolvedByReason['missing-alias-target']).toBe(0);
  });

  it('counts unsupported-value-type cells', () => {
    const graph = makeTableWithReasons([
      { role: 'light', value: null, resolved: false, unresolvedReason: 'unsupported-value-type' },
      { role: 'dark', value: '#fff', resolved: true },
    ]);
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    expect(summary.unresolvedByReason['unsupported-value-type']).toBe(1);
    expect(summary.unresolvedCellCount).toBe(1);
  });

  it('counts unclassified when unresolvedReason is absent', () => {
    const graph = makeTableWithReasons([
      { role: 'light', value: null, resolved: false },
    ]);
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    expect(summary.unresolvedByReason.unclassified).toBe(1);
  });

  it('aggregates mixed reasons across cells', () => {
    const graph = makeTableWithReasons([
      { role: 'light', value: null, resolved: false, unresolvedReason: 'missing-alias-target' },
      { role: 'dark', value: null, resolved: false, unresolvedReason: 'upstream-empty' },
      { role: 'light-high-contrast', value: null, resolved: false, unresolvedReason: 'unsupported-value-type' },
      { role: 'dark-high-contrast', value: null, resolved: false },
    ]);
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    expect(summary.unresolvedByReason['missing-alias-target']).toBe(1);
    expect(summary.unresolvedByReason['upstream-empty']).toBe(1);
    expect(summary.unresolvedByReason['unsupported-value-type']).toBe(1);
    expect(summary.unresolvedByReason.unclassified).toBe(1);
    expect(summary.unresolvedCellCount).toBe(4);
  });

  it('examples carry unresolvedReason from the value', () => {
    const graph = makeTableWithReasons([
      { role: 'light', value: null, resolved: false, unresolvedReason: 'upstream-empty' },
    ]);
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    const example = summary.unresolvedByRoute[0]?.examples[0];
    expect(example).toBeDefined();
    expect(example!.unresolvedReason).toBe('upstream-empty');
    expect(example!.displayValue).toBe('[unresolved]');
  });

  it('all remaining unresolved examples have a non-undefined unresolvedReason', () => {
    const graph = makeTableWithReasons([
      { role: 'light', value: null, resolved: false, unresolvedReason: 'missing-alias-target' },
      { role: 'dark', value: null, resolved: false, unresolvedReason: 'upstream-empty' },
      { role: 'light-high-contrast', value: null, resolved: false },
    ]);
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    for (const route of summary.unresolvedByRoute) {
      for (const example of route.examples) {
        expect(example.unresolvedReason).toBeDefined();
        expect(typeof example.unresolvedReason).toBe('string');
      }
    }
  });
});

describe('buildTokenTableNode: newly decoded value shapes (fix/remaining-token-value-formatting)', () => {
  // ── Shadow-color / partial-RGB colors ─────────────────────────────────────

  it('resolves alpha-only color { alpha: 1 } as #000000 (missing rgb channels = 0)', () => {
    const system = oneTokenSystem('md.comp.button.filled.container.shadow-color', { color: { alpha: 1 } });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).toBe('#000000');
    expect(light.unresolvedReason).toBeUndefined();
  });

  it('resolves alpha-only color { alpha: 0.5 } as rgba(0, 0, 0, 0.50)', () => {
    const system = oneTokenSystem('md.comp.button.shadow-color', { color: { alpha: 0.5 } });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).toBe('rgba(0, 0, 0, 0.50)');
    expect(light.unresolvedReason).toBeUndefined();
  });

  it('resolves partial color missing red { green, blue, alpha } with red=0', () => {
    const system = oneTokenSystem('md.comp.button.filled.selected.label-text.color', {
      color: { green: 0.2901961, blue: 0.46666667, alpha: 1 },
    });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).toMatch(/^#[0-9a-f]{6}$/i);
    // red=0, green≈74, blue≈119
    expect(light.value).toBe('#004a77');
    expect(light.unresolvedReason).toBeUndefined();
  });

  it('resolves partial color missing green { red, blue, alpha } with green=0', () => {
    const system = oneTokenSystem('md.comp.button.filled.unselected.label-text.color', {
      color: { red: 0.12941177, blue: 0.3647059, alpha: 1 },
    });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).toMatch(/^#[0-9a-f]{6}$/i);
    expect(light.unresolvedReason).toBeUndefined();
  });

  it('resolves HC color { alpha: 1 } in light-high-contrast context', () => {
    const fullTokenName = 'ds/tokenSets/ts1/tokens/md.comp.button.filled.selected.label-text.color';
    const system: DecodedTokenTableSystem = {
      tokens: [{
        name: fullTokenName,
        tokenName: 'md.comp.button.filled.selected.label-text.color',
        displayName: 'Button selected label color',
        tokenValueType: 'COLOR',
        state: 'ACTIVE',
      }],
      tokenSets: [{ name: 'ds/tokenSets/ts1', displayName: 'Test Set', tokenSetName: 'md.test' }],
      tags: baseTags(),
      contextTagGroups: [],
      contextualReferenceTrees: {
        [fullTokenName]: {
          contextualReferenceTree: [
            {
              contextTags: [LIGHT_TAG, AUDIENCE_3P_TAG],
              referenceTree: { tokenName: 'md.comp.button.filled.selected.label-text.color', childNodes: [] },
              resolvedValue: { color: { red: 0.38, green: 0.0, blue: 0.93, alpha: 1 } },
            },
            {
              contextTags: [LIGHT_TAG, AUDIENCE_3P_TAG, HIGH_CONTRAST_TAG],
              referenceTree: { tokenName: 'md.comp.button.filled.selected.label-text.color', childNodes: [] },
              resolvedValue: { color: { alpha: 1 } },
            },
          ],
        },
      },
    };

    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const lightHC = token.values.find((v) => v.role === 'light-high-contrast')!;

    expect(lightHC).toBeDefined();
    expect(lightHC.resolved).toBe(true);
    expect(lightHC.value).toBe('#000000');
    expect(lightHC.unresolvedReason).toBeUndefined();
  });

  // ── Elevation tokens ───────────────────────────────────────────────────────

  it('resolves elevation { unit } with no value as 0dp', () => {
    const system = oneTokenSystem('md.comp.button.filled.container.elevation', { elevation: { unit: 'DIPS' } });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).toBe('0dp');
    expect(light.unresolvedReason).toBeUndefined();
  });

  it('resolves elevation { value, unit } with value present (existing behavior)', () => {
    const system = oneTokenSystem('md.comp.elevated-button.container.elevation', { elevation: { value: 1, unit: 'DIPS' } });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).toBe('1dp');
    expect(light.unresolvedReason).toBeUndefined();
  });

  // ── Tracking tokens ────────────────────────────────────────────────────────

  it('resolves fontTracking { unit } with no value as 0sp', () => {
    const system = oneTokenSystem('md.comp.extended-fab.branded.label-text.tracking', { fontTracking: { unit: 'POINTS' } });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).toBe('0sp');
    expect(light.unresolvedReason).toBeUndefined();
  });

  it('resolves fontTracking { value, unit } with value present', () => {
    const system = oneTokenSystem('md.comp.button.label-text.tracking', { fontTracking: { value: 0.1, unit: 'POINTS' } });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).toBe('0.1sp');
    expect(light.unresolvedReason).toBeUndefined();
  });

  it('resolves length { unit } with no value (width/spacing tokens) as 0dp', () => {
    const system = oneTokenSystem('md.comp.filter-chip.flat.selected.outline.width', { length: { unit: 'DIPS' } });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.value).toBe('0dp');
    expect(light.unresolvedReason).toBeUndefined();
  });

  // ── Safety: unknown objects still stay unresolved ──────────────────────────

  it('keeps unknown object unresolved as unsupported-value-type', () => {
    const unknownValue = { someUnknownType: { x: 1, y: 2 } };
    const system = oneTokenSystem('md.comp.foo', unknownValue);
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(false);
    expect(light.value).toBeNull();
    expect(light.unresolvedReason).toBe('unsupported-value-type');
  });

  it('keeps object with unit plus extra key unresolved (does not match unit-only rule)', () => {
    const weirdValue = { someType: { unit: 'DIPS', extraKey: 'foo' } };
    const system = oneTokenSystem('md.comp.foo', weirdValue);
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(false);
    expect(light.unresolvedReason).toBe('unsupported-value-type');
  });

  // ── Resolved values do not carry unresolvedReason ──────────────────────────

  it('resolved shadow-color cell does not carry unresolvedReason', () => {
    const system = oneTokenSystem('md.comp.button.filled.container.shadow-color', { color: { alpha: 1 } });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.unresolvedReason).toBeUndefined();
  });

  it('resolved elevation cell does not carry unresolvedReason', () => {
    const system = oneTokenSystem('md.comp.button.container.elevation', { elevation: { unit: 'DIPS' } });
    const node = buildNode(system);
    const token = node.tokenSets[0]?.tokens[0]!;
    const light = token.values.find((v) => v.role === 'light')!;

    expect(light.resolved).toBe(true);
    expect(light.unresolvedReason).toBeUndefined();
  });

  // ── Strict dimension value handling ───────────────────────────────────────

  it('dimension { unit } with no value field resolves to 0dp', () => {
    const system = oneTokenSystem('md.comp.foo.dimension', { dim: { unit: 'DIPS' } });
    const node = buildNode(system);
    const light = node.tokenSets[0]?.tokens[0]?.values.find((v) => v.role === 'light')!;
    expect(light.resolved).toBe(true);
    expect(light.value).toBe('0dp');
  });

  it('dimension { unit, value: null } resolves to 0dp', () => {
    const system = oneTokenSystem('md.comp.foo.dimension', { dim: { unit: 'DIPS', value: null } });
    const node = buildNode(system);
    const light = node.tokenSets[0]?.tokens[0]?.values.find((v) => v.role === 'light')!;
    expect(light.resolved).toBe(true);
    expect(light.value).toBe('0dp');
  });

  it('dimension { unit, value: 0 } resolves to 0dp', () => {
    const system = oneTokenSystem('md.comp.foo.dimension', { dim: { unit: 'DIPS', value: 0 } });
    const node = buildNode(system);
    const light = node.tokenSets[0]?.tokens[0]?.values.find((v) => v.role === 'light')!;
    expect(light.resolved).toBe(true);
    expect(light.value).toBe('0dp');
  });

  it('dimension { unit, value: "0" } stays unresolved as unsupported-value-type', () => {
    const system = oneTokenSystem('md.comp.foo.dimension', { dim: { unit: 'DIPS', value: '0' } });
    const node = buildNode(system);
    const light = node.tokenSets[0]?.tokens[0]?.values.find((v) => v.role === 'light')!;
    expect(light.resolved).toBe(false);
    expect(light.value).toBeNull();
    expect(light.unresolvedReason).toBe('unsupported-value-type');
  });

  it('dimension { unit, value: NaN } stays unresolved as unsupported-value-type', () => {
    const system = oneTokenSystem('md.comp.foo.dimension', { dim: { unit: 'DIPS', value: NaN } });
    const node = buildNode(system);
    const light = node.tokenSets[0]?.tokens[0]?.values.find((v) => v.role === 'light')!;
    expect(light.resolved).toBe(false);
    expect(light.value).toBeNull();
    expect(light.unresolvedReason).toBe('unsupported-value-type');
  });

  it('dimension { unit, value: Infinity } stays unresolved as unsupported-value-type', () => {
    const system = oneTokenSystem('md.comp.foo.dimension', { dim: { unit: 'DIPS', value: Infinity } });
    const node = buildNode(system);
    const light = node.tokenSets[0]?.tokens[0]?.values.find((v) => v.role === 'light')!;
    expect(light.resolved).toBe(false);
    expect(light.value).toBeNull();
    expect(light.unresolvedReason).toBe('unsupported-value-type');
  });

  // ── Strict color alpha handling ────────────────────────────────────────────

  it('color with alpha present as string stays unresolved as unsupported-value-type', () => {
    const system = oneTokenSystem('md.comp.foo.color', { color: { red: 0.5, green: 0.5, blue: 0.5, alpha: 'opaque' } });
    const node = buildNode(system);
    const light = node.tokenSets[0]?.tokens[0]?.values.find((v) => v.role === 'light')!;
    expect(light.resolved).toBe(false);
    expect(light.value).toBeNull();
    expect(light.unresolvedReason).toBe('unsupported-value-type');
  });

  it('color with alpha present as NaN stays unresolved as unsupported-value-type', () => {
    const system = oneTokenSystem('md.comp.foo.color', { color: { red: 0.5, green: 0.5, blue: 0.5, alpha: NaN } });
    const node = buildNode(system);
    const light = node.tokenSets[0]?.tokens[0]?.values.find((v) => v.role === 'light')!;
    expect(light.resolved).toBe(false);
    expect(light.value).toBeNull();
    expect(light.unresolvedReason).toBe('unsupported-value-type');
  });

  // ── unresolvedByReason counts stay correct ─────────────────────────────────

  it('unresolvedByReason.unsupported-value-type reflects only truly unknown values', () => {
    const fullTokenName = 'ds/tokenSets/ts1/tokens/md.comp.mixed';
    const system: DecodedTokenTableSystem = {
      tokens: [
        {
          name: fullTokenName,
          tokenName: 'md.comp.mixed',
          displayName: 'Mixed token',
          tokenValueType: 'COLOR',
          state: 'ACTIVE',
        },
      ],
      tokenSets: [{ name: 'ds/tokenSets/ts1', displayName: 'Test Set', tokenSetName: 'md.test' }],
      tags: baseTags(),
      contextTagGroups: [],
      contextualReferenceTrees: {
        [fullTokenName]: {
          contextualReferenceTree: [
            {
              contextTags: [LIGHT_TAG, AUDIENCE_3P_TAG],
              referenceTree: { tokenName: 'md.comp.mixed', childNodes: [] },
              resolvedValue: { color: { alpha: 1 } },
            },
            {
              contextTags: [DARK_TAG, AUDIENCE_3P_TAG],
              referenceTree: { tokenName: 'md.comp.mixed', childNodes: [] },
              resolvedValue: { unknownShape: { x: 99 } },
            },
          ],
        },
      },
    };

    const node = buildNode(system);
    const graph: import('../src/graph/graph-types.js').TokenTableGraph = {
      schemaVersion: 1,
      generatedAt: '2026-06-30T00:00:00.000Z',
      tokenTables: [node],
    };
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    // Light: color { alpha: 1 } → resolved → not counted
    const light = node.tokenSets[0]?.tokens[0]?.values.find((v) => v.role === 'light')!;
    expect(light.resolved).toBe(true);

    // Dark: unknownShape → unsupported-value-type
    const dark = node.tokenSets[0]?.tokens[0]?.values.find((v) => v.role === 'dark')!;
    expect(dark.resolved).toBe(false);
    expect(dark.unresolvedReason).toBe('unsupported-value-type');

    expect(summary.unresolvedByReason['unsupported-value-type']).toBe(1);
    expect(summary.unresolvedByReason.unclassified).toBe(0);
  });
});

describe('buildTokenTableNode: unresolvedReason flows end-to-end into resolution summary', () => {
  it('upstream-empty tokens produce upstream-empty in summary unresolvedByReason', () => {
    const node = buildNode(emptyTreeSystem('md.test.elevation'));
    const graph: TokenTableGraph = {
      schemaVersion: 1,
      generatedAt: '2026-06-30T00:00:00.000Z',
      tokenTables: [node],
    };
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    expect(summary.unresolvedByReason['upstream-empty']).toBeGreaterThan(0);
    expect(summary.unresolvedByReason.unclassified).toBe(0);
  });

  it('missing-context-entry tokens produce missing-context-entry in summary', () => {
    // Dark-only entry → light role gets missing-context-entry (entries exist but none match light)
    const system = oneTokenSystem('md.test.color', { color: { red: 0.5, green: 0.5, blue: 0.5, alpha: 1 } }, [DARK_TAG, AUDIENCE_3P_TAG]);
    const node = buildNode(system);
    const graph: TokenTableGraph = {
      schemaVersion: 1,
      generatedAt: '2026-06-30T00:00:00.000Z',
      tokenTables: [node],
    };
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph });

    expect(summary.unresolvedByReason['missing-context-entry']).toBeGreaterThan(0);
    expect(summary.unresolvedByReason['missing-alias-target']).toBe(0);
  });
});
