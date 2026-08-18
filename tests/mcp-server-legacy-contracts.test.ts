import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';

type ToolSchema = Record<string, ZodTypeAny>;
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  const schemas = new Map<string, ToolSchema>();
  const outputSchemas = new Map<string, ZodTypeAny | undefined>();
  const stores: Array<Record<string, unknown>> = [];
  return { handlers, schemas, outputSchemas, stores };
});

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(
      name: string,
      config: { inputSchema: ToolSchema; outputSchema?: ZodTypeAny },
      handler: (args: Record<string, unknown>) => Promise<ToolResult>
    ) {
      mocks.schemas.set(name, config.inputSchema);
      mocks.outputSchemas.set(name, config.outputSchema);
      mocks.handlers.set(name, handler);
    }

    async connect(_transport: unknown) {}
  }
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {}
}));

vi.mock('../src/cache.js', () => ({
  getDefaultCacheDir: () => '/default-cache'
}));

vi.mock('../src/store.js', () => ({
  MaterialDocsStore: class {
    getStatus = vi.fn(async () => ({
      cacheDir: '/cache',
      hasCache: true,
      source: 'https://m3.material.io',
      capturedAt: '2026-08-18T00:00:00.000Z',
      pageCount: 2,
      attemptedPageCount: 2,
      failedPageCount: 0,
      failedUrls: [],
      ageMs: 1_000,
      ttlMs: 86_400_000,
      isFresh: true
    }));
    getDiagnostics = vi.fn(async () => ({ cacheDir: '/cache', latestDiagnosticsFile: null, latestLogFile: null, diagnostics: null }));
    refresh = vi.fn();
    searchDocs = vi.fn(async () => []);
    getPage = vi.fn(async () => ({
      meta: {
        id: 'buttons-specs',
        title: 'Buttons',
        url: 'https://m3.material.io/components/buttons/specs',
        path: 'components/buttons/specs.md',
        section: 'components/buttons',
        headings: ['Buttons', 'Specs'],
        capturedAt: '2026-08-18T00:00:00.000Z'
      },
      markdown: '# Buttons specs'
    }));
    getComponentDocs = vi.fn(async () => [{
      title: 'Buttons',
      path: 'components/buttons/specs.md',
      url: 'https://m3.material.io/components/buttons/specs',
      section: 'components/buttons',
      headings: ['Buttons', 'Specs'],
      markdown: '# Buttons specs'
    }]);
    listComponents = vi.fn(async () => [{
      component: 'buttons',
      section: 'components/buttons',
      path: 'components/buttons/specs.md'
    }]);

    constructor(readonly cacheDir: string) {
      mocks.stores.push(this as unknown as Record<string, unknown>);
    }
  }
}));

const { serveMcp } = await import('../src/mcp-server.js');

async function callTool(name: string, args: Record<string, unknown>) {
  const handler = mocks.handlers.get(name);
  const schema = mocks.schemas.get(name);
  expect(handler).toBeDefined();
  expect(schema).toBeDefined();

  const parsedArgs = Object.fromEntries(
    Object.entries(schema!).map(([key, value]) => [key, value.parse(args[key])])
  );
  const result = await handler!(parsedArgs);
  const textPayload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
  expect(result.structuredContent).toEqual(textPayload);
  return textPayload;
}

describe('serveMcp legacy compatibility contracts', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.schemas.clear();
    mocks.outputSchemas.clear();
    mocks.stores.length = 0;
  });

  it('keeps declared object output schemas on compatibility tools', async () => {
    await serveMcp({ cacheDir: '/cache', autoUpdate: false });

    for (const name of [
      'search_material_docs',
      'get_material_page',
      'get_component_docs',
      'list_material_components',
      'material_docs_cache_status',
      'material_docs_cache_diagnostics',
      'refresh_material_docs'
    ]) {
      expect(mocks.outputSchemas.get(name)).toBeDefined();
    }
  });

  it('preserves the public page payload and source URL mapping', async () => {
    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    const store = mocks.stores[0] as { getPage: ReturnType<typeof vi.fn> };

    const result = await callTool('get_material_page', {
      pathOrUrl: ' components/buttons/specs.md '
    });

    expect(store.getPage).toHaveBeenCalledWith('components/buttons/specs.md');
    expect(result).toMatchObject({
      cache: { hasCache: true, pageCount: 2 },
      refresh: { running: false, error: null },
      page: {
        meta: {
          id: 'buttons-specs',
          title: 'Buttons',
          path: 'components/buttons/specs.md',
          url: 'https://m3.material.io/components/buttons/specs',
          sourceUrl: 'https://m3.material.io/components/buttons/specs',
          section: 'components/buttons',
          headings: ['Buttons', 'Specs']
        },
        markdown: '# Buttons specs'
      }
    });
  });

  it('preserves component response shape and forwards bounded rendering options', async () => {
    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    const store = mocks.stores[0] as { getComponentDocs: ReturnType<typeof vi.fn> };

    const result = await callTool('get_component_docs', {
      componentName: ' Buttons ',
      includeMarkdown: true,
      maxPages: 3,
      maxMarkdownChars: 2_000
    });

    expect(store.getComponentDocs).toHaveBeenCalledWith('Buttons', {
      includeMarkdown: true,
      maxPages: 3,
      maxMarkdownChars: 2_000
    });
    expect(result).toMatchObject({
      cache: { hasCache: true },
      refresh: { running: false, error: null },
      component: 'Buttons',
      pages: [{
        title: 'Buttons',
        path: 'components/buttons/specs.md',
        sourceUrl: 'https://m3.material.io/components/buttons/specs',
        section: 'components/buttons',
        headings: ['Buttons', 'Specs'],
        markdown: '# Buttons specs'
      }]
    });
  });

  it('preserves the discovered-component list instead of returning an empty compatibility shell', async () => {
    await serveMcp({ cacheDir: '/cache', autoUpdate: false });

    const result = await callTool('list_material_components', {});

    expect(result).toMatchObject({
      cache: { hasCache: true },
      refresh: { running: false, error: null },
      components: [{
        component: 'buttons',
        section: 'components/buttons',
        path: 'components/buttons/specs.md'
      }]
    });
  });
});
