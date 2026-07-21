import { randomUUID } from 'node:crypto';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Logger } from './logger.js';
import type { SeedbedRuntime } from './runtime.js';

export function createMcpServer(runtime: SeedbedRuntime): Server {
  const server = new Server(
    { name: '@gnolith/seedbed', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = runtime.dispatcher.listTools(runtime.principal);
    if (!result.ok) throw new Error(result.failure.error.message);
    return {
      tools: result.value.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (typeof request.params.name !== 'string' || !request.params.name.trim()) {
      throw new McpError(ErrorCode.InvalidParams, 'tools/call requires a non-empty name');
    }
    const result = await runtime.lifecycle.run(() => runtime.dispatcher.callTool(
      {
        name: request.params.name,
        ...(request.params.arguments === undefined ? {} : { arguments: request.params.arguments }),
      },
      { principal: runtime.principal, requestId: randomUUID() },
    ));
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(result.failure.error) }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
      structuredContent: toStructured(result.value),
    };
  });
  return server;
}

export async function runMcpStdio(runtime: SeedbedRuntime, logger: Logger): Promise<void> {
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = (reason: string) => {
    if (!closing) {
      logger.info('MCP stdio shutdown started', { reason });
      closing = (async () => {
        await runtime.drain();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await server.close();
        await runtime.close();
      })();
    }
    return closing;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    void close(signal).then(() => process.exit(0), (error) => {
      logger.error('MCP shutdown failed', error instanceof Error ? error.message : String(error));
      process.exit(6);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.stdin.once('end', () => void close('stdin-eof'));
  try {
    await server.connect(transport);
    logger.info('MCP stdio ready');
    await new Promise<void>((resolve, reject) => {
      transport.onclose = resolve;
      transport.onerror = reject;
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await close('transport-close');
  }
}

function toStructured(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && !Array.isArray(value) && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return { value };
}
