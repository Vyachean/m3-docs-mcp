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

  server.tool('search_material_docs', 'Search locally cached official Material 3 documentation from m3.material.io. Does not refresh the cache implicitly.', {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(25).default(10)
  }, async ({ query, limit }) => {
    await store.ensureAvailable();
    return jsonText({ status: await store.getStatus(maxAgeHours), results: await store.searchDocs(query, limit) });
  });

  server.tool('get_material_page', 'Return one cached Material 3 documentation page by cache path or source URL. Does not refresh the cache implicitly.', {
    pathOrUrl: z.string().min(1)
  }, async ({ pathOrUrl }) => {
    await store.ensureAvailable();
    return jsonText({ status: await store.getStatus(maxAgeHours), page: await store.getPage(pathOrUrl) });
  });

  server.tool('get_component_docs', 'Return all cached Material 3 documentation pages matching a component name. Does not refresh the cache implicitly.', {
    componentName: z.string().min(1)
  }, async ({ componentName }) => {
    await store.ensureAvailable();
    return jsonText({ status: await store.getStatus(maxAgeHours), pages: await store.getComponentDocs(componentName) });
  });

  server.tool('list_material_components', 'List component slugs discovered in the cached Material 3 documentation. Does not refresh the cache implicitly.', {}, async () => {
    await store.ensureAvailable();
    return jsonText({ status: await store.getStatus(maxAgeHours), components: await store.listComponents() });
  });

  server.tool('material_docs_cache_status', 'Return local Material 3 documentation cache status without refreshing it.', {}, async () => {
    return jsonText(await store.getStatus(maxAgeHours));
  });

  server.tool('refresh_material_docs', 'Refresh the local Material 3 documentation cache from m3.material.io using Playwright. This is an explicit long-running operation.', {
    maxPages: z.number().int().min(1).max(1000).optional()
  }, async ({ maxPages }) => {
    return jsonText(await store.refresh(maxPages));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
