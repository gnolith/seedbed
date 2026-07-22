import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  createGitHubArtifactName,
  githubArtifactNameForbiddenCharacters,
} from '../scripts/github-artifact-name.mjs';

describe('release image evidence artifact name', () => {
  it('executes the actual workflow derivation with a portable sha256 identity', async () => {
    const source = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const workflow = parse(source) as ReleaseWorkflow;
    const nameStep = workflow.jobs.image.steps.find(
      ({ name }) => name === 'Create the portable image evidence artifact name',
    );
    const uploadStep = workflow.jobs.image.steps.find(
      ({ name }) => name === 'Upload the verified image evidence',
    );
    if (!nameStep?.run) throw new Error('artifact-name derivation step is missing');

    const digest = `sha256:${'a'.repeat(64)}`;
    const result = spawnSync('bash', [], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: process.env,
      input: `export IMAGE_DIGEST=${digest}\nexport RUN_ATTEMPT=2\nexport GITHUB_OUTPUT=$(mktemp)\n${nameStep.run}\ncat "$GITHUB_OUTPUT"\n`,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`name=seedbed-image-evidence-sha256-${'a'.repeat(64)}-attempt-2`);
    expect(uploadStep?.with?.name).toBe('${{ steps.image-evidence-name.outputs.name }}');
  });

  it('replaces every GitHub-forbidden character deterministically', () => {
    const forbidden = '"<>|*?\r\n\\/:';
    const first = createGitHubArtifactName('evidence', forbidden, 'attempt-1');
    const second = createGitHubArtifactName('evidence', forbidden, 'attempt-1');
    expect(first).toBe(second);
    expect(first).not.toMatch(githubArtifactNameForbiddenCharacters);
  });
});

type WorkflowStep = { name?: string; run?: string; with?: Record<string, string> };
type ReleaseWorkflow = { jobs: { image: { steps: WorkflowStep[] } } };
