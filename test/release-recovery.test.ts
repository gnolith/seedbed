import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  decideV022ReleaseRecovery,
  fetchV022DraftCount,
  getV022ReleaseAssetNames,
  getV022ReleaseCopies,
  getV022RecoveryPlan,
  stageRecoveryAssetsFromDefinition,
  validateNpmProvenanceIdentity,
  validateV022NpmMetadata,
  validateV022ReleaseSnapshot,
  validateV022RecoveryInventory,
} from '../scripts/release-recovery.mjs';

describe('v0.2.2 immutable Release recovery', () => {
  it('freezes the exact retained run archive names, paths, hashes, and source identity', () => {
    const plan = getV022RecoveryPlan('v0.2.2');
    expect(plan.commit).toBe('74737bec42368df4f006adcac5fe215edc732094');
    expect(plan.tag).toBe('v0.2.2');
    expect(plan.version).toBe('0.2.2');
    expect(plan.runId).toBe('29915140208');
    expect(plan.workflowId).toBe('317536422');
    expect(plan.workflowBlob).toBe('a1ab8cbb6a0e13c1e0e7a1e029f5989b18f7eaaa');
    expect(plan.npmSha256).toBe('2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b');
    expect(plan.npmIntegrity).toBe('sha512-nyMdjkJJjSLXlppljaR4J37R8vQZtXO8KxohJYhwAjenniEA3Ix9q0mssrTGM4jnBSZVQTIAHEkMa37DJp/Cvg==');
    expect(plan.closureSha256).toBe('d565ac3ac011a0b2bb860486927365befe5823f19c5ad9b0a2592f9093c7f739');
    expect(plan.imageDigest).toBe('sha256:f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389');
    expect(plan.imageSbomSha256).toBe('806745ac5cae12ec177d4814958cbed2d69d967d1c020fe666414b0a18284070');
    expect(plan.imageManifestSha256).toBe('f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389');
    expect(plan.provenanceEvidenceSha256).toBe('9e21452a11081d08a5179a72c6b11c4053a40bf8bb895635de7a6d2b9c0fb97e');
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
    expect(plan.inventory).toEqual([
      { path: 'image/image-manifest.json', bytes: 856, sha256: 'f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389' },
      { path: 'image/image-provenance-verification.json', bytes: 423, sha256: '9e21452a11081d08a5179a72c6b11c4053a40bf8bb895635de7a6d2b9c0fb97e' },
      { path: 'image/image-sbom.json', bytes: 6654678, sha256: '806745ac5cae12ec177d4814958cbed2d69d967d1c020fe666414b0a18284070' },
      { path: 'npm/seedbed-publication-2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b.tgz', bytes: 240982, sha256: '2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b' },
      { path: 'npm/seedbed-publication.json', bytes: 224, sha256: '462db1b0573119e0326498db33c6a8ee1cf0d51425723957f43079403641cee5' },
      { path: 'staging/docs/mcp-runtime-sbom.json', bytes: 38207, sha256: '492322da93a4cd46f6057d1b9c6b36c59500967e65b10ffbf9c010c4439801f4' },
      { path: 'staging/gnolith-production-closure.tar.gz', bytes: 14171466, sha256: 'd565ac3ac011a0b2bb860486927365befe5823f19c5ad9b0a2592f9093c7f739' },
      { path: 'staging/gnolith-production-closure.tar.gz.sha256', bytes: 134, sha256: 'ce86aeff089da94fe3dbc19e9f838d379f515dbcf7fb1d798cdcbdb1a7de851d' },
    ]);
    expect(plan.releaseEvidenceSha256).toBe('82d8695159ee293b10634f7c64942600e39c899dac4bfccd58f0b9e8f71d79f8');
    expect(plan.npmAttestationsUrl).toBe('https://registry.npmjs.org/-/npm/v1/attestations/@gnolith%2fseedbed@0.2.2');
    expect(plan.npmShasum).toBe('b709b6ea24aecf7f96dd8286d4d07e9bfc727d7b');
    expect(plan.npmTarballUrl).toBe('https://registry.npmjs.org/@gnolith/seedbed/-/seedbed-0.2.2.tgz');
    expect(plan.npmFileCount).toBe(59);
    expect(plan.npmUnpackedSize).toBe(1249898);
    expect(plan.npmSignatureKeyId).toBe('SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U');
    expect(plan.npmSignature).toBe('MEYCIQCb/sNAVE6XdjiyBC5GTO6sTkJ66auA8kCJwol/0NqywAIhAJqWGufSBFqUHk75P9Qsg1qZvm9o6NNzPKKhNzggpDav');
    expect(plan.priorLatestReleaseTag).toBe('v0.1.1');
    expect(plan.repositoryId).toBe('1307629856');
    expect(plan.repositoryOwnerId).toBe('307278281');
    expect(plan.builderId).toBe('https://github.com/actions/runner/github-hosted');
    expect(plan.invocationId).toBe('https://github.com/gnolith/seedbed/actions/runs/29915140208/attempts/1');
    expect(plan.dsseSignature).toBe('MEQCIHzKn9Ph19yd7VslMra+CswtwXVpiuDkac9+mj9PzZBZAiBFj6XJlPWx63cMw3THD6DTUnrBYjGKoQekkVAnynwQeg==');
    expect(plan.dssePayloadSha256).toBe('c9252747694f2fad4bac03a08e441d75bd2f647c123f06412b0e007d0087e629');
    expect(plan.verificationMaterialSha256).toBe('9ceb6efcdb35c412d8e87f785a19645c73c5dc3b117189c5ee63eca55da65c8b');
    expect(plan.tlogIndex).toBe('2217599731');
    expect(plan.tlogIntegratedTime).toBe('1784719198');
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
      shasum: plan.npmShasum,
      tarball: plan.npmTarballUrl,
      fileCount: plan.npmFileCount,
      unpackedSize: plan.npmUnpackedSize,
      attestations: { url: plan.npmAttestationsUrl, provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
      signatures: [{ keyid: plan.npmSignatureKeyId, sig: plan.npmSignature }],
    } };
    expect(() => validateV022NpmMetadata('v0.2.2', metadata)).not.toThrow();
    for (const mutate of [
      (value: typeof metadata) => { value.dist.shasum = 'wrong'; },
      (value: typeof metadata) => { value.dist.tarball = 'https://attacker.invalid/package.tgz'; },
      (value: typeof metadata) => { value.dist.fileCount += 1; },
      (value: typeof metadata) => { value.dist.unpackedSize += 1; },
      (value: typeof metadata) => { value.dist.attestations.url = 'https://attacker.invalid'; },
      (value: typeof metadata) => { value.dist.signatures[0]!.keyid = 'wrong'; },
      (value: typeof metadata) => { value.dist.signatures[0]!.sig = 'wrong'; },
    ]) {
      const changed = structuredClone(metadata);
      mutate(changed);
      expect(() => validateV022NpmMetadata('v0.2.2', changed)).toThrow('metadata');
    }
    const provenance = provenanceFixture();
    const envelope = provenance.attestations[0]!.bundle.dsseEnvelope;
    const expected = {
      ...plan,
      dsseSignature: envelope.signatures[0]!.sig,
      dssePayloadSha256: createHash('sha256').update(Buffer.from(envelope.payload, 'base64')).digest('hex'),
      tlogIndex: '1',
      tlogIntegratedTime: '2',
      verificationMaterialSha256: stableSha256(provenance.attestations[0]!.bundle.verificationMaterial),
    };
    expect(() => validateNpmProvenanceIdentity(expected, provenance)).not.toThrow();
    for (const mutate of [
      (value: ProvenanceResponse) => { value.attestations[0]!.bundle.dsseEnvelope.payload += '!!!'; },
      (value: ProvenanceResponse) => {
        const target = value.attestations[0]!.bundle.dsseEnvelope;
        target.payload = Buffer.from(`${Buffer.from(target.payload, 'base64').toString('utf8')} `).toString('base64');
      },
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => {
        (statement as ProvenanceStatement & { unchecked?: boolean }).unchecked = true;
      }),
      (value: ProvenanceResponse) => { value.attestations[0]!.bundle.dsseEnvelope.payloadType = 'text/plain'; },
      (value: ProvenanceResponse) => { value.attestations[0]!.bundle.mediaType = 'wrong'; },
      (value: ProvenanceResponse) => { value.attestations[0]!.bundle.dsseEnvelope.signatures[0]!.sig = 'wrong'; },
      (value: ProvenanceResponse) => { delete value.attestations[0]!.bundle.verificationMaterial.tlogEntries[0]!.logId; },
      (value: ProvenanceResponse) => { delete value.attestations[0]!.bundle.verificationMaterial.tlogEntries[0]!.inclusionPromise; },
      (value: ProvenanceResponse) => { delete value.attestations[0]!.bundle.verificationMaterial.tlogEntries[0]!.inclusionProof; },
      (value: ProvenanceResponse) => { delete value.attestations[0]!.bundle.verificationMaterial.tlogEntries[0]!.canonicalizedBody; },
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => { statement._type = 'wrong'; }),
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => { statement.predicateType = 'wrong'; }),
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => { statement.predicate.buildDefinition.buildType = 'wrong'; }),
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/tags/v9.9.9'; }),
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => { statement.predicate.buildDefinition.internalParameters.github.repository_id = 'wrong'; }),
      (value: ProvenanceResponse) => mutateStatement(value, (statement) => { statement.predicate.runDetails.metadata.invocationId = 'wrong'; }),
    ]) {
      const changed = structuredClone(provenance);
      mutate(changed);
      expect(() => validateNpmProvenanceIdentity(expected, changed)).toThrow();
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

  it('enumerates drafts across bounded authenticated pages and fails closed on truncation', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ tag_name: `v0.0.${index}`, draft: false }));
    const pages = [firstPage, [{ tag_name: 'v0.2.2', draft: true }]];
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(pages.shift() ?? []), { status: 200 });
    };
    await expect(fetchV022DraftCount(
      'v0.2.2', 'https://api.github.com/repos/gnolith/seedbed/releases', 'token', fakeFetch,
    )).resolves.toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('page=2');

    const fullFetch: typeof fetch = async () => new Response(JSON.stringify(firstPage), { status: 200 });
    await expect(fetchV022DraftCount(
      'v0.2.2', 'https://api.github.com/repos/gnolith/seedbed/releases', 'token', fullFetch,
    )).rejects.toThrow('bounded 1000-release');
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
    const normalSource = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const workflow = parse(source) as RecoveryWorkflow;
    const normalWorkflow = parse(normalSource) as RecoveryWorkflow;
    const recovery = workflow.jobs.recover;
    if (!recovery) throw new Error('manual v0.2.2 recovery job is missing');
    const text = JSON.stringify(recovery);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency).toEqual({ group: 'seedbed-release', 'cancel-in-progress': false });
    expect(recovery.environment).toBe('release-recovery-v0.2.2');
    expect(Object.values(normalWorkflow.jobs).filter(({ environment }) => environment !== undefined)
      .map(({ environment }) => environment)).toEqual(['release']);
    expect(Object.values(workflow.jobs).filter(({ environment }) => environment !== undefined)
      .map(({ environment }) => environment)).toEqual(['release-recovery-v0.2.2']);
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
    const releaseStep = recovery.steps.find(({ name }) => name?.includes('GitHub Release last'));
    const releaseIndex = recovery.steps.indexOf(releaseStep!);
    expect(trustIndex).toBeGreaterThan(0);
    expect(tagCheckoutIndex).toBeGreaterThan(trustIndex);
    expect(setupIndex).toBeGreaterThan(tagCheckoutIndex);
    expect(releaseIndex).toBeGreaterThan(tagCheckoutIndex);
    const trustStep = recovery.steps[trustIndex]!;
    expect(trustStep.env).toEqual(expect.objectContaining({
      IMMUTABLE_SETTING_EVIDENCE_TAG: '${{ vars.IMMUTABLE_RELEASES_VERIFIED_FOR }}',
    }));
    const immutableGuard = trustStep.run?.split(/\r?\n/u)
      .find((line) => line.trim() === 'test "$IMMUTABLE_SETTING_EVIDENCE_TAG" = v0.2.2');
    expect(immutableGuard).toBeDefined();
    const immutableGuardScript = `set -euo pipefail\n${immutableGuard}`;
    const correctEvidence = spawnSync('bash', [], {
      encoding: 'utf8', input: `set -euo pipefail\nIMMUTABLE_SETTING_EVIDENCE_TAG=v0.2.2\n${immutableGuard}`,
    });
    expect(correctEvidence.status, correctEvidence.stderr).toBe(0);
    const wrongEvidence = spawnSync('bash', [], {
      encoding: 'utf8', input: `set -euo pipefail\nIMMUTABLE_SETTING_EVIDENCE_TAG=v0.2.1\n${immutableGuard}`,
    });
    expect(wrongEvidence.status).not.toBe(0);
    const missingEvidence = spawnSync('bash', [], {
      encoding: 'utf8', input: immutableGuardScript,
    });
    expect(missingEvidence.status).not.toBe(0);
    for (const step of recovery.steps.filter(({ uses }) => uses?.startsWith('actions/checkout@'))) {
      expect(step.with?.['persist-credentials']).toBe(false);
    }
    expect(text).toContain('actions/artifacts/$id/zip');
    expect(text).toContain('extract-release-artifact.py');
    expect(text).toContain("require('./node_modules/@gnolith/seedbed/package.json').version");
    expect(text).toContain('npm audit signatures');
    expect(text).toContain('verify-npm-provenance');
    expect(text).toContain('release-decision');
    expect(text.match(/fetch-draft-count/g)).toHaveLength(3);
    expect(text).toContain('gh attestation verify');
    expect(text).toContain('gh release create');
    expect(text.match(/gh release create/g)).toHaveLength(1);
    expect(text).not.toContain('npm publish');
    expect(text).not.toContain('docker push');
    expect(text).not.toContain('git push');
    expect(text).not.toContain('gh attestation create');
    expect(text).not.toContain('gh attestation sign');
    expect(text).not.toContain('gh release upload');
    expect(text).not.toContain('gh release edit');
    expect(text).not.toContain('git tag');
    expect(text).not.toContain('id-token');
    expect(text).not.toContain('packages: write');
    expect(text).not.toContain('actions/attest');
    expect(source).not.toContain('secrets.');
    expect(source).not.toContain('immutable-releases');
    expect(source.match(/\$\{\{\s*vars\.IMMUTABLE_RELEASES_VERIFIED_FOR\s*\}\}/gu)).toHaveLength(1);
    expect(releaseStep?.run).toContain('verify-release-json');
    expect(releaseStep?.run?.match(/ls-remote --tags origin/g)).toHaveLength(2);
    expect(releaseStep?.run?.match(/releases\/latest --jq \.tag_name/g)).toHaveLength(4);
    expect(releaseStep?.run).toMatch(/test "\$\(gh api repos\/gnolith\/seedbed\/releases\/latest --jq \.tag_name\)" = v0\.1\.1\s+gh release create/u);
    expect(releaseStep?.run?.trimEnd()).toMatch(/rev-parse 'af24354dffe56a09ddcf302633d50d5ad53ed2eb:\.github\/workflows\/release\.yml'\)" = a1ab8cbb6a0e13c1e0e7a1e029f5989b18f7eaaa$/u);
    expect(releaseStep?.env).toEqual(expect.objectContaining({
      GH_TOKEN: '${{ github.token }}', GITHUB_TOKEN: '${{ github.token }}',
    }));
    expect(releaseIndex).toBe(recovery.steps.length - 1);
    for (const step of recovery.steps.filter(({ shell }) => shell === 'bash')) {
      const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: step.run });
      expect(syntax.status, `${step.name}: ${syntax.stderr}`).toBe(0);
    }
  });
});

type RecoveryWorkflow = {
  concurrency?: { group: string; 'cancel-in-progress': boolean };
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
      internalParameters: { github: {
        event_name: 'push', repository_id: plan.repositoryId, repository_owner_id: plan.repositoryOwnerId,
      } },
    }, runDetails: {
      builder: { id: plan.builderId }, metadata: { invocationId: plan.invocationId },
    } },
  };
  return { attestations: [{
    predicateType: 'https://slsa.dev/provenance/v1',
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {
        certificate: { rawBytes: Buffer.from('certificate').toString('base64') },
        tlogEntries: [{
          logIndex: '1', integratedTime: '2',
          logId: { keyId: Buffer.from('log-key').toString('base64') },
          kindVersion: { kind: 'dsse', version: '0.0.1' },
          inclusionPromise: { signedEntryTimestamp: Buffer.from('promise').toString('base64') },
          inclusionProof: {
            logIndex: '1', rootHash: Buffer.from('root').toString('base64'), treeSize: '2',
            hashes: [Buffer.from('hash').toString('base64')], checkpoint: { envelope: 'checkpoint' },
          },
          canonicalizedBody: Buffer.from('body').toString('base64'),
        }],
      },
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
        signatures: [{ keyid: '', sig: Buffer.from('signature').toString('base64') }],
      },
    },
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
    internalParameters: { github: { event_name: string; repository_id: string; repository_owner_id: string } };
    resolvedDependencies: Array<{ uri: string; digest: { gitCommit: string } }>;
  };
  runDetails: { builder: { id: string }; metadata: { invocationId: string } };
  };
};
type ProvenanceResponse = { attestations: Array<{
  predicateType: string;
  bundle: {
    mediaType: string;
    verificationMaterial: {
      certificate: { rawBytes: string };
      tlogEntries: Array<{
        logIndex: string;
        integratedTime: string;
        logId?: { keyId: string };
        kindVersion: { kind: string; version: string };
        inclusionPromise?: { signedEntryTimestamp: string };
        inclusionProof?: {
          logIndex: string;
          rootHash: string;
          treeSize: string;
          hashes: string[];
          checkpoint: { envelope: string };
        };
        canonicalizedBody?: string;
      }>;
    };
    dsseEnvelope: {
      payloadType: string;
      payload: string;
      signatures: Array<{ keyid: string; sig: string }>;
    };
  };
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

function stableSha256(value: unknown): string {
  const normalize = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(normalize) :
    entry && typeof entry === 'object' ? Object.fromEntries(
      Object.keys(entry).sort().map((key) => [key, normalize((entry as Record<string, unknown>)[key])]),
    ) : entry;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
