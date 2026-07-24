import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';
import { assertSafeComposeEnvironment, renderCompose } from '../src/compose.js';
import { fixtureConfig } from './helpers.js';
import { DockerComposeDriver, protectedOperatorMountArgs } from '../src/system-drivers.js';
import { canonicalJson, sha256 } from '../src/canonical.js';

describe('strict installation config and Compose rendering', () => {
  it('accepts an exact immutable config and rejects unknown keys, hostile projects, network paths, and unpinned images', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-config-'));
    const config = fixtureConfig(root);
    expect(validateConfig(config, { projectDirectory: process.cwd() })).toEqual(config);
    expect(() => validateConfig({ ...config, runtime: {} }, { projectDirectory: process.cwd() })).toThrow(/unknown keys/u);
    expect(() => validateConfig({ ...config, compose: { ...config.compose, projectName: 'x; docker rm' } }, { projectDirectory: process.cwd() })).toThrow(/unsafe/u);
    expect(() => validateConfig({ ...config, compose: { ...config.compose, nodeImage: 'node:latest' } }, { projectDirectory: process.cwd() })).toThrow(/pinned/u);
    expect(() => validateConfig({ ...config, paths: { ...config.paths, stateDirectory: '\\\\server\\share' } }, { projectDirectory: process.cwd() })).toThrow(/network/u);
  });

  it('renders one Workshop service on host loopback with optional isolated profiles and no secret literals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-compose-'));
    const base = fixtureConfig(root);
    const config = {
      ...base,
      packages: {
        ...base.packages,
        waystone: { version: '0.4.0-candidate.1', artifact: 'artifacts/waystone.tgz', sha256: 'f'.repeat(64), sourceCommit: 'f'.repeat(40) },
      },
      compose: {
        ...base.compose,
        profiles: ['qdrant', 'waystone'] as const,
        qdrantVolume: 'qdrant-data',
        qdrantImage: `qdrant/qdrant@sha256:${'1'.repeat(64)}`,
      },
    };
    const render = renderCompose(config);
    assertSafeComposeEnvironment(render.environment);
    expect(render.services).toEqual(['workshop', 'qdrant']);
    expect(render.oneShotServices).toEqual(['seedbed-operator']);
    expect(render.yaml).toContain('127.0.0.1:${WORKSHOP_PORT}:4317');
    expect(render.yaml).toContain('serve", "--config", "/app/seedbed/workshop.config.json"');
    expect(render.yaml).toContain('/health/ready');
    expect(render.yaml).not.toMatch(/0\.0\.0\.0:\$\{WORKSHOP_PORT\}/u);
    expect(render.yaml).not.toContain('waystone:\n');
    expect(render.yaml).toContain('source: ${WAYSTONE_ASSET_DIRECTORY}');
    expect(render.yaml).toContain('target: /srv/waystone');
    expect(render.yaml).toContain('no-new-privileges:true');
    expect(render.yaml).toContain('cap_drop: ["ALL"]');
    expect(render.yaml).toContain('read_only: true');
    expect(render.yaml).toContain('QDRANT__STORAGE__SNAPSHOTS_PATH: /qdrant/storage/snapshots');
    expect(render.yaml).toContain('QDRANT__TELEMETRY_DISABLED: "true"');
    expect(render.yaml).not.toMatch(/bearer.*=/iu);
  });

  it('binds the exact declarative semantic profile and mounts only referenced protected selectors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-semantic-'));
    const base = fixtureConfig(root);
    const credentialPath = join(root, 'semantic-provider');
    await writeFile(credentialPath, 'protected-value-never-rendered');
    const input = {
      ...base,
      compose: {
        ...base.compose,
        profiles: [] as const,
      },
      semantic: {
        configuration: {
          version: 1 as const,
          id: 'local-embeddings',
          name: 'Local embeddings',
          provider: {
            kind: 'openai-compatible' as const,
            endpoint: 'https://api.openai.com/v1',
            model: 'text-embedding-3-small',
            dimensions: 1536,
            metric: 'cosine' as const,
            credentialSelector: 'openai-profile',
            allowPrivateEndpoint: true,
            redirectPolicy: 'error' as const,
          },
          vector: { kind: 'sqlite' as const },
        },
        expectedRevision: 0,
        credentialSelectors: [{ id: 'openai-profile', kind: 'protected-file-v1' as const, path: credentialPath }],
      },
    };
    const config = validateConfig(input, { projectDirectory: process.cwd() });
    const render = renderCompose(config);
    assertSafeComposeEnvironment(render.environment);
    expect(render.yaml.match(/source: gnolith-semantic-/gu)).toHaveLength(2);
    expect(Object.values(render.environment)).toContain(credentialPath);
    expect(JSON.stringify(render)).not.toContain('protected-value-never-rendered');
    expect(() => validateConfig({
      ...input,
      semantic: {
        ...input.semantic,
        credentialSelectors: [],
      },
    }, { projectDirectory: process.cwd() })).toThrow(/exactly the referenced/u);
    expect(() => validateConfig({
      ...input,
      semantic: {
        ...input.semantic,
        credentialSelectors: [{
          id: 'openai-profile',
          kind: 'protected-file-v1',
          path: join(process.cwd(), 'semantic-profile'),
        }],
      },
    }, { projectDirectory: process.cwd() })).toThrow(/outside the project/u);
    expect(() => validateConfig({
      ...input,
      semantic: {
        ...input.semantic,
        configuration: {
          ...input.semantic.configuration,
          provider: {
            ...input.semantic.configuration.provider,
            endpoint: 'http://127.0.0.1:11434',
            allowPrivateEndpoint: false,
          },
        },
      },
    }, { projectDirectory: process.cwd() })).toThrow(/private endpoint/u);
    expect(() => validateConfig({
      ...input,
      compose: {
        ...input.compose,
        profiles: ['ollama'],
        ollamaImage: `ollama/ollama@sha256:${'2'.repeat(64)}`,
      },
      semantic: {
        ...input.semantic,
        configuration: {
          ...input.semantic.configuration,
          provider: {
            ...input.semantic.configuration.provider,
            kind: 'ollama-compatible',
            endpoint: 'http://ollama:11434',
            model: 'nomic-embed-text',
            dimensions: 768,
            allowPrivateEndpoint: true,
          },
        },
      },
    }, { projectDirectory: process.cwd() })).toThrow(/immutable model artifact selector and digest/u);
    const qdrant = validateConfig({
      ...input,
      compose: {
        ...input.compose,
        profiles: ['qdrant'],
        qdrantVolume: 'gnolith-qdrant-test',
        qdrantImage: `qdrant/qdrant@sha256:${'3'.repeat(64)}`,
      },
      semantic: {
        ...input.semantic,
        configuration: {
          ...input.semantic.configuration,
          vector: {
            kind: 'qdrant',
            endpoint: 'http://qdrant:6333',
            collection: 'gnolith-test',
            credentialSelector: null,
            allowPrivateEndpoint: true,
            redirectPolicy: 'error',
          },
        },
      },
    }, { projectDirectory: process.cwd() });
    expect(renderCompose(qdrant).yaml).toContain('\n  qdrant:\n');
  });

  it('mounts the protected bearer only for offline bootstrap and semantic configuration operators', () => {
    const tokenFile = 'C:\\protected\\bearer';
    const expected = ['--volume', `${tokenFile}:/run/secrets/gnolith-bearer:ro`];
    expect(protectedOperatorMountArgs('workshop-bootstrap-v1', tokenFile)).toEqual(expected);
    expect(protectedOperatorMountArgs('workshop-semantic-configure-v1', tokenFile)).toEqual(expected);
    expect(protectedOperatorMountArgs('owner-migration-apply-v1', tokenFile)).toEqual([]);
    expect(JSON.stringify(renderCompose(fixtureConfig(process.cwd())))).not.toContain(tokenFile);
  });

  it('stages only SHA-verified regular package artifacts into the external-state local build context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-build-context-'));
    const base = fixtureConfig(root);
    const artifactRoot = join('artifacts', `test-${basename(root)}`);
    await mkdir(artifactRoot, { recursive: true });
    const packages = {
      diamond: { ...base.packages.diamond, artifact: `${artifactRoot.replaceAll('\\', '/')}/diamond.tgz` },
      taproot: { ...base.packages.taproot, artifact: `${artifactRoot.replaceAll('\\', '/')}/taproot.tgz` },
      workshop: { ...base.packages.workshop, artifact: `${artifactRoot.replaceAll('\\', '/')}/workshop.tgz` },
    };
    for (const owner of ['diamond', 'taproot', 'workshop'] as const) {
      const bytes = Buffer.from(`${owner}-candidate`);
      await writeFile(packages[owner].artifact, bytes);
      packages[owner] = { ...packages[owner], sha256: sha256(bytes) };
    }
    const config = { ...base, packages };
    try {
      await new DockerComposeDriver(process.cwd()).prepare(config);
      expect(await readFile(join(config.paths.stateDirectory, 'compose', 'build', ...packages.workshop.artifact.split('/')), 'utf8')).toBe('workshop-candidate');
      const compose = await readFile(join(config.paths.stateDirectory, 'compose', 'compose.yaml'), 'utf8');
      expect(compose).toContain('context: ./build');
      const workshopConfig = JSON.parse(await readFile(join(config.paths.stateDirectory, 'compose', 'build', 'workshop.config.json'), 'utf8'));
      expect(workshopConfig).toEqual(expect.objectContaining({
        format: 'gnolith-workshop-config-v1',
        listener: { host: '0.0.0.0', port: 4317, profile: 'container' },
        authentication: {
          profile: 'local-bearer-v1',
          credentialStore: { kind: 'file', value: '/run/secrets/gnolith-bearer' },
        },
        adapterModule: './workshop-local-adapter.mjs',
      }));
      const assemblyConfigText = await readFile(join(config.paths.stateDirectory, 'compose', 'build', 'assembly.config.json'), 'utf8');
      expect(assemblyConfigText).not.toContain('token');
      expect(JSON.parse(assemblyConfigText)).toEqual(expect.objectContaining({
        installationId: config.installationId,
        baseIri: config.baseIri,
        principalId: config.authentication.credentialId,
        workspaceId: 'default',
      }));
      await expect(new DockerComposeDriver(process.cwd()).prepare({ ...config, packages: { ...packages, taproot: { ...packages.taproot, sha256: '0'.repeat(64) } } })).rejects.toThrow(/digest mismatch/u);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('verifies and stages one immutable Waystone manifest without adding a UI service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-waystone-'));
    const base = fixtureConfig(root);
    const artifactRoot = join('artifacts', `test-${basename(root)}`);
    await mkdir(artifactRoot, { recursive: true });
    const packageFiles = {} as Record<'diamond' | 'taproot' | 'workshop', { version: string; artifact: string; sha256: string; sourceCommit: string }>;
    for (const owner of ['diamond', 'taproot', 'workshop'] as const) {
      const artifact = `${artifactRoot.replaceAll('\\', '/')}/${owner}.tgz`;
      const bytes = Buffer.from(`${owner}-candidate`);
      await writeFile(artifact, bytes);
      packageFiles[owner] = { ...base.packages[owner], artifact, sha256: sha256(bytes) };
    }
    const manifestPath = `${artifactRoot.replaceAll('\\', '/')}/waystone-assets.json`;
    const asset = Buffer.from('body{color:#123}');
    await writeFile(`${artifactRoot.replaceAll('\\', '/')}/waystone.css`, asset);
    const unsignedManifest = {
      format: 'waystone-assets-v1',
      entrypoint: 'assets/waystone.css',
      files: [{ path: 'assets/waystone.css', sha256: sha256(asset), bytes: asset.byteLength, mediaType: 'text/css', immutable: true }],
    };
    const manifest = Buffer.from(canonicalJson({ ...unsignedManifest, manifestSha256: sha256(canonicalJson(unsignedManifest)) }));
    await writeFile(manifestPath, manifest);
    const config = {
      ...base,
      packages: {
        ...packageFiles,
        waystone: { version: '0.4.0-candidate.1', artifact: manifestPath, sha256: sha256(manifest), sourceCommit: 'f'.repeat(40) },
      },
      compose: { ...base.compose, profiles: ['waystone'] as const },
    };
    try {
      await new DockerComposeDriver(process.cwd()).prepare(config);
      await new DockerComposeDriver(process.cwd()).prepare(config);
      expect(await readFile(join(config.paths.stateDirectory, 'compose', 'waystone', 'waystone-assets.json'), 'utf8')).toBe(manifest.toString());
      expect(await readFile(join(config.paths.stateDirectory, 'compose', 'waystone', 'assets', 'waystone.css'), 'utf8')).toBe(asset.toString());
      expect(JSON.parse(await readFile(join(config.paths.stateDirectory, 'compose', 'build', 'workshop.config.json'), 'utf8')).assetMount.prefix).toBe('/app');
      const compose = await readFile(join(config.paths.stateDirectory, 'compose', 'compose.yaml'), 'utf8');
      expect(compose).not.toContain('\n  waystone:');
      expect(compose).toContain('source: ${WAYSTONE_ASSET_DIRECTORY}');
      await expect(new DockerComposeDriver(process.cwd()).prepare({
        ...config,
        packages: { ...config.packages, waystone: { ...config.packages.waystone, sha256: '0'.repeat(64) } },
      })).rejects.toThrow(/digest mismatch/u);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
