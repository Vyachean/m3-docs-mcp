import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveMcp } from '../src/mcp-server.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MCP protocol surface', () => {
  it('exposes agent instructions, output schemas, and structured results through the real SDK', async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'm3-docs-mcp-protocol-'));
    tempDirs.push(cacheDir);

    let configuredServer: McpServer | null = null;
    const connectSpy = vi.spyOn(McpServer.prototype, 'connect').mockImplementation(async function (this: McpServer) {
      configuredServer = this;
    });

    await serveMcp({ cacheDir, autoUpdate: false });
    expect(configuredServer).not.toBeNull();
    connectSpy.mockRestore();

    const client = new Client({ name: 'm3-docs-mcp-protocol-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await configuredServer!.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getInstructions()).toContain('graph-oriented tools as the primary');
      expect(client.getInstructions()).toContain('get_component_overview');

      const listed = await client.listTools();
      const overview = listed.tools.find((tool) => tool.name === 'get_component_overview');
      const legacySearch = listed.tools.find((tool) => tool.name === 'search_material_docs');
      const rawArtifact = listed.tools.find((tool) => tool.name === 'get_raw_artifact');

      expect(listed.tools[0]?.name).toBe('get_component_overview');
      expect(overview?.description).toContain('Primary component entry point');
      expect(overview?.outputSchema).toBeDefined();
      expect(legacySearch?.description).toContain('Compatibility/full-text tool');
      expect(rawArtifact?.description).toContain('Troubleshooting/provenance tool');

      const result = await client.callTool({
        name: 'get_component_overview',
        arguments: { componentName: 'button' }
      });

      expect(result.structuredContent).toMatchObject({
        available: false,
        component: 'button',
        found: false,
        canonicalName: null,
        routes: [],
        tabs: [],
        tokenTables: [],
        recommendedRoutes: []
      });

      const text = result.content.find((entry) => entry.type === 'text');
      expect(text?.type).toBe('text');
      if (text?.type !== 'text') throw new Error('Expected text compatibility payload');
      expect(JSON.parse(text.text)).toEqual(result.structuredContent);
    } finally {
      await client.close();
      await configuredServer!.close();
    }
  });
});
