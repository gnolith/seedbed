import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  decideV022ReleaseRecovery,
  getV022ReleaseAssetNames,
  getV022ReleaseCopies,
  getV022RecoveryPlan,
  stageRecoveryAssetsFromDefinition,
  validateV022NpmMetadata,
  validateV022NpmProvenance,
  validateV022ReleaseSnapshot,
  validateV022RecoveryInventory,
} from '../scripts/release-recovery.mjs';

describe('v0.2.2 immutable Release recovery', () => {
  it('freezes the exact retained run archive names, paths, hashes, and source identity', () => {
    const plan = getV022RecoveryPlan('v0.2.2');
    expect(plan.commit).toBe('74737bec42368df4f006adcac5fe215edc732094');
    expect(plan.runId).toBe('29915140208');
    expect(plan.workflowId).toBe('317536422');
    expect(plan.workflowBlob).toBe('a1ab8cbb6a0e13c1e0e7a1e029f5989b18f7eaaa');
    expect(plan.jobs).toEqual([
      { id: '88907134527', name: 'package', conclusion: 'success' },
      { id: '88907578374', name: 'publish', conclusion: 'success' },
      { id: '88907767057', name: 'image', conclusion: 'success' },
      { id: '88908286874', name: 'release', conclusion: 'failure' },
    ]);
    expect(plan.artifacts).toEqual([
      { id: '8527551634', name: 'seedbed-npm-2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b-attempt-1', digest: 'sha256:cf42118f42f6c28dbf0658ea5bfd8e2679f95b8665696aba8f51625d32e4172b', size: 241636, expiresAt: '2026-08-21T11:18:08Z', directory: 'npm' },
      { id: '8527589468', name: 'seedbed-staging-2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b-attempt-1', digest: 'sha256:ba151b367f9562f575dddd59a140cccda70698f19fdad31c432cc7aad87e0f6a', size: 14210303, expiresAt: '2026-08-21T11:19:39Z', directory: 'staging' },
      { id: '8527678405', name: 'seedbed-image-evidence-sha256-f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389-attempt-1', digest: 'sha256:dfbf2b6438b33d877f3d90fbb9e6d26dd370d1574e8ecf0fafd37a3eacd9dc53', size: 6656391, expiresAt: '2026-08-21T11:23:09Z', directory: 'image' },
    ]);
    expect(validateV022RecoveryInventory('v0.2.2', plan.inventory)).toHaveLength(8);
    expect(plan.inventory).toContainEqual(expect.objectContaining({
      path: 'staging/docs/mcp-runtime-sbom.json',
      sha256: '492322da93a4cd46f6057d1b9c6b36c59500967e65b10ffbf9c010c4439801f4',
    }));
    expect(plan.releaseEvidenceSha256).toBe('82d8695159ee293b10634f7c64942600e39c899dac4bfccd58f0b9e8f71d79f8');
    expect(plan.npmAttestationsUrl).toBe('https://registry.npmjs.org/-/npm/v1/attestations/@gnolith%2fseedbed@0.2.2');
    expect(plan.priorLatestReleaseTag).toBe('v0.1.1');
    expect(getV022ReleaseAssetNames('v0.2.2')).toEqual([
      'seedbed-image-manifest-f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389.json',
      'seedbed-image-provenance-verification-9e21452a11081d08a5179a72c6b11c4053a40bf8bb895635de7a6d2b9c0fb97e.json',
      'seedbed-image-sbom-806745ac5cae12ec177d4814958cbed2d69d967d1c020fe666414b0a18284070.json',
      'seedbed-mcp-runtime-sbom-492322da93a4cd46f6057d1b9c6b36c59500967e65b10ffbf9c010c4439801f4.json',
      'seedbed-production-closure-d565ac3ac011a0b2bb860486927365befe5823f19c5ad9b0a2592f9093c7f739.tar.gz',
      'seedbed-publication-2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b.tgz',
      'seedbed-release-evidence-82d8695159ee293b10634f7c64942600e39c899dac4bfccd58f0b9e8f71d79f8.json',
    ]);
  });

  it('strictly validates npm metadata and the complete SLSA statement identity', () => {
    const plan = getV022RecoveryPlan('v0.2.2');
    const metadata = { name: '@gnolith/seedbed', version: plan.version, dist: {
      integrity: plan.npmIntegrity,
      attestations: { url: plan.npmAttestationsUrl, provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
    } };
    expect(() => validateV022NpmMetadata('v0.2.2', metadata)).not.toThrow();
    expect(() => validateV022NpmMetadata('v0.2.2', {
      ...metadata, dist: { ...metadata.dist, attestations: { ...metadata.dist.attestations, url: 'https://attacker.invalid' } },
    })).toThrow('metadata');
    const provenance = provenanceFixture();
    expect(() => validateV022NpmProvenance('v0.2.2', provenance)).not.toThrow();
    for (const mutate of [
      (value: ProvenanceResponse) => { value.attestations[0]!.bundle.dsseEnvelope.payloadType = 'text/plain'; },
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => { statement._type = 'wrong'; }),
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => { statement.predicateType = 'wrong'; }),
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => { statement.predicate.buildDefinition.buildType = 'wrong'; }),
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/tags/v9.9.9'; }),
    ]) {
      const changed = structuredClone(provenance);
      mutate(changed);
      expect(() => validateV022NpmProvenance('v0.2.2', changed)).toThrow();
    }
  });

  it('executes exactly seven deterministic staging outputs and rejects inventory drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-recovery-stage-'));
    try {
      const copies = getV022ReleaseCopies('v0.2.2');
      const inventory = [];
      for (const [index, [source]] of copies.entries()) {
        const bytes = Buffer.from(`retained-${index}\n`);
        const target = join(root, source);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        inventory.push({ path: source, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      const definition = { ...getV022RecoveryPlan('v0.2.2'), inventory };
      const destination = join(root, 'release-assets');
      const names = await stageRecoveryAssetsFromDefinition(definition, copies, root, destination);
      expect(names).toEqual(getV022ReleaseAssetNames('v0.2.2'));
      expect((await readdir(destination)).sort()).toEqual(names);
      expect(await readFile(join(root, 'expected-release-assets.txt'), 'utf8')).toBe(`${names.join('\n')}\n`);
      await writeFile(join(root, copies[0]![0]), 'drift');
      await expect(stageRecoveryAssetsFromDefinition(definition, copies, root, join(root, 'second')))
        .rejects.toThrow('inventory mismatch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('makes create, exact no-op, mismatch, draft, and race decisions fail closed', () => {
    expect(decideV022ReleaseRecovery('v0.2.2', 'absent', 'absent', 0, 'v0.1.1')).toBe('create');
    expect(decideV022ReleaseRecovery('v0.2.2', 'match', 'not-checked', 0, 'v0.2.2')).toBe('verify');
    expect(() => decideV022ReleaseRecovery('v0.2.2', 'draft', 'not-checked', 0, 'v0.1.1')).toThrow();
    expect(() => decideV022ReleaseRecovery('v0.2.2', 'absent', 'match', 0, 'v0.1.1')).toThrow('changed');
    expect(() => decideV022ReleaseRecovery('v0.2.2', 'absent', 'absent', 1, 'v0.1.1')).toThrow('draft');
    expect(() => decideV022ReleaseRecovery('v0.2.2', 'absent', 'absent', 0, 'v9.0.0')).toThrow('prior latest');
    expect(() => decideV022ReleaseRecovery('v0.2.2', 'match', 'not-checked', 0, 'v0.1.1')).toThrow('latest');
  });

  it('accepts only exact immutable Release metadata and server-recorded asset bytes', () => {
    const release = releaseSnapshotFixture();
    expect(() => validateV022ReleaseSnapshot('v0.2.2', release)).not.toThrow();
    for (const mutate of [
      (value: ReleaseSnapshot) => { value.name = 'wrong'; },
      (value: ReleaseSnapshot) => { value.body = 'wrong'; },
      (value: ReleaseSnapshot) => { value.draft = true; },
      (value: ReleaseSnapshot) => { value.immutable = false; },
      (value: ReleaseSnapshot) => { value.assets.pop(); },
      (value: ReleaseSnapshot) => { value.assets.push({ ...value.assets[0]!, name: 'extra.json' }); },
      (value: ReleaseSnapshot) => { value.assets[0]!.digest = `sha256:${'0'.repeat(64)}`; },
      (value: ReleaseSnapshot) => { value.assets[0]!.size += 1; },
    ]) {
      const changed = structuredClone(release);
      mutate(changed);
      expect(() => validateV022ReleaseSnapshot('v0.2.2', changed)).toThrow();
    }
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
    expect(text).toContain('persist-credentials');
    expect(text).toContain('./recovery-tooling/.github/actions/setup-node');
    const trustIndex = recovery.steps.findIndex(({ name }) => name?.includes('Prove remote tag identity'));
    const tagCheckoutIndex = recovery.steps.findIndex(({ name }) => name?.includes('now-proven immutable tagged source'));
    const setupIndex = recovery.steps.findIndex(({ uses }) => uses === './recovery-tooling/.github/actions/setup-node');
    expect(trustIndex).toBeGreaterThan(0);
    expect(tagCheckoutIndex).toBeGreaterThan(trustIndex);
    expect(setupIndex).toBeGreaterThan(tagCheckoutIndex);
    for (const step of recovery.steps.filter(({ uses }) => uses?.startsWith('actions/checkout@'))) {
      expect(step.with?.['persist-credentials']).toBe(false);
    }
    expect(text).toContain('actions/artifacts/$id/zip');
    expect(text).toContain('extract-release-artifact.py');
    expect(text).toContain("require('./node_modules/@gnolith/seedbed/package.json').version");
    expect(text).toContain('npm audit signatures');
    expect(text).toContain('verify-npm-provenance');
    expect(text).toContain('release-decision');
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
    expect(releaseStep?.run).toContain('verify-release-json');
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
    steps: Array<{
      env?: Record<string, string>;
      name?: string;
      run?: string;
      shell?: string;
      uses?: string;
      with?: Record<string, unknown>;
    }>;
  }>;
};

function provenanceFixture(): ProvenanceResponse {
  const plan = getV022RecoveryPlan('v0.2.2');
  const sha512 = Buffer.from(plan.npmIntegrity.slice('sha512-'.length), 'base64').toString('hex');
  const statement: ProvenanceStatement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: `pkg:npm/%40gnolith/seedbed@${plan.version}`, digest: { sha512 } }],
    predicate: { buildDefinition: {
      buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: { workflow: {
        repository: 'https://github.com/gnolith/seedbed', path: '.github/workflows/release.yml', ref: 'refs/tags/v0.2.2',
      } },
      resolvedDependencies: [{
        uri: 'git+https://github.com/gnolith/seedbed@refs/tags/v0.2.2', digest: { gitCommit: plan.commit },
      }],
    } },
  };
  return { attestations: [{
    predicateType: 'https://slsa.dev/provenance/v1',
    bundle: { dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
    } },
  }] };
}

function mutateStatement(response: ProvenanceResponse, mutate: (statement: ProvenanceStatement) => void): void {
  const envelope = response.attestations[0]!.bundle.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as ProvenanceStatement;
  mutate(statement);
  envelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
}

type ProvenanceStatement = {
  _type: string;
  predicateType: string;
  subject: Array<{ name: string; digest: { sha512: string } }>;
  predicate: { buildDefinition: {
    buildType: string;
    externalParameters: { workflow: { repository: string; path: string; ref: string } };
    resolvedDependencies: Array<{ uri: string; digest: { gitCommit: string } }>;
  } };
};
type ProvenanceResponse = { attestations: Array<{
  predicateType: string;
  bundle: { dsseEnvelope: { payloadType: string; payload: string } };
}> };

function releaseSnapshotFixture(): ReleaseSnapshot {
  const sizes = [856, 423, 6654678, 38207, 14171466, 240982, 1250];
  return {
    tag_name: 'v0.2.2', name: 'Seedbed 0.2.2', body: 'Seedbed 0.2.2',
    draft: false, prerelease: false, immutable: true,
    assets: getV022ReleaseAssetNames('v0.2.2').map((name, index) => ({
      name, state: 'uploaded', size: sizes[index]!,
      digest: `sha256:${name.match(/-([a-f0-9]{64})\.(?:json|tgz|tar\.gz)$/)![1]}`,
    })),
  };
}

type ReleaseSnapshot = {
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  assets: Array<{ name: string; state: string; size: number; digest: string }>;
};
