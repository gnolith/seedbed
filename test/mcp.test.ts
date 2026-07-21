import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { authorize } from '@gnolith/workshop/server';
import { describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../src/mcp.js';
import { OperationLifecycle } from '../src/lifecycle.js';
import { createLocalPrincipal, LOCAL_PROCESS_CAPABILITIES, type SeedbedRuntime } from '../src/runtime.js';

function runtime(callTool?: SeedbedRuntime['dispatcher']['callTool']): SeedbedRuntime {
  return {
    database: { close: vi.fn(async () => undefined) } as unknown as SeedbedRuntime['database'],
    principal: createLocalPrincipal('local-owner'),
    lifecycle: new OperationLifecycle(),
    dispatcher: {
      tools: [],
      listTools(principal) {
        if (!principal) return { ok: false, failure: { kind: 'unauthenticated', error: { code: 'unauthenticated', message: 'Authentication is required', status: 401 } } };
        return { ok: true, value: [{ name: 'echo', title: 'Echo', description: 'Echo input', capability: 'read', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }] };
      },
      callTool: callTool ?? (async (call, context) => {
        if (!context.principal) return { ok: false, failure: { kind: 'unauthenticated', error: { code: 'unauthenticated', message: 'Authentication is required', status: 401 } } };
        return { ok: true, value: { name: call.name, arguments: call.arguments, principal: context.principal.id } };
      }),
    },
    async drain() {
      await this.lifecycle.drain(1_000);
    },
    async close() {
      await this.drain();
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

  it('drains a delayed call, rejects new work, and excludes administrative authority', async () => {
    expect(LOCAL_PROCESS_CAPABILITIES).not.toContain('admin');
    const principal = createLocalPrincipal('local-owner');
    expect(authorize(principal, 'read')).toBe(principal);
    expect(() => authorize(principal, 'admin')).toThrow(/admin capability/u);
    let release!: () => void;
    let started!: () => void;
    const callStarted = new Promise<void>((resolve) => { started = resolve; });
    const subject = runtime(vi.fn(async (call) => {
      if (call.name === 'slow') {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { ok: true as const, value: { name: call.name } };
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(subject);
    const client = new Client({ name: 'seedbed-drain-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const slow = client.callTool({ name: 'slow', arguments: {} });
    await callStarted;
    const draining = subject.drain();
    await expect(client.callTool({ name: 'after-shutdown', arguments: {} })).rejects.toThrow(/shutting down/u);
    release();
    await draining;
    await expect(slow).resolves.toMatchObject({ structuredContent: { name: 'slow' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await server.close();
    await subject.close();
    await client.close();
  });
});
