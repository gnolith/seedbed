import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  getV022RecoveryPlan,
  validateV022RecoveryInventory,
} from '../scripts/release-recovery.mjs';

describe('v0.2.2 immutable Release recovery', () => {
  it('freezes the exact retained run archive names, paths, hashes, and source identity', () => {
    const plan = getV022RecoveryPlan('v0.2.2');
    expect(plan.commit).toBe('74737bec42368df4f006adcac5fe215edc732094');
    expect(plan.runId).toBe('29915140208');
    expect(plan.artifacts).toEqual([
      expect.objectContaining({ id: '8527551634', name: expect.stringContaining('seedbed-npm-2bf53198') }),
      expect.objectContaining({ id: '8527589468', name: expect.stringContaining('seedbed-staging-2bf53198') }),
      expect.objectContaining({ id: '8527678405', name: expect.stringContaining('seedbed-image-evidence-sha256-f1a05b0e') }),
    ]);
    expect(validateV022RecoveryInventory('v0.2.2', plan.inventory)).toHaveLength(8);
    expect(plan.inventory).toContainEqual(expect.objectContaining({
      path: 'staging/docs/mcp-runtime-sbom.json',
      sha256: '492322da93a4cd46f6057d1b9c6b36c59500967e65b10ffbf9c010c4439801f4',
    }));
    expect(plan.releaseEvidenceSha256).toBe('82d8695159ee293b10634f7c64942600e39c899dac4bfccd58f0b9e8f71d79f8');
  });

  it('rejects the flattened SBOM path that caused the Release-last failure', () => {
    const plan = getV022RecoveryPlan('v0.2.2');
    const flattened = plan.inventory.map((entry) => entry.path === 'staging/docs/mcp-runtime-sbom.json'
      ? { ...entry, path: 'staging/mcp-runtime-sbom.json' }
      : entry);
    expect(() => validateV022RecoveryInventory('v0.2.2', flattened))
      .toThrow('retained release artifact inventory does not match');
    expect(() => getV022RecoveryPlan('v0.2.3')).toThrow('unsupported release recovery tag');
  });

  it('keeps manual recovery capability-scoped and mutation-last', async () => {
    const source = await readFile(new URL('../.github/workflows/recover-v0.2.2-release.yml', import.meta.url), 'utf8');
    const workflow = parse(source) as RecoveryWorkflow;
    const recovery = workflow.jobs.recover;
    if (!recovery) throw new Error('manual v0.2.2 recovery job is missing');
    const text = JSON.stringify(recovery);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(recovery.environment).toBe('release');
    expect(recovery.permissions).toEqual({
      actions: 'read', attestations: 'read', contents: 'write', packages: 'read',
    });
    expect(text).toContain("test \\\"$RECOVERY_TAG\\\" = v0.2.2");
    expect(recovery.if).toContain("github.ref == 'refs/heads/main'");
    expect(text).toContain('recovery-tooling/scripts/release-recovery.mjs verify-inventory');
    expect(text).toContain('git -C recovery-tooling rev-parse origin/main');
    expect(text).toContain('actions/artifacts/$id/zip');
    expect(text).toContain('extract-release-artifact.py');
    expect(text).toContain("require('./node_modules/@gnolith/seedbed/package.json').version");
    expect(text).toContain('npm audit signatures');
    expect(text).toContain('gh attestation verify');
    expect(text).toContain('gh release create');
    expect(text.match(/gh release create/g)).toHaveLength(1);
    expect(text).not.toContain('npm publish');
    expect(text).not.toContain('docker push');
    expect(text).not.toContain('gh release upload');
    expect(text).not.toContain('gh release edit');
    expect(text).not.toContain('git tag');
    expect(text).not.toContain('id-token');
    expect(text).not.toContain('packages: write');
    expect(text).not.toContain('actions/attest');
    const releaseStep = recovery.steps.find(({ name }) => name?.includes('GitHub Release last'));
    expect(releaseStep?.run).toContain("--json name --jq .name)\" = 'Seedbed 0.2.2'");
    expect(releaseStep?.run).toContain("--json body --jq .body)\" = 'Seedbed 0.2.2'");
    expect(releaseStep?.env).toEqual(expect.objectContaining({
      GH_TOKEN: '${{ github.token }}', GITHUB_TOKEN: '${{ github.token }}',
    }));
    expect(recovery.steps.indexOf(releaseStep!)).toBe(recovery.steps.length - 1);
    for (const step of recovery.steps.filter(({ shell }) => shell === 'bash')) {
      const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: step.run });
      expect(syntax.status, `${step.name}: ${syntax.stderr}`).toBe(0);
    }
  });
});

type RecoveryWorkflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, {
    if?: string;
    environment?: string;
    permissions?: Record<string, string>;
    steps: Array<{ env?: Record<string, string>; name?: string; run?: string; shell?: string }>;
  }>;
};
