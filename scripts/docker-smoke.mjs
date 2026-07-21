import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const image = process.env.SEEDBED_TEST_IMAGE ?? 'seedbed:test';
const volume = `seedbed-test-${randomUUID()}`;
const container = `seedbed-signal-${randomUUID()}`;
const baseEnvironment = ['-e', 'SEEDBED_BASE_IRI=https://docker.seedbed.test/instance/', '-e', 'SEEDBED_LOCAL_OWNER_ID=local-owner', '-e', 'SEEDBED_LOG_LEVEL=silent'];
let client;

try {
  docker(['volume', 'create', volume]);
  const uid = docker(['run', '--rm', '--entrypoint', 'id', image, '-u']).stdout.trim();
  if (uid === '0') throw new Error('image runs as root');
  const exposed = docker(['image', 'inspect', image, '--format', '{{json .Config.ExposedPorts}}']).stdout.trim();
  if (exposed !== 'null') throw new Error(`image exposes ports: ${exposed}`);
  const mount = ['-v', `${volume}:/var/lib/seedbed`];
  docker(['run', '--rm', ...mount, ...baseEnvironment, image, 'init']);
  docker(['run', '--rm', ...mount, ...baseEnvironment, image, 'call', 'create_item', '--arguments', '{}']);
  const reopened = docker(['run', '--rm', ...mount, ...baseEnvironment, image, 'sparql', 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1']);
  if (!reopened.stdout.includes('Q1')) throw new Error('replacement container did not retain Q1');

  const transport = new StdioClientTransport({
    command: 'docker',
    args: ['run', '--name', container, '-i', ...mount, ...baseEnvironment, image, 'mcp', '--stdio'],
    stderr: 'pipe',
  });
  client = new Client({ name: 'seedbed-docker-signal-test', version: '1.0.0' });
  await client.connect(transport);
  let settled = 0;
  const inFlight = Array.from({ length: 10 }, () => client.callTool({ name: 'create_item', arguments: {} }).finally(() => { settled += 1; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (settled === inFlight.length) throw new Error('signal test did not catch an operation in flight');
  docker(['stop', '--time', '10', container]);
  const drained = await Promise.allSettled(inFlight);
  if (drained.some(({ status }) => status === 'rejected')) throw new Error('SIGTERM rejected an in-flight operation');
  const exitCode = docker(['inspect', container, '--format', '{{.State.ExitCode}}']).stdout.trim();
  if (exitCode !== '0') throw new Error(`SIGTERM shutdown exited ${exitCode}`);
  const afterSignal = docker(['run', '--rm', ...mount, ...baseEnvironment, image, 'doctor']);
  if (!JSON.parse(afterSignal.stdout).ready) throw new Error('database did not reopen after in-flight SIGTERM drain');
} finally {
  await client?.close().catch(() => undefined);
  docker(['rm', '--force', container], false);
  docker(['volume', 'rm', volume], false);
}

function docker(args, required = true) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (required && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}
