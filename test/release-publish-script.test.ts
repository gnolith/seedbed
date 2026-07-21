import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('release publish script', () => {
  let publishScript: string;
  const temporaryDirectories: string[] = [];

  beforeAll(async () => {
    const workflowSource = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const workflow = parse(workflowSource) as ReleaseWorkflow;
    const step = workflow.jobs.publish.steps.find(
      ({ name }) => name === 'Reverify and publish with npm trusted publishing',
    );
    if (typeof step?.run !== 'string') throw new Error('publish script is missing from parsed release workflow');
    publishScript = step.run;
  });

  afterAll(async () => {
    await Promise.all(temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })));
  });

  it('is valid Bash after YAML block-scalar processing', () => {
    const result = spawnSync('bash', ['-n'], { encoding: 'utf8', input: publishScript });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(publishScript).toContain("\nNODE\n");
  });

  it.skipIf(process.platform === 'win32')('executes safe recovery and postpublish propagation paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-publish-script-'));
    temporaryDirectories.push(root);
    const publicationDirectory = join(root, 'npm-publication');
    const packageDirectory = join(root, 'package-source');
    const mockBin = join(root, 'mock-bin');
    await Promise.all([
      mkdir(publicationDirectory, { recursive: true }),
      mkdir(packageDirectory, { recursive: true }),
      mkdir(mockBin, { recursive: true }),
    ]);

    const version = '0.1.1';
    const commit = 'a'.repeat(40);
    const sourceManifest = join(packageDirectory, 'package.json');
    await writeFile(sourceManifest, JSON.stringify({ name: '@gnolith/seedbed', version }));
    const initialTarball = join(root, 'publication.tgz');
    execFileSync('tar', [
      '--create', '--gzip', '--file', initialTarball,
      '--transform', 's,^package.json$,package/package.json,',
      '--directory', packageDirectory, 'package.json',
    ]);
    const tarballBytes = await readFile(initialTarball);
    const sha256 = createHash('sha256').update(tarballBytes).digest('hex');
    const sha512 = createHash('sha512').update(tarballBytes).digest('hex');
    const integrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`;
    const filename = `seedbed-publication-${sha256}.tgz`;
    const tarball = join(publicationDirectory, filename);
    await writeFile(tarball, tarballBytes);
    await writeFile(join(publicationDirectory, 'seedbed-publication.json'), JSON.stringify({
      filename,
      name: '@gnolith/seedbed',
      sha256,
      version,
    }));

    const attestationUrl = `https://registry.npmjs.org/-/npm/v1/attestations/@gnolith%2fseedbed@${version}`;
    const registryResponse = join(root, 'registry.json');
    await writeFile(registryResponse, JSON.stringify({
      name: '@gnolith/seedbed',
      version,
      dist: {
        attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' }, url: attestationUrl },
        integrity,
      },
    }));
    const rootPackumentResponse = join(root, 'root-packument.json');
    await writeFile(rootPackumentResponse, JSON.stringify({
      name: '@gnolith/seedbed',
      versions: {
        [version]: {
          name: '@gnolith/seedbed',
          version,
          dist: { integrity },
        },
      },
    }));
    const statement = {
      _type: 'https://in-toto.io/Statement/v1',
      predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{ digest: { sha512 }, name: `pkg:npm/%40gnolith/seedbed@${version}` }],
      predicate: { buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: { workflow: {
          path: '.github/workflows/release.yml',
          ref: `refs/tags/v${version}`,
          repository: 'https://github.com/gnolith/seedbed',
        } },
        resolvedDependencies: [{
          digest: { gitCommit: commit },
          uri: `git+https://github.com/gnolith/seedbed@refs/tags/v${version}`,
        }],
      } },
    };
    const attestationResponse = join(root, 'attestations.json');
    await writeFile(attestationResponse, JSON.stringify({ attestations: [{
      bundle: { dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
        payloadType: 'application/vnd.in-toto+json',
      } },
      predicateType: 'https://slsa.dev/provenance/v1',
    }] }));

    await writeExecutable(join(mockBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
output=''
write_status=false
url=''
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --write-out) write_status=true; shift 2 ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" == *'/attestations/'* ]]; then
  cp "$MOCK_ATTESTATION_RESPONSE" "$output"
elif [[ "$url" == "$MOCK_ROOT_PACKUMENT_URL" ]]; then
  count=0
  if [[ -f "$MOCK_ROOT_REQUEST_COUNT" ]]; then count=$(cat "$MOCK_ROOT_REQUEST_COUNT"); fi
  count=$((count + 1))
  printf '%s' "$count" > "$MOCK_ROOT_REQUEST_COUNT"
  if ((count == 1)); then
    printf '{}' > "$output"
    if $write_status; then printf '404'; fi
  else
    cp "$MOCK_ROOT_PACKUMENT_RESPONSE" "$output"
    if $write_status; then printf '200'; fi
  fi
else
  version_status=200
  if [[ "\${MOCK_INITIAL_VERSION_404:-false}" == true ]]; then
    count=0
    if [[ -f "$MOCK_VERSION_REQUEST_COUNT" ]]; then count=$(cat "$MOCK_VERSION_REQUEST_COUNT"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$MOCK_VERSION_REQUEST_COUNT"
    if ((count == 1)); then version_status=404; fi
  fi
  if ((version_status == 200)); then cp "$MOCK_REGISTRY_RESPONSE" "$output"; else printf '{}' > "$output"; fi
  if $write_status; then printf '%s' "$version_status"; fi
fi
`);
    await writeExecutable(join(mockBin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    await writeExecutable(join(mockBin, 'npm'), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-} \${2:-}" in
  'init --yes') exit 0 ;;
  'install --ignore-scripts')
    mkdir -p node_modules/@gnolith/seedbed
    cp "$MOCK_INSTALLED_MANIFEST" node_modules/@gnolith/seedbed/package.json
    cp "$MOCK_INSTALLED_LOCK" package-lock.json
    ;;
  'audit signatures')
    echo '1 package has a verified attestation'
    ;;
  'publish '*)
    if [[ "\${MOCK_ALLOW_PUBLISH:-false}" != true ]]; then
      echo 'publish must not run during recovery test' >&2
      exit 90
    fi
    printf '%s\n' "$*" > "$MOCK_PUBLISH_LOG"
    ;;
  *) echo "unexpected npm invocation: $*" >&2; exit 91 ;;
esac
`);
    const installedManifest = join(root, 'installed-package.json');
    const installedLock = join(root, 'installed-lock.json');
    await writeFile(installedManifest, JSON.stringify({ name: '@gnolith/seedbed', version }));
    await writeFile(installedLock, JSON.stringify({
      packages: { 'node_modules/@gnolith/seedbed': { integrity } },
    }));

    const result = spawnSync('bash', [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPECTED_ARTIFACT_DIGEST: 'b'.repeat(64),
        EXPECTED_ARTIFACT_ID: '12345',
        EXPECTED_COMMIT: commit,
        EXPECTED_SHA256: sha256,
        MOCK_ATTESTATION_RESPONSE: attestationResponse,
        MOCK_INSTALLED_LOCK: installedLock,
        MOCK_INSTALLED_MANIFEST: installedManifest,
        MOCK_REGISTRY_RESPONSE: registryResponse,
        MOCK_ROOT_PACKUMENT_RESPONSE: rootPackumentResponse,
        MOCK_ROOT_PACKUMENT_URL: 'https://registry.npmjs.org/@gnolith%2fseedbed',
        MOCK_ROOT_REQUEST_COUNT: join(root, 'root-request-count'),
        PATH: `${mockBin}${delimiter}${process.env.PATH ?? ''}`,
        RELEASE_TAG: `v${version}`,
        RUNNER_TEMP: root,
      },
      input: publishScript,
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('packument and install evidence is not yet complete (attempt 1/12)');
    expect(result.stdout).toContain('publication recovery is complete');
    expect(result.status).toBe(0);

    await rm(join(root, 'root-request-count'), { force: true });
    const publishLog = join(root, 'publish.log');
    const publishResult = spawnSync('bash', [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPECTED_ARTIFACT_DIGEST: 'b'.repeat(64),
        EXPECTED_ARTIFACT_ID: '12345',
        EXPECTED_COMMIT: commit,
        EXPECTED_SHA256: sha256,
        MOCK_ALLOW_PUBLISH: 'true',
        MOCK_ATTESTATION_RESPONSE: attestationResponse,
        MOCK_INITIAL_VERSION_404: 'true',
        MOCK_INSTALLED_LOCK: installedLock,
        MOCK_INSTALLED_MANIFEST: installedManifest,
        MOCK_PUBLISH_LOG: publishLog,
        MOCK_REGISTRY_RESPONSE: registryResponse,
        MOCK_ROOT_PACKUMENT_RESPONSE: rootPackumentResponse,
        MOCK_ROOT_PACKUMENT_URL: 'https://registry.npmjs.org/@gnolith%2fseedbed',
        MOCK_ROOT_REQUEST_COUNT: join(root, 'root-request-count'),
        MOCK_VERSION_REQUEST_COUNT: join(root, 'version-request-count'),
        PATH: `${mockBin}${delimiter}${process.env.PATH ?? ''}`,
        RELEASE_TAG: `v${version}`,
        RUNNER_TEMP: root,
      },
      input: publishScript,
    });
    expect(publishResult.stderr).toBe('');
    expect(publishResult.stdout).toContain('packument and install evidence is not yet complete (attempt 1/12)');
    expect(publishResult.status).toBe(0);
    expect(await readFile(publishLog, 'utf8')).toContain(
      `publish ${tarball} --ignore-scripts --access public --provenance`,
    );
  });
});

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

type ReleaseWorkflow = {
  jobs: { publish: { steps: Array<{ name?: string; run?: string }> } };
};
