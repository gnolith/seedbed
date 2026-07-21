import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../src/mcp.js';
import { OperationLifecycle } from '../src/lifecycle.js';
import type { SeedbedRuntime } from '../src/runtime.js';

function runtime(): SeedbedRuntime {
  return {
    database: { close: vi.fn(async () => undefined) } as unknown as SeedbedRuntime['database'],
    principal: { id: 'local-owner', capabilities: ['admin'] },
    lifecycle: new OperationLifecycle(),
    dispatcher: {
      tools: [],
      listTools(principal) {
        if (!principal) return { ok: false, failure: { kind: 'unauthenticated', error: { code: 'unauthenticated', message: 'Authentication is required', status: 401 } } };
        return { ok: true, value: [{ name: 'echo', title: 'Echo', description: 'Echo input', capability: 'read', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }] };
      },
      async callTool(call, context) {
        if (!context.principal) return { ok: false, failure: { kind: 'unauthenticated', error: { code: 'unauthenticated', message: 'Authentication is required', status: 401 } } };
        return { ok: true, value: { name: call.name, arguments: call.arguments, principal: context.principal.id } };
      },
    },
    async close() {
      await this.lifecycle.drain(1_000);
      await this.database.close();
    },
  };
}

describe('official MCP SDK integration', () => {
  it('initializes, discovers tools, and performs an authorized call', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(runtime());
    const client = new Client({ name: 'seedbed-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(['echo']);
    const called = await client.callTool({ name: 'echo', arguments: { value: 42 } });
    expect(called.structuredContent).toEqual({ name: 'echo', arguments: { value: 42 }, principal: 'local-owner' });
    await client.close();
    await server.close();
  });

  it('returns a JSON-RPC error for a malformed request', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(runtime());
    await server.connect(serverTransport);
    const response = new Promise<unknown>((resolve) => { clientTransport.onmessage = resolve; });
    await clientTransport.start();
    await clientTransport.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} });
    await expect(response).resolves.toMatchObject({ jsonrpc: '2.0', id: 9, error: { code: expect.any(Number) } });
    await clientTransport.close();
    await server.close();
  });
});
