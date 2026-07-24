import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultSeedbedControl, createSeedbedControl, defaultSeedbedControlPolicy, SEEDBED_LOCAL_BUILD_SELECTOR, type DockerInstallationRequest, type SeedbedControlPolicy } from '../src/local-control.js';
import { sha256 } from '../src/canonical.js';
import { fixtureConfig } from './helpers.js';

describe('Alembic-compatible fixed local control adapter', () => {
  it('owns config translation and exposes exact inspect/plan/apply/resume/diagnose signatures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-local-control-'));
    const fixture = fixtureConfig(root);
    const policy: SeedbedControlPolicy = {
      format: 'gnolith-seedbed-control-policy-v2',
      stateRoot: join(root, 'control-state'),
      artifactRoot: process.cwd(),
      localBuild: {
        kind: 'seedbed-local-build-v1',
        selector: SEEDBED_LOCAL_BUILD_SELECTOR,
        pullPolicy: 'never',
        componentLockSha256: '1'.repeat(64),
        graphSha256: '2'.repeat(64),
        composeBundleSha256: '3'.repeat(64),
      },
      packages: fixture.packages,
      compose: {
        nodeImage: fixture.compose.nodeImage,
        profiles: [],
        publishIpv6Loopback: false,
      },
      migrations: {
        diamond: fixture.migrations.diamond,
        taproot: fixture.migrations.taproot,
        workshop: fixture.migrations.workshop,
        expectedCatalogDigest: fixture.migrations.expectedCatalogDigest,
      },
      backup: fixture.backup,
    };
    const request: DockerInstallationRequest = {
      installationId: fixture.installationId,
      baseIri: fixture.baseIri,
      endpoint: 'http://127.0.0.1:4317/mcp',
      image: policy.localBuild,
      expected: {
        installationId: fixture.installationId,
        baseIri: fixture.baseIri,
        serverVersion: fixture.packages.workshop.version,
        operationVersion: fixture.migrations.workshop,
        catalogDigest: fixture.migrations.expectedCatalogDigest,
        migrationReady: true,
        canonicalReady: true,
        authorizationReady: true,
        lexicalReady: true,
        blobReady: true,
        producerStatus: 'absent',
        semanticState: 'absent',
        allowLexicalOnly: true,
      },
    };
    const control = createSeedbedControl(policy);
    expect(await control.inspect({ installationId: request.installationId, projectRoot: process.cwd() })).toEqual({
      found: false,
      installationId: null,
      state: 'absent',
    });
    const plan = await control.plan(request);
    expect(plan.id).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan.digest).toBe(plan.id);
    expect(plan.request).toEqual(request);
    expect(plan.stateRoot).toEqual({ kind: 'external-directory', canonicalPath: policy.stateRoot });
    expect(control.resume).toHaveLength(1);
    expect(control.diagnose).toHaveLength(1);
    for (const field of ['componentLockSha256', 'graphSha256', 'composeBundleSha256'] as const) {
      await expect(control.plan({
        ...request,
        image: { ...policy.localBuild, [field]: 'f'.repeat(64) },
      })).rejects.toThrow(/attestations/u);
    }
    await expect(control.plan({
      ...request,
      image: {
        kind: 'digest-qualified-pulled-image-v1',
        reference: `ghcr.io/gnolith/workshop@sha256:${'f'.repeat(64)}`,
        pullPolicy: 'digest-only',
      },
    })).rejects.toThrow(/pulled application images are unsupported/u);
    await expect(control.plan({
      ...request,
      expected: { ...request.expected, catalogDigest: 'f'.repeat(64) },
    })).rejects.toThrow(/catalog/u);

    const componentLock = {
      format: 'gnolith-seedbed-component-lock-v1',
      localBuildSelector: SEEDBED_LOCAL_BUILD_SELECTOR,
      packages: policy.packages,
      compose: policy.compose,
      migrations: policy.migrations,
      backup: policy.backup,
    };
    const lockBytes = Buffer.from(JSON.stringify(componentLock));
    await writeFile(join(root, 'seedbed-component-lock.json'), lockBytes);
    const localBuild = { ...policy.localBuild, componentLockSha256: sha256(lockBytes) };
    await writeFile(join(root, 'seedbed-assembly-attestation.json'), JSON.stringify(localBuild));
    const defaults = { projectRoot: process.cwd(), stateRoot: policy.stateRoot, artifactRoot: root };
    expect(defaultSeedbedControlPolicy(defaults).packages.workshop).toEqual(policy.packages.workshop);
    const defaultControl = createDefaultSeedbedControl(defaults);
    const defaultRequest = { ...request, image: localBuild };
    expect((await defaultControl.plan(defaultRequest)).request).toEqual(defaultRequest);
    await writeFile(join(root, 'seedbed-assembly-attestation.json'), JSON.stringify({ ...localBuild, componentLockSha256: 'a'.repeat(64) }));
    expect(() => defaultSeedbedControlPolicy(defaults)).toThrow(/does not match/u);
    await expect(defaultControl.inspect({ installationId: request.installationId, projectRoot: root })).rejects.toThrow(/attested/u);
    expect(() => createSeedbedControl({ ...policy, stateRoot: join(process.cwd(), '.project-local-seedbed-state') })).toThrow(/outside/u);
    if (process.platform !== 'win32') {
      await symlink(root, join(root, 'state-alias'));
      expect(() => createSeedbedControl({ ...policy, stateRoot: join(root, 'state-alias', 'nested') })).toThrow(/symlink|junction|alias/u);
    }
  });
});
