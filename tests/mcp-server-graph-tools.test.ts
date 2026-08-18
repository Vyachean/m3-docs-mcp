import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';

type ToolSchema = Record<string, ZodTypeAny>;
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  outputSchema?: ZodTypeAny;
};

const mocks = vi.hoisted(() => {
  const toolHandlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  const toolDefinitions: ToolDefinition[] = [];
  const createdStores: object[] = [];
  const context = { marker: 'graph-context' };
  const loadGraphToolContext = vi.fn(async (_cacheDir: string) => context);
  const syncTool = (name: string) => vi.fn((..._args: unknown[]) => ({ tool: name }));
  const asyncTool = (name: string) => vi.fn(async (..._args: unknown[]) => ({ tool: name }));

  return {
    toolHandlers,
    toolDefinitions,
    createdStores,
    context,
    loadGraphToolContext,
    getComponentOverview: syncTool('get_component_overview'),
    listRoutes: syncTool('list_routes'),
    getRoute: syncTool('get_route'),
    getPage: asyncTool('get_page'),
    getComponentTokens: syncTool('get_component_tokens'),
    getComponentTabs: syncTool('get_component_tabs'),
    getComponentResources: syncTool('get_component_resources'),
    getRouteArtifacts: syncTool('get_route_artifacts'),
    getRawArtifact: asyncTool('get_raw_artifact'),
    explainRouteCoverage: syncTool('explain_route_coverage'),
    explainResourceResolution: syncTool('explain_resource_resolution'),
    searchStructuredDocs: syncTool('search_structured_docs')
  };
});

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(
      name: string,
      config: { description: string; inputSchema: ToolSchema; outputSchema?: ZodTypeAny },
      handler: (args: Record<string, unknown>) => Promise<ToolResult>
    ) {
      mocks.toolDefinitions.push({ name, ...config });
      mocks.toolHandlers.set(name, handler);
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
    constructor(readonly cacheDir: string) {
      mocks.createdStores.push(this);
    }
  }
}));

vi.mock('../src/mcp-tools/context.js', () => ({ loadGraphToolContext: mocks.loadGraphToolContext }));
vi.mock('../src/mcp-tools/get-component-overview.js', () => ({ getComponentOverview: mocks.getComponentOverview }));
vi.mock('../src/mcp-tools/list-routes.js', () => ({ listRoutes: mocks.listRoutes }));
vi.mock('../src/mcp-tools/get-route.js', () => ({ getRoute: mocks.getRoute }));
vi.mock('../src/mcp-tools/get-page.js', () => ({ getPage: mocks.getPage }));
vi.mock('../src/mcp-tools/get-component-tokens.js', () => ({ getComponentTokens: mocks.getComponentTokens }));
vi.mock('../src/mcp-tools/get-component-tabs.js', () => ({ getComponentTabs: mocks.getComponentTabs }));
vi.mock('../src/mcp-tools/get-component-resources.js', () => ({ getComponentResources: mocks.getComponentResources }));
vi.mock('../src/mcp-tools/get-route-artifacts.js', () => ({ getRouteArtifacts: mocks.getRouteArtifacts }));
vi.mock('../src/mcp-tools/get-raw-artifact.js', () => ({ DEFAULT_PREVIEW_CHARS: 2_000, getRawArtifact: mocks.getRawArtifact }));
vi.mock('../src/mcp-tools/explain-route-coverage.js', () => ({ explainRouteCoverage: mocks.explainRouteCoverage }));
vi.mock('../src/mcp-tools/explain-resource-resolution.js', () => ({ explainResourceResolution: mocks.explainResourceResolution }));
vi.mock('../src/mcp-tools/search-structured-docs.js', () => ({ searchStructuredDocs: mocks.searchStructuredDocs }));

const { serveMcp } = await import('../src/mcp-server.js');

function definitionFor(toolName: string): ToolDefinition {
  const definition = mocks.toolDefinitions.find((tool) => tool.name === toolName);
  expect(definition).toBeDefined();
  return definition!;
}

function schemaFor(toolName: string): ToolSchema {
  return definitionFor(toolName).inputSchema;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const handler = mocks.toolHandlers.get(name);
  expect(handler).toBeDefined();
  const schema = schemaFor(name);
  const parsedArgs = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, value.parse(args[key])])
  );
  const result = await handler!(parsedArgs);
  const textPayload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
  expect(result.structuredContent).toEqual(textPayload);
  return textPayload;
}

describe('serveMcp graph-oriented tool boundary', () => {
  beforeEach(() => {
    mocks.toolHandlers.clear();
    mocks.toolDefinitions.length = 0;
    mocks.createdStores.length = 0;
    mocks.loadGraphToolContext.mockClear();
    mocks.getComponentOverview.mockClear();
    mocks.listRoutes.mockClear();
    mocks.getRoute.mockClear();
    mocks.getPage.mockClear();
    mocks.getComponentTokens.mockClear();
    mocks.getComponentTabs.mockClear();
    mocks.getComponentResources.mockClear();
    mocks.getRouteArtifacts.mockClear();
    mocks.getRawArtifact.mockClear();
    mocks.explainRouteCoverage.mockClear();
    mocks.explainResourceResolution.mockClear();
    mocks.searchStructuredDocs.mockClear();
  });

  it('forwards validated graph-tool inputs through the public MCP handlers', async () => {
    await serveMcp({ cacheDir: '/cache', autoUpdate: false });
    const store = mocks.createdStores[0];
    expect(store).toBeDefined();

    await expect(callTool('get_component_overview', { componentName: ' Buttons ' })).resolves.toEqual({ tool: 'get_component_overview' });
    expect(mocks.getComponentOverview).toHaveBeenCalledWith(mocks.context, 'Buttons');

    await expect(callTool('list_routes', {
      section: ' components ',
      coverageStatus: 'covered',
      search: ' buttons ',
      limit: 7
    })).resolves.toEqual({ tool: 'list_routes' });
    expect(mocks.listRoutes).toHaveBeenCalledWith(mocks.context, {
      section: 'components',
      coverageStatus: 'covered',
      search: 'buttons',
      limit: 7
    });

    await expect(callTool('get_route', { route: ' /components/buttons ' })).resolves.toEqual({ tool: 'get_route' });
    expect(mocks.getRoute).toHaveBeenCalledWith(mocks.context, '/components/buttons');

    await expect(callTool('get_page', {
      route: ' /components/buttons/specs ',
      view: 'markdown',
      maxMarkdownChars: 321
    })).resolves.toEqual({ tool: 'get_page' });
    expect(mocks.getPage).toHaveBeenCalledWith(mocks.context, store, {
      route: '/components/buttons/specs',
      view: 'markdown',
      maxMarkdownChars: 321
    });

    await expect(callTool('get_component_tokens', { componentName: ' Buttons ' })).resolves.toEqual({ tool: 'get_component_tokens' });
    expect(mocks.getComponentTokens).toHaveBeenCalledWith(mocks.context, 'Buttons');

    await expect(callTool('get_component_tabs', { componentName: ' Buttons ' })).resolves.toEqual({ tool: 'get_component_tabs' });
    expect(mocks.getComponentTabs).toHaveBeenCalledWith(mocks.context, 'Buttons');

    await expect(callTool('get_component_resources', { componentName: ' Buttons ' })).resolves.toEqual({ tool: 'get_component_resources' });
    expect(mocks.getComponentResources).toHaveBeenCalledWith(mocks.context, 'Buttons');

    await expect(callTool('get_route_artifacts', { route: ' /components/buttons ' })).resolves.toEqual({ tool: 'get_route_artifacts' });
    expect(mocks.getRouteArtifacts).toHaveBeenCalledWith(mocks.context, '/components/buttons');

    await expect(callTool('get_raw_artifact', {
      artifactId: ' artifact-1 ',
      fullContent: true,
      previewChars: 321
    })).resolves.toEqual({ tool: 'get_raw_artifact' });
    expect(mocks.getRawArtifact).toHaveBeenCalledWith(mocks.context, {
      artifactId: 'artifact-1',
      fullContent: true,
      previewChars: 321
    });

    await expect(callTool('explain_route_coverage', { route: ' /components/buttons ' })).resolves.toEqual({ tool: 'explain_route_coverage' });
    expect(mocks.explainRouteCoverage).toHaveBeenCalledWith(mocks.context, '/components/buttons');

    await expect(callTool('explain_resource_resolution', { resourceId: ' resource-1 ' })).resolves.toEqual({ tool: 'explain_resource_resolution' });
    expect(mocks.explainResourceResolution).toHaveBeenCalledWith(mocks.context, 'resource-1');

    await expect(callTool('search_structured_docs', { query: ' button tokens ', limit: 9 })).resolves.toEqual({ tool: 'search_structured_docs' });
    expect(mocks.searchStructuredDocs).toHaveBeenCalledWith(mocks.context, 'button tokens', 9);

    expect(mocks.loadGraphToolContext).toHaveBeenCalledTimes(12);
    expect(mocks.loadGraphToolContext).toHaveBeenCalledWith('/cache');
  });

  it('declares structured output schemas for graph tools', async () => {
    await serveMcp({ cacheDir: '/cache', autoUpdate: false });

    for (const name of [
      'get_component_overview',
      'search_structured_docs',
      'list_routes',
      'get_route',
      'get_page',
      'get_component_tokens',
      'get_component_tabs',
      'get_component_resources',
      'get_route_artifacts',
      'get_raw_artifact',
      'explain_route_coverage',
      'explain_resource_resolution'
    ]) {
      expect(definitionFor(name).outputSchema).toBeDefined();
    }
  });

  it('enforces graph-tool defaults and meaningful public input bounds', async () => {
    await serveMcp({ cacheDir: '/cache', autoUpdate: false });

    const overviewSchema = schemaFor('get_component_overview');
    expect(overviewSchema.componentName.safeParse(' Buttons ').data).toBe('Buttons');
    expect(overviewSchema.componentName.safeParse('   ').success).toBe(false);

    const listRoutesSchema = schemaFor('list_routes');
    expect(listRoutesSchema.section.safeParse('   ').success).toBe(false);
    expect(listRoutesSchema.limit.safeParse(undefined).data).toBe(100);
    expect(listRoutesSchema.limit.safeParse(0).success).toBe(false);
    expect(listRoutesSchema.limit.safeParse(500).success).toBe(true);
    expect(listRoutesSchema.limit.safeParse(501).success).toBe(false);

    const routeSchema = schemaFor('get_route');
    expect(routeSchema.route.safeParse('  ').success).toBe(false);
    expect(routeSchema.route.safeParse(' /components/buttons ').data).toBe('/components/buttons');

    const pageSchema = schemaFor('get_page');
    expect(pageSchema.view.safeParse(undefined).data).toBe('structured');
    expect(pageSchema.view.safeParse('raw-summary').success).toBe(true);
    expect(pageSchema.view.safeParse('html').success).toBe(false);
    expect(pageSchema.maxMarkdownChars.safeParse(undefined).data).toBe(20_000);
    expect(pageSchema.maxMarkdownChars.safeParse(199).success).toBe(false);
    expect(pageSchema.maxMarkdownChars.safeParse(100_000).success).toBe(true);
    expect(pageSchema.maxMarkdownChars.safeParse(100_001).success).toBe(false);

    const rawArtifactSchema = schemaFor('get_raw_artifact');
    expect(rawArtifactSchema.artifactId.safeParse(' artifact-1 ').data).toBe('artifact-1');
    expect(rawArtifactSchema.artifactId.safeParse('').success).toBe(false);
    expect(rawArtifactSchema.fullContent.safeParse(undefined).data).toBe(false);
    expect(rawArtifactSchema.previewChars.safeParse(undefined).data).toBe(2_000);
    expect(rawArtifactSchema.previewChars.safeParse(99).success).toBe(false);
    expect(rawArtifactSchema.previewChars.safeParse(20_000).success).toBe(true);
    expect(rawArtifactSchema.previewChars.safeParse(20_001).success).toBe(false);

    const structuredSearchSchema = schemaFor('search_structured_docs');
    expect(structuredSearchSchema.query.safeParse('  ').success).toBe(false);
    expect(structuredSearchSchema.limit.safeParse(undefined).data).toBe(20);
    expect(structuredSearchSchema.limit.safeParse(0).success).toBe(false);
    expect(structuredSearchSchema.limit.safeParse(100).success).toBe(true);
    expect(structuredSearchSchema.limit.safeParse(101).success).toBe(false);
  });
});
