/* global fetch */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [origin, tokenFlag, tokenPath, receiptPath] = process.argv.slice(2);
if (!origin || tokenFlag !== '--token-file' || !tokenPath || !receiptPath) {
  throw new Error(
    'usage: node scripts/verify-public-backup-fixture.mjs <origin> --token-file <path> <protected-fixture-receipt.json>',
  );
}
const ownerToken = (await readFile(tokenPath, 'utf8')).replace(/\r?\n$/u, '');
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
assert.equal(receipt.format, 'gnolith-workshop-public-backup-fixture-v1');

let requestId = 1;
const call = async (token, name, argumentsValue) => {
  const response = await fetch(`${origin.replace(/\/$/u, '')}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: { name, arguments: argumentsValue },
    }),
  });
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(body.result?.isError, false, `${name}: ${JSON.stringify(body)}`);
  return body.result.structuredContent;
};

const property = await call(ownerToken, 'get_entity', { entityId: 'P1' });
assert.match(JSON.stringify(property), /Fixture source/u);
const item = await call(ownerToken, 'get_entity', { entityId: 'Q1' });
const itemJson = JSON.stringify(item);
for (const expected of ['preferred', 'qualifiers', 'backup-fixture-reference'])
  assert.match(itemJson, new RegExp(expected, 'u'));

const resource = await call(ownerToken, 'get_resource', {
  resourceId: 'resource:backup-fixture',
});
assert.equal(resource.payload?.kind, 'inline-text');
assert.equal(resource.payload?.text, 'Inline backup fixture resource payload.');
const annotation = await call(ownerToken, 'get_annotation', {
  annotationId: 'annotation:backup-fixture',
});
assert.equal(annotation.target?.sourceId, 'resource:backup-fixture');

const task = await call(ownerToken, 'get_task', { taskId: receipt.taskId });
assert.ok(task.completedAt);
assert.equal(task.result, 'Backup fixture completed.');
assert.deepEqual(
  await call(ownerToken, 'complete_task', receipt.completionInput),
  task,
);
const memory = await call(ownerToken, 'get_memory', {
  slug: 'backup-fixture-memory',
});
assert.equal(memory.revision, 2);
const prompt = await call(ownerToken, 'get_prompt', {
  promptId: receipt.promptId,
});
assert.equal(prompt.revision, 2);

const delegatedStatus = await call(
  receipt.delegatedToken,
  'gnolith_status',
  {},
);
assert.equal(delegatedStatus.principalId, 'principal:backup-fixture');
await call(receipt.delegatedToken, 'authorization_admin', {
  version: 1,
  action: 'effective-policy',
  target: { kind: 'entity', id: 'Q1' },
});
const administration = await call(ownerToken, 'authorization_admin', {
  version: 1,
  action: 'status',
});
assert.ok(administration.value.principals >= 2);
assert.ok(administration.value.credentials >= 2);
assert.ok(administration.value.audits >= 7);

process.stdout.write(
  `${JSON.stringify({
    format: 'gnolith-workshop-public-backup-verification-v1',
    valid: true,
    taskId: receipt.taskId,
    promptId: receipt.promptId,
  })}\n`,
);
