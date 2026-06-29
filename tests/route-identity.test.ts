import { describe, expect, it } from 'vitest';
import { markdownPathToRoute, normalizeGraphRoute, routeToMarkdownPath } from '../src/graph/route-identity.js';

describe('route identity helpers', () => {
  it('normalizes URLs, route paths, and markdown paths to the same graph route', () => {
    expect(normalizeGraphRoute('https://m3.material.io/components/switch/specs')).toBe('/components/switch/specs');
    expect(normalizeGraphRoute('/components/switch/specs/')).toBe('/components/switch/specs');
    expect(normalizeGraphRoute('components/switch/specs.md')).toBe('/components/switch/specs');
    expect(normalizeGraphRoute('pages/components/switch/specs.md')).toBe('/components/switch/specs');
  });

  it('converts route identity to markdown compatibility paths only at the edge', () => {
    expect(routeToMarkdownPath('/components/switch/specs')).toBe('components/switch/specs.md');
    expect(routeToMarkdownPath('/')).toBe('index.md');
    expect(markdownPathToRoute('components/switch/specs.md')).toBe('/components/switch/specs');
  });
});
