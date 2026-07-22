import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const outputUrl = new URL('../docs/mcp-runtime-sbom.json', import.meta.url);
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const metafile = JSON.parse(await readFile(new URL('../dist/mcp.meta.json', import.meta.url), 'utf8'));
const packageLocations = Object.keys(lock.packages)
  .filter((location) => location.includes('node_modules/'))
  .sort((left, right) => right.length - left.length);
const components = new Map();
const inputs = [];

for (const path of Object.keys(metafile.inputs).sort()) {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized.includes('/node_modules/') && !normalized.startsWith('node_modules/')) continue;
  if (normalized.toLowerCase().includes('hono')) throw new Error(`forbidden Hono input entered the stdio MCP bundle: ${normalized}`);
  const location = packageLocations.find((candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`));
  if (!location) throw new Error(`bundle input is absent from the exact lock: ${normalized}`);
  const entry = lock.packages[location];
  if (!entry.version || !entry.integrity || !entry.resolved || !entry.license) {
    throw new Error(`bundle component lacks version/integrity/source/license: ${location}`);
  }
  const manifest = JSON.parse(await readFile(new URL(`../${location}/package.json`, import.meta.url), 'utf8'));
  if (manifest.version !== entry.version || manifest.license !== entry.license) throw new Error(`installed bundle input drifted from lock: ${location}`);
  components.set(location, {
    location,
    name: manifest.name,
    version: entry.version,
    integrity: entry.integrity,
    license: entry.license,
    resolved: entry.resolved,
  });
  const bytes = await readFile(new URL(`../${normalized}`, import.meta.url));
  inputs.push({ path: normalized, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const packages = [...components.values()].sort((left, right) => left.location.localeCompare(right.location));
if (!packages.some(({ name, version }) => name === '@modelcontextprotocol/sdk' && version === '1.29.0')) {
  throw new Error('stdio bundle does not contain exact MCP SDK 1.29.0');
}
if (packages.some(({ name }) => name.includes('hono'))) throw new Error('Hono package entered the stdio runtime SBOM');
const artifact = {};
for (const path of ['dist/mcp.js', 'dist/mcp.js.map', 'dist/mcp.meta.json']) {
  const bytes = await readFile(new URL(`../${path}`, import.meta.url));
  artifact[path] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const inventory = {
  schemaVersion: 1,
  artifact: 'Seedbed stdio-only MCP runtime bundle',
  builder: 'esbuild@0.28.1',
  sourcePackage: '@modelcontextprotocol/sdk@1.29.0',
  externalized: ['@gnolith/diamond', '@gnolith/taproot', '@gnolith/workshop', 'node:*'],
  packageCount: packages.length,
  packages,
  inputCount: inputs.length,
  inputs,
  outputs: artifact,
};
const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
if (process.argv[2] === '--write') {
  await writeFile(outputUrl, serialized);
  process.stdout.write(`wrote MCP runtime SBOM (${packages.length} packages, ${inputs.length} inputs)\n`);
} else if (process.argv[2] === '--verify') {
  const existing = await readFile(outputUrl, 'utf8');
  if (existing !== serialized) throw new Error('MCP runtime SBOM is stale; run npm run bundle:inventory');
  const code = await readFile(new URL('../dist/mcp.js', import.meta.url), 'utf8');
  if (/hono|StreamableHTTP|serve-static/iu.test(code)) throw new Error('HTTP/Hono bytes entered the stdio MCP runtime bundle');
  process.stderr.write(`verified MCP runtime SBOM (${packages.length} packages, ${inputs.length} inputs)\n`);
} else {
  throw new Error('usage: bundled-runtime-inventory.mjs --write|--verify');
}
