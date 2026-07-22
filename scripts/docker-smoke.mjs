import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const image = process.env.SEEDBED_TEST_IMAGE ?? 'seedbed:test';
const volume = `seedbed-test-${randomUUID()}`;
const secretVolume = `seedbed-secret-${randomUUID()}`;
const wrongSecretVolume = `seedbed-wrong-secret-${randomUUID()}`;
const container = `seedbed-signal-${randomUUID()}`;
const fixture = await mkdtemp(join(tmpdir(), 'seedbed-docker-secret-'));
const secret = join(fixture, 'root.key');
const wrongSecret = join(fixture, 'wrong.key');
await writeFile(secret, Buffer.alloc(32, 0x44), { mode: 0o600 });
await writeFile(wrongSecret, Buffer.alloc(32, 0x45), { mode: 0o600 });
const baseEnvironment = ['-e', 'SEEDBED_BASE_IRI=https://docker.seedbed.test/instance/', '-e', 'SEEDBED_ROOT_SECRET_FILE=/run/secrets/seedbed-root', '-e', 'SEEDBED_PRINCIPAL_SELECTOR=agent', '-e', 'SEEDBED_WORKSPACE_SELECTOR=workspace', '-e', 'SEEDBED_LOG_LEVEL=silent'];
const secretMount = ['-v', `${secretVolume}:/run/secrets:ro`];
let client;

try {
  const installed = JSON.parse(docker(['run', '--rm', '--entrypoint', 'node', image, '-e', `
    const fs = require('fs');
    const versions = {};
    for (const name of ['diamond', 'taproot', 'workshop', 'seedbed']) {
      versions[name] = JSON.parse(fs.readFileSync('/opt/seedbed/node_modules/@gnolith/' + name + '/package.json')).version;
    }
    process.stdout.write(JSON.stringify(versions));
  `]).stdout);
  const expectedVersions = { diamond: '0.4.0', taproot: '0.3.0', workshop: '0.3.3', seedbed: '0.2.0' };
  if (JSON.stringify(installed) !== JSON.stringify(expectedVersions)) {
    throw new Error(`image package tuple is ${JSON.stringify(installed)}; expected ${JSON.stringify(expectedVersions)}`);
  }
  if (process.env.SEEDBED_CLOSURE_SHA256) {
    const expectedClosure = process.env.SEEDBED_CLOSURE_SHA256;
    const label = docker(['image', 'inspect', image, '--format', '{{index .Config.Labels "org.gnolith.production-closure.sha256"}}']).stdout.trim();
    if (label !== expectedClosure) throw new Error(`image closure label ${label} does not match ${expectedClosure}`);
    const archive = docker(['run', '--rm', '--entrypoint', 'sha256sum', image,
      '/opt/seedbed/production-closure.tar.gz',
    ]).stdout.trim().split(/\s+/u)[0];
    if (archive !== expectedClosure) throw new Error(`image closure archive ${archive} does not match ${expectedClosure}`);
    docker(['run', '--rm', '--entrypoint', 'sh', image, '-c',
      'cd /opt/seedbed && node verify-production-tree.mjs --verify .',
    ]);
  }
  docker(['volume', 'create', volume]);
  docker(['volume', 'create', secretVolume]);
  docker(['volume', 'create', wrongSecretVolume]);
  const uid = docker(['run', '--rm', '--entrypoint', 'id', image, '-u']).stdout.trim();
  const gid = docker(['run', '--rm', '--entrypoint', 'id', image, '-g']).stdout.trim();
  if (uid === '0') throw new Error('image runs as root');
  stageSecret(secretVolume, secret, uid, gid);
  stageSecret(wrongSecretVolume, wrongSecret, uid, gid);
  const exposed = docker(['image', 'inspect', image, '--format', '{{json .Config.ExposedPorts}}']).stdout.trim();
  if (exposed !== 'null') throw new Error(`image exposes ports: ${exposed}`);
  const mount = ['-v', `${volume}:/var/lib/seedbed`];
  docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'init']);
  docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'auth', 'bootstrap']);
  docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'call', 'upsert_memory', '--arguments', '{"slug":"docker-restart","description":"Docker restart","content":"Durable"}']);
  const reopened = docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'call', 'get_memory', '--arguments', '{"slug":"docker-restart"}']);
  if (!reopened.stdout.includes('docker-restart')) throw new Error('replacement container did not retain authorized content');
  const wrongMount = ['-v', `${wrongSecretVolume}:/run/secrets:ro`];
  const rejected = docker(['run', '--rm', ...mount, ...wrongMount, ...baseEnvironment, image, 'call', 'get_memory', '--arguments', '{"slug":"docker-restart"}'], false);
  if (rejected.status === 0 || !rejected.stderr.includes('Root secret does not match')) throw new Error('replacement container accepted the wrong root secret');

  const transport = new StdioClientTransport({
    command: 'docker',
    args: ['run', '--name', container, '-i', ...mount, ...secretMount, ...baseEnvironment, image, 'mcp', '--stdio'],
    stderr: 'pipe',
  });
  client = new Client({ name: 'seedbed-docker-signal-test', version: '1.0.0' });
  await client.connect(transport);
  const socketTables = docker(['exec', container, 'cat', '/proc/net/tcp', '/proc/net/tcp6']).stdout;
  const listeners = socketTables.split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length > 3 && fields[3] === '0A');
  if (listeners.length !== 0) throw new Error(`headless MCP container opened ${listeners.length} listening TCP socket(s)`);
  let settled = 0;
  const inFlight = Array.from({ length: 10 }, (_, index) => client.callTool({ name: 'upsert_memory', arguments: { slug: `signal-${index}`, description: 'Signal test', content: 'Durable' } }).finally(() => { settled += 1; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (settled === inFlight.length) throw new Error('signal test did not catch an operation in flight');
  docker(['stop', '--time', '10', container]);
  const drained = await Promise.allSettled(inFlight);
  if (drained.some(({ status }) => status === 'rejected')) throw new Error('SIGTERM rejected an in-flight operation');
  const exitCode = docker(['inspect', container, '--format', '{{.State.ExitCode}}']).stdout.trim();
  if (exitCode !== '0') throw new Error(`SIGTERM shutdown exited ${exitCode}`);
  const afterSignal = docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'doctor']);
  if (!JSON.parse(afterSignal.stdout).ready) throw new Error('database did not reopen after in-flight SIGTERM drain');
} finally {
  await client?.close().catch(() => undefined);
  docker(['rm', '--force', container], false);
  docker(['volume', 'rm', volume], false);
  docker(['volume', 'rm', secretVolume], false);
  docker(['volume', 'rm', wrongSecretVolume], false);
  await rm(fixture, { recursive: true, force: true });
}

function stageSecret(targetVolume, source, uid, gid) {
  docker(['run', '--rm', '--user', '0:0', '--entrypoint', 'sh',
    '-v', `${targetVolume}:/secret`, '-v', `${source}:/input:ro`, image,
    '-c', `install -o ${uid} -g ${gid} -m 0400 /input /secret/seedbed-root`,
  ]);
}

function docker(args, required = true) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (required && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}
