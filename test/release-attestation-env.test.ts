import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('release image attestation verification environment', () => {
  let step: WorkflowStep;
  let workflowSteps: WorkflowStep[];
  const temporaryDirectories: string[] = [];

  beforeAll(async () => {
    const source = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const workflow = parse(source) as ReleaseWorkflow;
    workflowSteps = Object.values(workflow.jobs).flatMap(({ steps }) => steps);
    const candidate = workflow.jobs.image.steps.find(
      ({ name }) => name === 'Verify the signed image provenance identity',
    );
    if (!candidate?.run || !candidate.env) throw new Error('attestation verification step is missing');
    step = candidate;
  });

  afterAll(async () => {
    await Promise.all(temporaryDirectories.map((directory) => rm(directory, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    })));
  });

  it('maps the built-in token only into the actual gh verification step', async () => {
    expect(step.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(workflowSteps.filter(({ env }) => env?.GH_TOKEN).map(({ name }) => name))
      .toEqual(['Verify the signed image provenance identity']);

    const root = await mkdtemp(join(tmpdir(), 'seedbed-attestation-env-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'image-evidence'), { recursive: true });
    const ghContract = `gh() {
set -euo pipefail
test "\${GH_TOKEN:-}" = test-built-in-token
test "\${1:-} \${2:-}" = 'attestation verify'
printf '%s\n' "$*" > "$MOCK_GH_LOG"
}
`;
    const workflowEnvironment = `export GH_TOKEN=test-built-in-token
export IMAGE_DIGEST=sha256:${'a'.repeat(64)}
export MOCK_GH_LOG=gh.log
export RELEASE_COMMIT=${'b'.repeat(40)}
export RELEASE_REF=refs/tags/v0.2.2
`;

    const result = spawnSync('bash', [], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      input: `${ghContract}${workflowEnvironment}${step.run}`,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(await readFile(join(root, 'gh.log'), 'utf8')).toContain('attestation verify oci://ghcr.io/gnolith/seedbed@sha256:');
    const evidence = JSON.parse(await readFile(
      join(root, 'image-evidence/image-provenance-verification.json'),
      'utf8',
    )) as { subject: { digest: string }; verification: string };
    expect(evidence.subject.digest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(evidence.verification).toBe('gh attestation verify passed');

    const missingToken = spawnSync('bash', [], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      input: `${ghContract}${workflowEnvironment.replace('GH_TOKEN=test-built-in-token', 'GH_TOKEN=')}${step.run}`,
    });
    expect(missingToken.status).not.toBe(0);
  });
});

type WorkflowStep = { name?: string; env?: Record<string, string>; run?: string };
type ReleaseWorkflow = { jobs: Record<string, { steps: WorkflowStep[] }> & { image: { steps: WorkflowStep[] } } };
