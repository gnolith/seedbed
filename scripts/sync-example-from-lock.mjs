import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('.');
const examplePath = resolve(root, 'examples', 'seedbed.config.example.json');
const lock = JSON.parse(await readFile(resolve(root, 'seedbed-component-lock.json'), 'utf8'));
const example = JSON.parse(await readFile(examplePath, 'utf8'));

const expected = {
  ...example,
  packages: lock.packages,
  compose: {
    ...example.compose,
    publishIpv6Loopback: lock.compose.publishIpv6Loopback,
    profiles: lock.compose.profiles,
    nodeImage: lock.compose.nodeImage,
    qdrantImage: lock.compose.qdrantImage,
  },
  migrations: lock.migrations,
  backup: lock.backup,
};
const encoded = `${JSON.stringify(expected, null, 2)}\n`;

if (process.argv.includes('--write')) {
  await writeFile(examplePath, encoded, { encoding: 'utf8', mode: 0o600 });
  console.log('synchronized examples/seedbed.config.example.json from the component lock');
} else {
  const lockBound = {
    packages: example.packages,
    compose: {
      publishIpv6Loopback: example.compose.publishIpv6Loopback,
      profiles: example.compose.profiles,
      nodeImage: example.compose.nodeImage,
      qdrantImage: example.compose.qdrantImage,
    },
    migrations: example.migrations,
    backup: example.backup,
  };
  const expectedLockBound = {
    packages: lock.packages,
    compose: {
      publishIpv6Loopback: lock.compose.publishIpv6Loopback,
      profiles: lock.compose.profiles,
      nodeImage: lock.compose.nodeImage,
      qdrantImage: lock.compose.qdrantImage,
    },
    migrations: lock.migrations,
    backup: lock.backup,
  };
  if (JSON.stringify(lockBound) !== JSON.stringify(expectedLockBound)) {
    throw new Error('examples/seedbed.config.example.json is stale; run npm run sync:example');
  }
  const coordinatesByArtifact = new Map(
    Object.values(lock.packages).map((coordinate) => [coordinate.artifact, coordinate]),
  );
  for (const directory of ['examples', 'fixtures']) {
    for (const path of await jsonFiles(resolve(root, directory))) {
      assertCurrentCoordinates(JSON.parse(await readFile(path, 'utf8')), path, coordinatesByArtifact);
    }
  }
  console.log('verified the shipped config example is generated from the component lock');
}

async function jsonFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await jsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(path);
  }
  return paths;
}

function assertCurrentCoordinates(value, path, coordinatesByArtifact) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && typeof value.artifact === 'string' && coordinatesByArtifact.has(value.artifact)) {
    const expected = coordinatesByArtifact.get(value.artifact);
    for (const field of ['version', 'artifact', 'sha256', 'sourceCommit']) {
      if (value[field] !== expected[field]) throw new Error(`${path} contains a superseded ${value.artifact} coordinate`);
    }
  }
  for (const nested of Object.values(value)) assertCurrentCoordinates(nested, path, coordinatesByArtifact);
}
