import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDefaultCacheDir } from './cache.js';
import { MaterialDocsStore } from './store.js';

function jsonText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export async function serveMcp(options: { cacheDir?: string; maxAgeHours?: number } = {}): Promise<void> {
  const cacheDir = options.cacheDir ?? getDefaultCacheDir();
  const maxAgeHours = options.maxAgeHours ?? Number(process.env.M3_DOCS_MAX_AGE_HOURS ?? 24);
  const store = new MaterialDocsStore(cacheDir);
  const server = new McpServer({ name: 'm3-docs-mcp', version: '0.1.0' });

  server.tool('search_material_docs', 'Search locally cached official Material 3 documentation from m3.material.io.', {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(25).default(10)
  }, async ({ query, limit }) => {
    await store.ensureFresh(maxAgeHours);
    return jsonText(await store.searchDocs(query, limit));
  });

  server.tool('get_material_page', 'Return one cached Material 3 documentation page by cache path or source URL.', {
    pathOrUrl: z.string().min(1)
  }, async ({ pathOrUrl }) => {
    await store.ensureFresh(maxAgeHours);
    return jsonText(await store.getPage(pathOrUrl));
  });

  server.tool('get_component_docs', 'Return all cached Material 3 documentation pages matching a component name.', {
    componentName: z.string().min(1)
  }, async ({ componentName }) => {
    await store.ensureFresh(maxAgeHours);
    return jsonText(await store.getComponentDocs(componentName));
  });

  server.tool('list_material_components', 'List component slugs discovered in the cached Material 3 documentation.', {}, async () => {
    await store.ensureFresh(maxAgeHours);
    return jsonText(await store.listComponents());
  });

  server.tool('refresh_material_docs', 'Refresh the local Material 3 documentation cache from m3.material.io using Playwright.', {
    maxPages: z.number().int().min(1).max(1000).optional()
  }, async ({ maxPages }) => {
    return jsonText(await store.refresh(maxPages));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
