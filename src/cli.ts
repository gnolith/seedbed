#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, redactFilesystemPaths } from './canonical.js';
import { loadConfig } from './config.js';
import { validateConfig } from './config.js';
import { createOperatorOwnerPorts } from './owner-ports.js';
import { applyInstallationPlan, applyMigrationPlan, createInstallationPlan, createMigrationPlan } from './migration.js';
import { createInstallationBackup, dryRunRestore, inspectInstallationBackup, restoreInstallationBackup, verifyInstallationBackup } from './backup.js';
import { applyLegacyAdoption, loadLegacyManifest, planLegacyAdoption, type LegacyAdoptionPlan } from './adoption.js';
import { diagnoseInstallation } from './diagnostics.js';
import { OperatorAdoptionTarget, ComposeRestoreTarget, DockerComposeDriver, DockerDiagnosticHost } from './system-drivers.js';
import { OperatorLegacyDecoder } from './legacy-source.js';

const HELP = `seedbed 0.4.0

Usage:
  seedbed init --config <path> --from <canonical-config-template>
  seedbed plan --config <path> [--out <path>]
  seedbed apply --config <path> --plan <path>
  seedbed migrate plan --config <path> [--out <path>]
  seedbed migrate apply --config <path> --plan <path>
  seedbed doctor --config <path>
  seedbed backup create --config <path> --out <path>
  seedbed backup inspect --config <path> --archive <path>
  seedbed backup verify --config <path> --archive <path>
  seedbed backup restore --config <path> --archive <path> [--dry-run]
  seedbed adopt legacy-local plan --config <path> --manifest <path> [--out <path>]
  seedbed adopt legacy-local apply --config <path> --manifest <path> --plan <path>
  seedbed uninstall --config <path> --retain-data
`;

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write('0.4.0\n');
    return 0;
  }
  try {
    const parsed = parseArgs(argv);
    const configPath = required(parsed.options, 'config');
    if (parsed.command === 'init') {
      const template = JSON.parse(await readFile(required(parsed.options, 'from'), 'utf8'));
      const config = validateConfig(template, { projectDirectory: process.cwd() });
      await writeFile(configPath, `${canonicalJson(config)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await Promise.all([
        mkdir(config.paths.stateDirectory, { recursive: true, mode: 0o700 }),
        mkdir(config.paths.dataDirectory, { recursive: true, mode: 0o700 }),
        mkdir(config.paths.backupDirectory, { recursive: true, mode: 0o700 }),
      ]);
      return output({ initialized: true, configDigest: createInstallationPlan(config).configDigest, secretCreated: false });
    }
    const config = await loadConfig(configPath);
    const compose = new DockerComposeDriver();
    const ports = createOperatorOwnerPorts(config, compose);
    switch (parsed.command) {
      case 'plan': {
        const plan = createInstallationPlan(config);
        await outputOrWrite(plan, parsed.options.out);
        return 0;
      }
      case 'apply': {
        const plan = JSON.parse(await readFile(required(parsed.options, 'plan'), 'utf8'));
        return output(await applyInstallationPlan({ config, plan, ports, compose }));
      }
      case 'migrate plan': {
        const plan = createMigrationPlan(config);
        await outputOrWrite(plan, parsed.options.out);
        return 0;
      }
      case 'migrate apply': {
        const plan = JSON.parse(await readFile(required(parsed.options, 'plan'), 'utf8'));
        return output(await applyMigrationPlan({ config, plan, ports, compose }));
      }
      case 'doctor':
        return output(await diagnoseInstallation({ config, ports, compose, host: new DockerDiagnosticHost() }));
      case 'backup create':
        return output(await createInstallationBackup({ config, ports, destination: required(parsed.options, 'out') }));
      case 'backup inspect':
        return output(await inspectInstallationBackup(required(parsed.options, 'archive'), config));
      case 'backup verify':
        return output(await verifyInstallationBackup(required(parsed.options, 'archive'), config, ports));
      case 'backup restore': {
        const archive = required(parsed.options, 'archive');
        if (parsed.flags.has('dry-run')) return output(await dryRunRestore(archive, config, ports));
        return output(await restoreInstallationBackup({ path: archive, config, ports, target: new ComposeRestoreTarget(config, compose) }));
      }
      case 'adopt legacy-local plan': {
        const manifest = await loadLegacyManifest(required(parsed.options, 'manifest'));
        const plan = await planLegacyAdoption({ manifest, config, decoder: new OperatorLegacyDecoder(config, compose) });
        await outputOrWrite(plan, parsed.options.out);
        return 0;
      }
      case 'adopt legacy-local apply': {
        const manifest = await loadLegacyManifest(required(parsed.options, 'manifest'));
        const plan = JSON.parse(await readFile(required(parsed.options, 'plan'), 'utf8')) as LegacyAdoptionPlan;
        return output(await applyLegacyAdoption({ manifest, plan, config, decoder: new OperatorLegacyDecoder(config, compose), target: new OperatorAdoptionTarget(config, compose) }));
      }
      case 'uninstall':
        if (!parsed.flags.has('retain-data')) throw new TypeError('Only uninstall --retain-data is implemented');
        await compose.downRetainData(config);
        return output({ stopped: true, retainedData: true });
    }
    throw new TypeError('Unknown command');
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: 'seedbed_operation_failed', message: bounded(error) })}\n`);
    return 2;
  }
}

function parseArgs(argv: readonly string[]): { command: string; options: Record<string, string>; flags: Set<string> } {
  const commandParts: string[] = [];
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  let index = 0;
  while (index < argv.length && !argv[index]!.startsWith('--')) commandParts.push(argv[index++]!);
  while (index < argv.length) {
    const token = argv[index++]!;
    if (!token.startsWith('--') || token.length < 3) throw new TypeError('Invalid CLI argument');
    const key = token.slice(2);
    if (['dry-run', 'retain-data'].includes(key)) {
      flags.add(key);
      continue;
    }
    const value = argv[index++];
    if (!value || value.startsWith('--')) throw new TypeError(`Missing value for --${key}`);
    if (key in options) throw new TypeError(`Duplicate --${key}`);
    options[key] = resolve(value);
  }
  const command = commandParts.join(' ');
  const allowed = new Set([
    'init', 'plan', 'apply', 'migrate plan', 'migrate apply', 'doctor',
    'backup create', 'backup inspect', 'backup verify', 'backup restore',
    'adopt legacy-local plan', 'adopt legacy-local apply', 'uninstall',
  ]);
  if (!allowed.has(command)) throw new TypeError('Unknown command');
  const specification = COMMAND_ARGUMENTS[command]!;
  for (const option of Object.keys(options)) {
    if (!specification.options.includes(option)) throw new TypeError(`Unsupported --${option} for ${command}`);
  }
  for (const flag of flags) {
    if (!specification.flags.includes(flag)) throw new TypeError(`Unsupported --${flag} for ${command}`);
  }
  for (const requiredOption of specification.requiredOptions) {
    if (!(requiredOption in options)) throw new TypeError(`--${requiredOption} is required`);
  }
  for (const requiredFlag of specification.requiredFlags) {
    if (!flags.has(requiredFlag)) throw new TypeError(`--${requiredFlag} is required`);
  }
  return { command, options, flags };
}

const COMMAND_ARGUMENTS: Readonly<Record<string, {
  readonly options: readonly string[];
  readonly requiredOptions: readonly string[];
  readonly flags: readonly string[];
  readonly requiredFlags: readonly string[];
}>> = {
  init: commandArguments(['config', 'from']),
  plan: commandArguments(['config', 'out'], ['config']),
  apply: commandArguments(['config', 'plan']),
  'migrate plan': commandArguments(['config', 'out'], ['config']),
  'migrate apply': commandArguments(['config', 'plan']),
  doctor: commandArguments(['config']),
  'backup create': commandArguments(['config', 'out']),
  'backup inspect': commandArguments(['config', 'archive']),
  'backup verify': commandArguments(['config', 'archive']),
  'backup restore': commandArguments(['config', 'archive'], ['config', 'archive'], ['dry-run']),
  'adopt legacy-local plan': commandArguments(['config', 'manifest', 'out'], ['config', 'manifest']),
  'adopt legacy-local apply': commandArguments(['config', 'manifest', 'plan']),
  uninstall: commandArguments(['config'], ['config'], ['retain-data'], ['retain-data']),
};

function commandArguments(
  options: readonly string[],
  requiredOptions: readonly string[] = options,
  flags: readonly string[] = [],
  requiredFlags: readonly string[] = [],
) {
  return { options, requiredOptions, flags, requiredFlags };
}

async function outputOrWrite(value: unknown, path: string | undefined): Promise<void> {
  const encoded = `${canonicalJson(value)}\n`;
  if (path === undefined) process.stdout.write(encoded);
  else await writeFile(path, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function output(value: unknown): number {
  process.stdout.write(`${canonicalJson(value)}\n`);
  return 0;
}

function required(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new TypeError(`--${key} is required`);
  return value;
}

function bounded(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Operation failed';
  return redactFilesystemPaths(message.slice(0, 512));
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.exitCode = await runCli();
}
