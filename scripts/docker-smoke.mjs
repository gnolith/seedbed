import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const image = process.env.SEEDBED_TEST_IMAGE ?? 'seedbed:test';
const volume = `seedbed-test-${randomUUID()}`;
const container = `seedbed-signal-${randomUUID()}`;
const baseEnvironment = ['-e', 'SEEDBED_BASE_IRI=https://docker.seedbed.test/instance/', '-e', 'SEEDBED_LOG_LEVEL=silent'];

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
  docker(['run', '--name', container, '-d', '-i', ...mount, ...baseEnvironment, image, 'mcp', '--stdio']);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  docker(['stop', '--time', '10', container]);
  const exitCode = docker(['inspect', container, '--format', '{{.State.ExitCode}}']).stdout.trim();
  if (exitCode !== '0') throw new Error(`SIGTERM shutdown exited ${exitCode}`);
} finally {
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
