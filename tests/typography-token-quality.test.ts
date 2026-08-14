import { describe, expect, it } from 'vitest';
import { buildTokenTableNode } from '../src/graph/token-table-graph.js';
import { renderTokenTableWithDiagnostics } from '../src/json-extraction/render-markdown.js';
import type { DecodedTokenTableSystem } from '../src/json-extraction/schemas.js';
import { validateTokenResolutionSummary } from '../src/validation/validate-token-resolution.js';
import type { CacheDiagnosticsSummary } from '../src/diagnostics/write-cache-diagnostics.js';

const LIGHT_TAG = 'ds/tags/light';
const DARK_TAG = 'ds/tags/dark';
const AUDIENCE_3P_TAG = 'ds/tags/3p';

function systemWithResolvedValue(resolvedValue: Record<string, unknown>): DecodedTokenTableSystem {
  const tokenName = 'md.test.token';
  const fullTokenName = `ds/tokenSets/ts1/tokens/${tokenName}`;
  return {
    tokens: [{
      name: fullTokenName,
      tokenName,
      displayName: 'Test token',
      tokenValueType: 'TYPOGRAPHY',
      state: 'ACTIVE',
    }],
    tokenSets: [{ name: 'ds/tokenSets/ts1', displayName: 'Test Set', tokenSetName: 'md.test' }],
    tags: [
      { name: LIGHT_TAG, displayName: 'Light', tagName: 'light' },
      { name: DARK_TAG, displayName: 'Dark', tagName: 'dark' },
      { name: AUDIENCE_3P_TAG, displayName: '3P', tagName: '3p' },
    ],
    contextTagGroups: [],
    contextualReferenceTrees: {
      [fullTokenName]: {
        contextualReferenceTree: [LIGHT_TAG, DARK_TAG].map((themeTag) => ({
          contextTags: [themeTag, AUDIENCE_3P_TAG],
          referenceTree: { tokenName, childNodes: [] },
          resolvedValue,
        })),
      },
    },
  };
}

function diagnosticsSummary(overrides: Partial<CacheDiagnosticsSummary> = {}): CacheDiagnosticsSummary {
  return {
    unresolvedTokenRows: 0,
    unresolvedTokenCells: 0,
    specPagesWithTokenTables: 0,
    specPagesWithoutTokenTables: 0,
    componentSpecPageCount: 0,
    componentSpecPagesWithTokenTables: 0,
    componentSpecPagesWithoutTokenTables: 0,
    stalePublicDocsRoutes: 0,
    stalePublicDocsRouteSource: 'routePlanSummary',
    policySkippedRoutes: 0,
    nonContentRoutes: 0,
    unresolvedByReason: {
      'missing-alias-target': 0,
      'missing-context-entry': 0,
      'unsupported-value-type': 0,
      'upstream-empty': 0,
      'parser-bug': 0,
      unclassified: 0,
    },
    ...overrides,
  };
}

describe('current Material typography token values', () => {
  it('keeps variable-font axis objects resolved in the token graph', () => {
    const system = systemWithResolvedValue({ axis: { tag: 'wght', value: 500 } });
    const node = buildTokenTableNode({
      resourceId: 'token-table:test',
      resourceName: 'md.test',
      system,
      requestedTokenSets: ['Test Set'],
    });

    const token = node.tokenSets[0]?.tokens[0];
    expect(token?.values.find((value) => value.role === 'light')).toMatchObject({
      resolved: true,
      value: '{"tag":"wght","value":500}',
    });
    expect(token?.values.find((value) => value.role === 'dark')).toMatchObject({
      resolved: true,
      value: '{"tag":"wght","value":500}',
    });
    expect(node.unresolvedTokenCount).toBe(0);
  });

  it('keeps tag-only variable-font axes resolved in the token graph', () => {
    const system = systemWithResolvedValue({ axis: { tag: 'ROND' } });
    const node = buildTokenTableNode({
      resourceId: 'token-table:test',
      resourceName: 'md.test',
      system,
      requestedTokenSets: ['Test Set'],
    });

    expect(node.tokenSets[0]?.tokens[0]?.values.find((value) => value.role === 'light')).toMatchObject({
      resolved: true,
      value: '{"tag":"ROND"}',
    });
    expect(node.unresolvedTokenCount).toBe(0);
  });

  it('renders omitted zero dimensions as zero instead of unresolved', () => {
    const system = systemWithResolvedValue({ dimension: { unit: 'SP' } });
    const rendered = renderTokenTableWithDiagnostics(system, ['Test Set']);

    expect(rendered.markdown).toContain('| md.test.token | Test token |  |  | 0sp | 0sp |');
    expect(rendered.markdown).not.toContain('[unresolved]');
    expect(rendered.diagnostics[0]?.unresolvedTokenCount).toBe(0);
  });
});

describe('token-resolution validation gate', () => {
  it('allows values that are intentionally empty upstream', () => {
    const summary = diagnosticsSummary({
      unresolvedTokenRows: 1,
      unresolvedTokenCells: 2,
      unresolvedByReason: {
        'missing-alias-target': 0,
        'missing-context-entry': 0,
        'unsupported-value-type': 0,
        'upstream-empty': 2,
        'parser-bug': 0,
        unclassified: 0,
      },
    });

    expect(validateTokenResolutionSummary(summary)).toMatchObject({ stage: 'token-resolution', passed: true });
  });

  it('fails closed on parser-caused unresolved values', () => {
    const summary = diagnosticsSummary({
      unresolvedTokenRows: 3,
      unresolvedTokenCells: 6,
      unresolvedByReason: {
        'missing-alias-target': 0,
        'missing-context-entry': 0,
        'unsupported-value-type': 4,
        'upstream-empty': 0,
        'parser-bug': 2,
        unclassified: 0,
      },
    });

    const result = validateTokenResolutionSummary(summary);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('unsupported-value-type: 4 unresolved token cells');
    expect(result.reasons).toContain('parser-bug: 2 unresolved token cells');
  });

  it('fails closed when token-resolution diagnostics are missing', () => {
    expect(validateTokenResolutionSummary(null)).toMatchObject({ stage: 'token-resolution', passed: false });
  });
});
