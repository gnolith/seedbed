#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  applyTaprootAuthorizationBackfill,
  inspectTaprootAuthorizationReadiness,
  planTaprootAuthorizationBackfill,
  type AuthorizationBackfillEntityInput,
} from '@gnolith/taproot';
import { backfillWorkshopAuthorizationBatch, inspectWorkshopAuthorizationReadiness } from '@gnolith/workshop/server';
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
import {
  bootstrapAuthorization,
  openAuthorization,
  replacePrincipalAuthorization,
  type PrincipalAuthorizationUpdate,
} from './authorization.js';
import { requireBaseIri } from './config.js';
import {
  createInstallationSnapshot,
  inspectInstallationSnapshot,
  restoreInstallationSnapshot,
} from './snapshot.js';

const help = `Usage: seedbed [global options] <command> [command options]

Headless commands:
  init                         initialize a brand-new database
  migrate                      explicitly advance an existing database
  doctor                       print persistence readiness as JSON
  auth bootstrap               establish installation, principal, workspace, and exact grants
  auth status                  inspect Taproot and Workshop authorization quarantine
  auth apply --manifest <path>   declaratively replace one principal's authorization
  auth backfill taproot --manifest <path>
  auth backfill workshop --domain <task|memory>
  snapshot create --output <path>  create a consistent secret-free installation snapshot
  snapshot inspect --input <path>  print a snapshot manifest without restoring it
  snapshot verify --input <path>   verify every database/blob checksum
  snapshot restore --input <path>  restore into an empty native installation
  mcp --stdio                  run MCP over stdin/stdout
  tools                        list authorized tools as JSON
  call <name> [--arguments J]  call one tool and print JSON

Global options:
  --config <path>
  --database <path>
  --blobs <path>
  --busy-timeout-ms <milliseconds>
  --base-iri <absolute-http(s)-url>
  --root-secret-file <path>    selector for an exact 32-byte secret file
  --root-secret-fd <number>    selector for an inherited secret descriptor
  --principal <selector>
  --workspace <selector>
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
    process.stdout.write('0.2.2\n');
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
    case 'auth':
      return runAuthorizationCommand(parsed.args, config, taproot);
    case 'snapshot':
      return runSnapshotCommand(parsed.args, config, taproot);
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
      case '--blobs': config.blobPath = value; break;
      case '--busy-timeout-ms': config.busyTimeoutMs = value; break;
      case '--base-iri': config.baseIri = value; break;
      case '--root-secret-file': config.rootSecretFile = value; break;
      case '--root-secret-fd': config.rootSecretFd = value; break;
      case '--principal': config.principalSelector = value; break;
      case '--workspace': config.workspaceSelector = value; break;
      case '--log-level': config.logLevel = value; break;
      case '--shutdown-timeout-ms': config.shutdownTimeoutMs = value; break;
      default: usage(`Unknown global option ${option}`);
    }
  }
  const command = argv[index];
  if (!command) usage('A command is required');
  return { command, args: argv.slice(index + 1), config };
}

async function runSnapshotCommand(
  args: string[],
  config: Awaited<ReturnType<typeof loadConfig>>,
  taproot: Awaited<ReturnType<typeof loadTaprootAssembly>>,
): Promise<number> {
  const subcommand = args[0];
  const flag = subcommand === 'create' ? '--output' : '--input';
  if (!['create', 'inspect', 'verify', 'restore'].includes(subcommand ?? '') || args.length !== 3 || args[1] !== flag || !args[2]) {
    usage('snapshot requires create --output <path>, inspect --input <path>, verify --input <path>, or restore --input <path>');
  }
  const path = args[2]!;
  const result = subcommand === 'create'
    ? await createInstallationSnapshot(config, taproot, path)
    : subcommand === 'restore'
      ? await restoreInstallationSnapshot(config, taproot, path)
      : await inspectInstallationSnapshot(path, subcommand === 'verify');
  printJson(result);
  return ExitCode.success;
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

async function runAuthorizationCommand(
  args: string[],
  config: Awaited<ReturnType<typeof loadConfig>>,
  taproot: Awaited<ReturnType<typeof loadTaprootAssembly>>,
): Promise<number> {
  const subcommand = args[0];
  if (!config.principalSelector || !config.workspaceSelector) usage('auth commands require --principal and --workspace selectors');
  const db = await openDatabase(config);
  try {
    if (subcommand === 'bootstrap') {
      if (args.length !== 1) usage('auth bootstrap accepts no command arguments');
      await bootstrapAuthorization(db, config, config.principalSelector, config.workspaceSelector);
      printJson({ bootstrapped: true, principalSelector: config.principalSelector, workspaceSelector: config.workspaceSelector });
      return ExitCode.success;
    }
    const bundle = await openAuthorization(db, config);
    const context = await bundle.resolveContext(config.principalSelector, config.workspaceSelector);
    if (subcommand === 'status') {
      if (args.length !== 1) usage('auth status accepts no command arguments');
      requireSearchAdministration(context);
      const [authorization, taprootStatus, workshopStatus] = await Promise.all([
        bundle.authorizationGuard.readCurrentState(),
        inspectTaprootAuthorizationReadiness(db, { baseIri: requireBaseIri(config) }, bundle.hostCapability, context),
        inspectWorkshopAuthorizationReadiness(bundle.persistence),
      ]);
      printJson({ installationId: bundle.installationId, authorization, taproot: taprootStatus, workshop: workshopStatus });
      return taprootStatus.ready && workshopStatus.ready ? ExitCode.success : ExitCode.authorization;
    }
    if (subcommand === 'apply') {
      if (args.length !== 3 || args[1] !== '--manifest') usage('auth apply --manifest <path>');
      const update = parsePrincipalAuthorizationManifest(await readFile(args[2]!, 'utf8'));
      const applied = await replacePrincipalAuthorization(
        db,
        config,
        config.principalSelector,
        config.workspaceSelector,
        update,
      );
      printJson({ applied: true, ...applied });
      return ExitCode.success;
    }
    if (subcommand === 'backfill' && args[1] === 'workshop') {
      if (args.length !== 4 || args[2] !== '--domain' || !['task', 'memory'].includes(args[3]!)) usage('auth backfill workshop --domain <task|memory>');
      requireSearchAdministration(context);
      const result = await backfillWorkshopAuthorizationBatch(bundle.persistence, bundle.authority, context, { domain: args[3] as 'task' | 'memory' });
      printJson(result);
      return ExitCode.success;
    }
    if (subcommand === 'backfill' && args[1] === 'taproot') {
      if (args.length !== 4 || args[2] !== '--manifest') usage('auth backfill taproot --manifest <path>');
      requireSearchAdministration(context);
      const raw: unknown = JSON.parse(await readFile(args[3]!, 'utf8'));
      if (!Array.isArray(raw)) usage('Taproot backfill manifest must be a JSON array');
      const plan = await planTaprootAuthorizationBackfill(db, { baseIri: requireBaseIri(config) }, bundle.hostCapability, context, raw as AuthorizationBackfillEntityInput[]);
      const result = await applyTaprootAuthorizationBackfill(db, { baseIri: requireBaseIri(config) }, bundle.hostCapability, context, plan.planId);
      printJson(result);
      return ExitCode.success;
    }
    usage('auth requires bootstrap, apply, status, or backfill');
  } finally {
    await db.close();
  }
}

function parsePrincipalAuthorizationManifest(source: string): PrincipalAuthorizationUpdate {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    usage(`Invalid authorization manifest JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') usage('Authorization manifest must be a JSON object');
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expectedKeys = ['capabilities', 'enabled', 'expectedAuthorizationRevision', 'principal', 'version', 'workspaces'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) usage(`Authorization manifest must contain exactly: ${expectedKeys.join(', ')}`);
  if (value.version !== 1) usage('Authorization manifest version must be 1');
  if (!Number.isSafeInteger(value.expectedAuthorizationRevision) || (value.expectedAuthorizationRevision as number) < 1) {
    usage('Authorization manifest expectedAuthorizationRevision must be a positive safe integer');
  }
  if (typeof value.principal !== 'string') usage('Authorization manifest principal must be a string');
  if (typeof value.enabled !== 'boolean') usage('Authorization manifest enabled must be a boolean');
  if (!Array.isArray(value.workspaces) || value.workspaces.some((entry) => typeof entry !== 'string')) {
    usage('Authorization manifest workspaces must be an array of strings');
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.some((entry) => typeof entry !== 'string')) {
    usage('Authorization manifest capabilities must be an array of strings');
  }
  return {
    expectedAuthorizationRevision: value.expectedAuthorizationRevision as number,
    principalSelector: value.principal,
    enabled: value.enabled,
    workspaceSelectors: value.workspaces as string[],
    capabilities: value.capabilities as string[],
  };
}

function requireSearchAdministration(context: { capabilities: readonly string[] }): void {
  if (!context.capabilities.includes('search:admin')) throw new SeedbedError('Exact search:admin capability is required', ExitCode.authorization, 'forbidden');
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

