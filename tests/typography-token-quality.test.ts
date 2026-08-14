import { describe, expect, it } from 'vitest';
import { buildTokenTableNode } from '../src/graph/token-table-graph.js';
import { renderTokenTableWithDiagnostics } from '../src/json-extraction/render-markdown.js';
import type { DecodedTokenTableSystem } from '../src/json-extraction/schemas.js';

const LIGHT_TAG = 'ds/tags/light';
const DARK_TAG = 'ds/tags/dark';
const AUDIENCE_3P_TAG = 'ds/tags/3p';

function systemWithResolvedValue(
  tokenValueType: string,
  resolvedValue: Record<string, unknown>,
): DecodedTokenTableSystem {
  const tokenName = 'md.test.token';
  const fullTokenName = `ds/tokenSets/ts1/tokens/${tokenName}`;
  return {
    tokens: [{
      name: fullTokenName,
      tokenName,
      displayName: 'Test token',
      tokenValueType,
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

describe('current Material typography token values', () => {
  it('keeps AXIS_VALUE objects resolved in the token graph', () => {
    const system = systemWithResolvedValue('AXIS_VALUE', { axisValue: { tag: 'wght', value: 500 } });
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

  it('keeps tag-only AXIS_VALUE objects resolved in the token graph', () => {
    const system = systemWithResolvedValue('AXIS_VALUE', { axisValue: { tag: 'ROND' } });
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

  it('renders omitted FONT_TRACKING values as zero points', () => {
    const system = systemWithResolvedValue('FONT_TRACKING', { fontTracking: { unit: 'POINTS' } });
    const rendered = renderTokenTableWithDiagnostics(system, ['Test Set']);

    expect(rendered.markdown).toContain('| md.test.token | Test token |  |  | 0sp | 0sp |');
    expect(rendered.markdown).not.toContain('[unresolved]');
    expect(rendered.diagnostics[0]?.unresolvedTokenCount).toBe(0);
  });

  it('keeps an explicitly empty FONT_TRACKING payload unresolved without inventing zero', () => {
    const system = systemWithResolvedValue('FONT_TRACKING', { fontTracking: {} });
    const node = buildTokenTableNode({
      resourceId: 'token-table:test',
      resourceName: 'md.test',
      system,
      requestedTokenSets: ['Test Set'],
    });
    const rendered = renderTokenTableWithDiagnostics(system, ['Test Set']);

    expect(node.tokenSets[0]?.tokens[0]?.values.find((value) => value.role === 'light')).toMatchObject({
      resolved: false,
      value: null,
      unresolvedReason: 'upstream-empty',
    });
    expect(node.tokenSets[0]?.tokens[0]?.values.find((value) => value.role === 'dark')).toMatchObject({
      resolved: false,
      value: null,
      unresolvedReason: 'upstream-empty',
    });
    expect(rendered.markdown).toContain('[unresolved]');
    expect(rendered.markdown).not.toContain('0sp');
  });

  it('does not generalize FONT_TRACKING zero omission to other value types', () => {
    const system = systemWithResolvedValue('DIMENSION', { dimension: { unit: 'DIPS' } });
    const rendered = renderTokenTableWithDiagnostics(system, ['Test Set']);

    expect(rendered.markdown).toContain('[unresolved]');
    expect(rendered.markdown).not.toContain('0dp');
    expect(rendered.diagnostics[0]?.unresolvedTokenCount).toBe(1);
  });
});
