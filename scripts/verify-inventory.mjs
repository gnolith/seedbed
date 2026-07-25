import { readFile, readdir } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.version !== '0.4.0') throw new Error('candidate version must be 0.4.0');
if (manifest.dependencies && Object.keys(manifest.dependencies).length !== 0) throw new Error('Seedbed must have no runtime package dependencies');
for (const removed of ['src/mcp.ts', 'src/runtime.ts', 'src/authorization.ts', 'src/snapshot.ts', 'src/taproot-runtime.ts', 'Dockerfile', '.github/workflows/release.yml']) {
  if (await exists(removed)) throw new Error(`removed application surface is present: ${removed}`);
}
const files = await walk('src');
const forbiddenImports = /(?:from\s+|import\s*(?:\(\s*)?)['"](?:@modelcontextprotocol|@gnolith\/(?:diamond|taproot|workshop)|node:sqlite)/u;
for (const file of files) {
  if (forbiddenImports.test(await readFile(file, 'utf8'))) throw new Error(`private/runtime dependency import in ${file}`);
}
for (const forbiddenCli of ['gnolith-taproot', 'gnolith-diamond']) {
  for (const file of files) {
    if ((await readFile(file, 'utf8')).includes(forbiddenCli)) throw new Error(`owner CLI assumption remains in ${file}: ${forbiddenCli}`);
  }
}
if (await exists('dist')) {
  const built = await walk('dist');
  for (const removed of ['mcp.js', 'runtime.js', 'authorization.js', 'snapshot.js', 'taproot-runtime.js', 'adapter.js', 'persistence.js', 'lifecycle.js']) {
    if (built.some((file) => file.endsWith(`/${removed}`))) throw new Error(`removed built application surface is present: ${removed}`);
  }
}
const cli = await readFile('src/cli.ts', 'utf8');
for (const command of ['mcp --stdio', "'tools'", "'call'", "'serve'"]) {
  if (cli.includes(command)) throw new Error(`removed CLI surface remains: ${command}`);
}
for (const file of ['docker/operator-runner.mjs', 'docker/workshop-local-adapter.mjs']) {
  const source = await readFile(file, 'utf8');
  if (/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/u.test(source)) {
    throw new Error(`owner SQL leaked into assembly plumbing: ${file}`);
  }
  if (/\b(?:create_item|create_task|upsert_memory|search_entities|execute_sparql)\b/u.test(source)) {
    throw new Error(`domain operation mapping leaked into assembly plumbing: ${file}`);
  }
}
const adapter = await readFile('docker/workshop-local-adapter.mjs', 'utf8');
if (!adapter.includes('createWorkshopLocalExecutableAdapterFromPrimitivesV1') || adapter.includes('registrationContext')) {
  throw new Error('local adapter must use the sealed Workshop factory without caller-authored authorization context');
}
console.log(`verified installation-only inventory (${files.length} source files)`);

async function exists(path) {
  return readFile(path).then(() => true).catch(() => false);
}
async function walk(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await walk(child));
    else result.push(child);
  }
  return result;
}
