#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadConfig, type ConfigOverrides } from './config.js';
import { ExitCode, SeedbedError } from './errors.js';
import { createLogger } from './logger.js';
import { runMcpStdio } from './mcp.js';
import {
  databaseExists,
  initializeDatabase,
  inspectReadiness,
  migrateDatabase,
  openDatabase,
} from './persistence.js';
import { createSeedbedRuntime } from './runtime.js';
import { loadTaprootAssembly } from './taproot-bridge.js';

const help = `Usage: seedbed [global options] <command> [command options]

Headless commands:
  init                         initialize a brand-new database
  migrate                      explicitly advance an existing database
  doctor                       print persistence readiness as JSON
  mcp --stdio                  run MCP over stdin/stdout
  tools                        list authorized tools as JSON
  call <name> [--arguments J]  call one tool and print JSON
  sparql <query>               execute a read-only SPARQL query and print JSON
  sparql --file <path>         read the query from a file

Global options:
  --config <path>
  --database <path>
  --base-iri <absolute-http(s)-url>
  --local-owner <principal-id>
  --log-level <silent|error|warn|info|debug>
  --shutdown-timeout-ms <milliseconds>
  --help
  --version

Configuration precedence: CLI > SEEDBED_* environment > seedbed.config.json > defaults.
Runtime commands never initialize or migrate persistence.`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv[0] === 'help' || argv.length === 0) {
    process.stdout.write(`${help}\n`);
    return ExitCode.success;
  }
  if (argv.includes('--version')) {
    process.stdout.write('0.1.0\n');
    return ExitCode.success;
  }
  const parsed = parseGlobal(argv);
  const config = await loadConfig(parsed.config);
  const logger = createLogger(config.logLevel);
  const taproot = await loadTaprootAssembly();
  switch (parsed.command) {
    case 'init':
      printJson(await initializeDatabase(config, taproot));
      return ExitCode.success;
    case 'migrate':
      printJson(await migrateDatabase(config, taproot));
      return ExitCode.success;
    case 'doctor': {
      if (!(await databaseExists(config.databasePath))) {
        printJson({ ready: false, databasePath: config.databasePath, assembly: 'missing', remediation: 'run seedbed init' });
        return ExitCode.persistence;
      }
      const db = await openDatabase(config);
      try {
        const status = await inspectReadiness(db, config, taproot);
        printJson(status);
        return status.ready ? ExitCode.success : ExitCode.persistence;
      } finally {
        await db.close();
      }
    }
    case 'mcp':
      if (parsed.args.length !== 1 || parsed.args[0] !== '--stdio') usage('mcp requires exactly --stdio');
      await runMcpStdio(await createSeedbedRuntime(config, taproot), logger);
      return ExitCode.success;
    case 'tools': {
      if (parsed.args.length !== 0) usage('tools accepts no arguments');
      const runtime = await createSeedbedRuntime(config, taproot);
      try {
        const result = runtime.dispatcher.listTools(runtime.principal);
        if (!result.ok) throw dispatchError(result.failure.kind, result.failure.error.message);
        printJson({ tools: result.value });
        return ExitCode.success;
      } finally {
        await runtime.close();
      }
    }
    case 'call': {
      const { name, argumentsValue } = parseCall(parsed.args);
      const runtime = await createSeedbedRuntime(config, taproot);
      try {
        const result = await runtime.lifecycle.run(() => runtime.dispatcher.callTool(
          { name, arguments: argumentsValue },
          { principal: runtime.principal, requestId: randomUUID() },
        ));
        if (!result.ok) throw dispatchError(result.failure.kind, result.failure.error.message);
        printJson({ ok: true, value: result.value });
        return ExitCode.success;
      } finally {
        await runtime.close();
      }
    }
    case 'sparql': {
      const query = await parseSparql(parsed.args);
      const runtime = await createSeedbedRuntime(config, taproot);
      try {
        const result = await runtime.lifecycle.run(() => runtime.dispatcher.callTool(
          { name: 'query_sparql', arguments: { sparql: query } },
          { principal: runtime.principal, requestId: randomUUID() },
        ));
        if (!result.ok) throw dispatchError(result.failure.kind, result.failure.error.message);
        printJson({ ok: true, value: result.value });
        return ExitCode.success;
      } finally {
        await runtime.close();
      }
    }
    default:
      usage(`Unknown command ${parsed.command}`);
  }
}

interface ParsedArguments { command: string; args: string[]; config: ConfigOverrides }

function parseGlobal(argv: string[]): ParsedArguments {
  const config: ConfigOverrides = {};
  let index = 0;
  while (index < argv.length && argv[index]?.startsWith('--')) {
    const option = argv[index++]!;
    const value = argv[index++];
    if (!value) usage(`${option} requires a value`);
    switch (option) {
      case '--config': config.configPath = value; break;
      case '--database': config.databasePath = value; break;
      case '--base-iri': config.baseIri = value; break;
      case '--local-owner': config.localOwnerId = value; break;
      case '--log-level': config.logLevel = value; break;
      case '--shutdown-timeout-ms': config.shutdownTimeoutMs = value; break;
      default: usage(`Unknown global option ${option}`);
    }
  }
  const command = argv[index];
  if (!command) usage('A command is required');
  return { command, args: argv.slice(index + 1), config };
}

function parseCall(args: string[]): { name: string; argumentsValue: Record<string, unknown> } {
  const name = args[0];
  if (!name) usage('call requires a tool name');
  if (args.length === 1) return { name, argumentsValue: {} };
  if (args.length !== 3 || args[1] !== '--arguments') usage('call syntax is: call <name> [--arguments <json-object>]');
  try {
    const parsed: unknown = JSON.parse(args[2]!);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') usage('--arguments must be a JSON object');
    return { name, argumentsValue: parsed as Record<string, unknown> };
  } catch (error) {
    if (error instanceof SeedbedError) throw error;
    usage(`Invalid --arguments JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function parseSparql(args: string[]): Promise<string> {
  if (args.length === 2 && args[0] === '--file') return readFile(args[1]!, 'utf8');
  if (args.length === 0) usage('sparql requires a query or --file <path>');
  return args.join(' ');
}

function dispatchError(kind: string, message: string): SeedbedError {
  const exitCode = kind === 'unauthenticated' || kind === 'forbidden' ? ExitCode.authorization : ExitCode.operation;
  return new SeedbedError(message, exitCode, kind);
}

function usage(message: string): never {
  throw new SeedbedError(`${message}\n\n${help}`, ExitCode.usage, 'usage');
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    const normalized = error instanceof SeedbedError
      ? error
      : new SeedbedError(error instanceof Error ? error.message : String(error), ExitCode.operation, 'unexpected', { cause: error });
    process.stderr.write(`${JSON.stringify({ error: normalized.code, message: normalized.message })}\n`);
    process.exitCode = normalized.exitCode;
  },
);

