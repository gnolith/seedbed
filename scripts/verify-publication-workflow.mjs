import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

const path = '.github/workflows/registry.yml';
const source = await readFile(path, 'utf8');
const workflow = YAML.parse(source);
const dispatch = workflow.on?.workflow_dispatch;
if (dispatch === undefined) throw new Error('public npm workflow must remain manually dispatched');
for (const input of ['commit', 'package_sha256', 'confirmation']) {
  if (dispatch.inputs?.[input]?.required !== true) throw new Error(`public npm workflow requires ${input}`);
}
if (workflow.permissions?.contents !== 'read' || workflow.permissions?.['id-token'] !== 'write') {
  throw new Error('public npm workflow must use read-only contents plus OIDC id-token permission');
}
const publish = workflow.jobs?.publish;
if (
  publish === undefined
  || publish.environment !== 'npm'
  || publish.if !== "github.ref == 'refs/heads/main'"
) throw new Error('public npm workflow must be main-only and environment-bound');
const steps = publish.steps ?? [];
for (const step of steps) {
  if (step.uses?.startsWith('actions/') && !/@[0-9a-f]{40}$/u.test(step.uses)) {
    throw new Error(`public npm workflow uses a mutable action: ${step.uses}`);
  }
}
const commands = steps.map((step) => step.run ?? '').join('\n');
for (const required of [
  'npm run candidate',
  'sha256sum --check',
  'candidate.releaseCreated !== false',
  'candidate.imagePublished !== false',
  "manifest.publishConfig?.access !== 'public'",
  "manifest.publishConfig?.provenance !== true",
  "npm view '@gnolith/seedbed@0.4.0'",
  'npm publish "$package" --access public --provenance',
  'unset NODE_AUTH_TOKEN NPM_TOKEN',
  'git rev-parse origin/main',
]) {
  if (!commands.includes(required)) throw new Error(`public npm workflow omits release control: ${required}`);
}
if (/(?:NODE_AUTH_TOKEN|NPM_TOKEN)\s*:\s*\$\{\{\s*secrets\./u.test(source)) {
  throw new Error('public npm workflow must use trusted publishing, not a registry token');
}
if (/\b(?:git\s+tag|gh\s+release|docker\s+(?:push|buildx.*--push))\b/u.test(commands)) {
  throw new Error('public npm workflow crosses the tag, Release, or image boundary');
}
console.log('verified manual main-only public npm OIDC trusted-publisher workflow');
