import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

describe('release credential boundary', () => {
  let workflow: string;
  let packageJob: string;
  let publishJob: string;
  let imageJob: string;
  let releaseJob: string;

  beforeAll(async () => {
    workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    packageJob = between(workflow, '  package:', '  publish:');
    publishJob = between(workflow, '  publish:', '  image:');
    imageJob = between(workflow, '  image:', '  release:');
    releaseJob = workflow.slice(workflow.indexOf('  release:'));
  });

  it('runs only for version tags and proves the annotated tag identity', () => {
    expect(workflow).toMatch(/push:\r?\n    tags: \['v\*'\]/u);
    expect(workflow).not.toContain('types: [published]');
    expect(packageJob).toContain('fetch-depth: 0');
    expect(packageJob).toContain('git cat-file -t "refs/tags/$tag"');
    expect(packageJob).toContain('git rev-parse "refs/tags/$tag^{commit}"');
    expect(packageJob).toContain('test "$tag_commit" = "$(git rev-parse HEAD)"');
    expect(packageJob).toContain('test "$tag_commit" = "${{ github.sha }}"');
    expect(packageJob).toContain('git fetch --no-tags origin main');
    expect(packageJob).toContain('git merge-base --is-ancestor "$tag_commit" origin/main');
    expect(packageJob).toContain("require('./package.json').version");
    expect(packageJob).toContain('vars.IMMUTABLE_RELEASES_VERIFIED_FOR');
    expect(packageJob).toContain('= "$tag"');
  });

  it('keeps packing and repository execution outside the protected environment', () => {
    expect(packageJob).toContain('npm run check');
    expect(packageJob).toContain('actions/upload-artifact@');
    expect(packageJob).toContain('seedbed-publication-$sha256.tgz');
    expect(packageJob).not.toContain('environment: release');
    expect(packageJob).not.toContain('NODE_AUTH_TOKEN');
  });

  it('uses a fresh no-checkout runner for OIDC-only trusted publishing', () => {
    expect(publishJob).toContain('needs: package');
    expect(publishJob).toContain('environment: release');
    expect(publishJob).toMatch(/permissions:\r?\n      id-token: write\r?\n/u);
    expect(publishJob).not.toContain('contents: read');
    expect(publishJob).not.toContain('actions: read');
    expect(publishJob).toContain('actions/download-artifact@');
    expect(publishJob).not.toContain('actions/checkout@');
    expect(publishJob).not.toContain('actions/setup-node@');
    expect(publishJob).not.toContain('./.github/');
    expect(publishJob).not.toMatch(/\bnpm (?:ci|run|pack|exec)\b/u);
    expect(workflow).not.toContain('NPM_BOOTSTRAP_TOKEN');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
    expect(workflow).not.toContain('_authToken');
    expect(workflow).not.toContain('npm-bootstrap.npmrc');
    const finalStep = publishJob.lastIndexOf('      - name:');
    expect(finalStep).toBeGreaterThan(-1);
    expect(publishJob.slice(finalStep)).toContain('npm publish "$tarball"');
  });

  it('revalidates a regular content-addressed tarball immediately before publishing', () => {
    expect(publishJob).toContain('test ! -L "$tarball"');
    expect(publishJob).toContain('stat -c %F "$tarball"');
    expect(publishJob).toContain('sha256sum "$tarball"');
    expect(publishJob).toContain("name.startswith(('/', '\\\\'))");
    expect(publishJob).toContain("part in ('', '.', '..')");
    expect(publishJob).toContain('control character in archive path');
    expect(publishJob).toContain("parts[0] != 'package'");
    expect(publishJob).toContain("member.name == 'package/package.json'");
    expect(publishJob).toContain("len(manifests) != 1");
    expect(publishJob).toContain("readFileSync(process.argv[1], 'utf8')).name");
    expect(publishJob).toContain("readFileSync(process.argv[1], 'utf8')).version");
    expect(publishJob).toContain('npm publish "$tarball" --ignore-scripts --access public --provenance');
  });

  it('binds the immutable handoff and supports exact already-published recovery', () => {
    expect(packageJob).toContain('artifact_id: ${{ steps.upload.outputs.artifact-id }}');
    expect(packageJob).toContain('artifact_digest: ${{ steps.upload.outputs.artifact-digest }}');
    expect(packageJob).toContain('retention-days: 30');
    expect(packageJob).toContain('seedbed-npm-$sha256-attempt-$RUN_ATTEMPT');
    expect(publishJob).toContain('artifact-ids: ${{ needs.package.outputs.artifact_id }}');
    expect(publishJob).toContain('EXPECTED_ARTIFACT_DIGEST');
    expect(publishJob).toContain('RELEASE_TAG: ${{ github.ref_name }}');
    expect(publishJob).not.toContain('needs.package.outputs.version');
    expect(publishJob).not.toContain('EXPECTED_NAME');
    expect(publishJob).not.toContain('EXPECTED_VERSION');
    expect(publishJob).toContain('The exact npm artifact is already public');
    expect(publishJob).toContain("dist.integrity");
  });

  it('fails closed unless exact npm provenance verifies in recovery and publish paths', () => {
    expect(publishJob).toContain("dist.attestations?.url || ''");
    expect(publishJob).toContain("dist.attestations?.provenance?.predicateType || ''");
    expect(publishJob).toContain('https://slsa.dev/provenance/v1');
    expect(publishJob).toContain('npm install --ignore-scripts --save-exact "@gnolith/seedbed@$expected_version"');
    expect(publishJob).toContain("packages['node_modules/@gnolith/seedbed'].integrity");
    expect(publishJob).toContain('npm audit signatures');
    expect(publishJob).toContain('verified attestations?');
    expect(publishJob).toContain('root_packument_url="https://registry.npmjs.org/@gnolith%2fseedbed"');
    expect(publishJob).toContain('packument.versions?.[version]');
    expect(publishJob).toContain('wait_for_registry');
    expect(publishJob).toContain('Exact npm packument and install evidence is not yet complete');
    expect(publishJob).toContain("subjects[0].name !== `pkg:npm/%40gnolith/seedbed@${version}`");
    expect(publishJob).toContain("subjects[0].digest?.sha512 !== sha512");
    expect(publishJob).toContain("workflow?.repository !== 'https://github.com/gnolith/seedbed'");
    expect(publishJob).toContain("workflow?.path !== '.github/workflows/release.yml'");
    expect(publishJob).toContain('workflow?.ref !== ref');
    expect(publishJob).toContain("source[0].digest?.gitCommit !== commit");
    expect(publishJob).toContain('EXPECTED_COMMIT: ${{ github.sha }}');
    expect(publishJob.match(/verify_registry_provenance/gu)).toHaveLength(3);
    expect(publishJob.indexOf('verify_registry_provenance')).toBeLessThan(
      publishJob.indexOf('publication recovery is complete'),
    );
  });

  it('rejects missing or mismatched provenance identity evidence', () => {
    const expected = {
      commit: 'a'.repeat(40),
      ref: 'refs/tags/v0.1.1',
      sha512: 'b'.repeat(128),
      version: '0.1.1',
    };
    const valid = provenanceFixture(expected);
    expect(() => validateProvenanceIdentity(valid, expected)).not.toThrow();
    const invalid = [
      undefined,
      { ...valid, predicateType: 'https://example.test/not-provenance' },
      { ...valid, subject: [{ ...valid.subject[0]!, digest: { sha512: 'c'.repeat(128) } }] },
      withWorkflow(valid, { repository: 'https://github.com/attacker/seedbed' }),
      withWorkflow(valid, { path: '.github/workflows/other.yml' }),
      withWorkflow(valid, { ref: 'refs/tags/v9.9.9' }),
      {
        ...valid,
        predicate: {
          ...valid.predicate,
          buildDefinition: {
            ...valid.predicate.buildDefinition,
            resolvedDependencies: [{
              digest: { gitCommit: 'd'.repeat(40) },
              uri: `git+https://github.com/gnolith/seedbed@${expected.ref}`,
            }],
          },
        },
      },
    ];
    for (const statement of invalid) {
      expect(() => validateProvenanceIdentity(statement, expected)).toThrow();
    }
  });

  it('uses only policy-compatible pinned artifact actions', () => {
    expect(packageJob).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/u);
    expect(publishJob).toMatch(/actions\/download-artifact@[0-9a-f]{40}/u);
    expect(publishJob).not.toContain('actions/setup-node@');
    expect(publishJob).toContain('41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df');
  });

  it('gates the image job on successful OIDC publication', () => {
    expect(imageJob).toMatch(/^  image:\r?\n    needs: \[package, publish\]/mu);
    expect(imageJob).not.toContain('needs.npm.outputs');
  });

  it('stages verified exact component artifacts for the release image', () => {
    for (const [name, version, sha256] of ([
      ['diamond', '0.4.0', 'ac8e34810a8504bd891b36a199973f2d65ef652555644813c7a36f1c7016c9d2'],
      ['taproot', '0.3.0', '2faf3d9bce7811da3fd61629a4cd8b63bb0a6de861d77347030b216ff3ccc347'],
      ['workshop', '0.3.3', 'c2bc2f3763a3d693662b584d0ed2270936644ab3d23ecd699f0f8b4a2ed0cdc3'],
    ] as const)) {
      expect(imageJob).toContain(`stage_component '@gnolith/${name}' '${version}' 'gnolith-${name}-${version}.tgz'`);
      expect(imageJob).toContain(sha256);
    }
    expect(imageJob).toContain("dist.attestations?.provenance?.predicateType || ''");
    expect(imageJob).toContain('npm audit signatures');
    expect(imageJob).toContain('bash scripts/build-production-closure.sh');
    expect(imageJob).toContain('"$(cat npm-integrity.txt)"');
    expect(imageJob).toContain('--build-arg PRODUCTION_CLOSURE_SHA256="$CLOSURE_SHA256"');
    expect(imageJob).toContain('org.gnolith.production-closure.sha256');
    expect(imageJob).toContain('SEEDBED_CLOSURE_SHA256: ${{ steps.closure.outputs.sha256 }}');
  });

  it('fails closed before publication and never overwrites an existing version', () => {
    expect(packageJob).toContain('release-preflight.mjs npm');
    expect(packageJob).toContain('release-preflight.mjs ghcr');
    expect(packageJob).toContain('release-preflight.mjs release');
    expect(workflow).not.toContain('repos/gnolith/seedbed/immutable-releases');
    expect(publishJob).toContain('test "$registry_status" = 404');
    expect(imageJob).toContain('if test "$state" = absent');
    expect(imageJob).toContain('elif test "$state" = match');
    expect(workflow).not.toContain('set -x');
  });

  it('verifies the exact image before moving latest and creates the immutable release last', () => {
    const verifyImage = imageJob.indexOf('Verify the exact immutable version image and extract its SBOM');
    const moveLatest = imageJob.indexOf('Move latest only after exact version verification');
    expect(verifyImage).toBeGreaterThan(-1);
    expect(moveLatest).toBeGreaterThan(verifyImage);
    expect(releaseJob).toMatch(/^  release:\r?\n    needs: \[package, publish, image\]/mu);
    expect(releaseJob).toContain('Create or recover the immutable GitHub Release last');
    expect(releaseJob).toContain('gh release create "$RELEASE_TAG"');
    expect(releaseJob).toContain('gh release verify "$RELEASE_TAG"');
    expect(releaseJob).toContain('gh release verify-asset "$RELEASE_TAG" "$local_asset"');
    expect(releaseJob).toContain('isImmutable');
    expect(releaseJob).toContain('IMMUTABLE_SETTING_EVIDENCE_TAG');
    expect(releaseJob).toContain('seedbed-release-evidence-$evidence_sha.json');
    expect(releaseJob).toContain('seedbed-production-closure-$CLOSURE_SHA256.tar.gz');
    expect(imageJob).toContain('image-evidence/image-manifest.json');
    expect(imageJob).toContain('image-evidence/image-sbom.json');
    expect(imageJob).toContain('image-evidence/image-provenance-verification.json');
    expect(imageJob).toContain('release-preflight.mjs attestation');
    expect(imageJob).toContain("if: steps.attestation-preflight.outputs.state == 'absent'");
    expect(imageJob).toContain('uses: actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6');
    expect(imageJob).toContain('--signer-workflow gnolith/seedbed/.github/workflows/release.yml');
    expect(imageJob).toContain('RELEASE_REF: ${{ github.ref }}');
    expect(imageJob).toContain('RELEASE_COMMIT: ${{ github.sha }}');
    expect(imageJob).toContain('--source-ref "$RELEASE_REF"');
    expect(imageJob).toContain('--source-digest "$RELEASE_COMMIT"');
    expect(releaseJob).toContain('needs.image.outputs.evidence_artifact_id');
    expect(releaseJob).toContain('seedbed-image-manifest-$manifest_sha.json');
    expect(releaseJob).toContain('seedbed-image-sbom-$image_sbom_sha.json');
    expect(releaseJob).toContain('seedbed-image-provenance-verification-$provenance_sha.json');
    expect(releaseJob).not.toMatch(/NPM_ARTIFACT_ID|STAGING_ARTIFACT_ID|IMAGE_EVIDENCE_ARTIFACT_ID/u);
    expect(workflow.match(/gh release create/gu)).toHaveLength(1);
  });

  it('serializes releases, prevents latest downgrade, and resumes partial drafts without clobbering', () => {
    expect(workflow).toContain('group: seedbed-release');
    expect(workflow).not.toContain('group: seedbed-release-${{ github.ref }}');
    expect(imageJob).toContain('Leaving newer latest version $latest_version unchanged.');
    expect(releaseJob).toContain('current_latest_version');
    expect(releaseJob).toContain('gh release upload "$RELEASE_TAG" "$local_asset"');
    expect(releaseJob).not.toContain('--clobber');
  });

  it('keeps complete Site ownership outside the package release', () => {
    expect(workflow).not.toMatch(/cloudflare|wrangler|sites deploy|complete[- ]site acceptance/iu);
  });
});

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) throw new Error(`missing workflow boundary: ${start} -> ${end}`);
  return source.slice(startIndex, endIndex);
}

type ExpectedProvenance = { commit: string; ref: string; sha512: string; version: string };
type ProvenanceStatement = ReturnType<typeof provenanceFixture>;

function provenanceFixture(expected: ExpectedProvenance) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{
      digest: { sha512: expected.sha512 },
      name: `pkg:npm/%40gnolith/seedbed@${expected.version}`,
    }],
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: { workflow: {
          path: '.github/workflows/release.yml',
          ref: expected.ref,
          repository: 'https://github.com/gnolith/seedbed',
        } },
        resolvedDependencies: [{
          digest: { gitCommit: expected.commit },
          uri: `git+https://github.com/gnolith/seedbed@${expected.ref}`,
        }],
      },
    },
  };
}

function withWorkflow(statement: ProvenanceStatement, change: Record<string, string>): ProvenanceStatement {
  return {
    ...statement,
    predicate: {
      ...statement.predicate,
      buildDefinition: {
        ...statement.predicate.buildDefinition,
        externalParameters: {
          workflow: { ...statement.predicate.buildDefinition.externalParameters.workflow, ...change },
        },
      },
    },
  };
}

function validateProvenanceIdentity(statement: ProvenanceStatement | undefined, expected: ExpectedProvenance): void {
  if (!statement || statement._type !== 'https://in-toto.io/Statement/v1') throw new Error('missing statement');
  if (statement.predicateType !== 'https://slsa.dev/provenance/v1') throw new Error('invalid predicate');
  if (statement.subject.length !== 1) throw new Error('invalid subjects');
  const subject = statement.subject[0];
  if (!subject || subject.name !== `pkg:npm/%40gnolith/seedbed@${expected.version}`) throw new Error('invalid subject');
  if (subject.digest.sha512 !== expected.sha512) throw new Error('invalid digest');
  const build = statement.predicate.buildDefinition;
  if (build.buildType !== 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1') throw new Error('invalid build type');
  const workflow = build.externalParameters.workflow;
  if (workflow.repository !== 'https://github.com/gnolith/seedbed') throw new Error('invalid repository');
  if (workflow.path !== '.github/workflows/release.yml') throw new Error('invalid workflow');
  if (workflow.ref !== expected.ref) throw new Error('invalid ref');
  const source = build.resolvedDependencies.filter(
    ({ uri }) => uri === `git+https://github.com/gnolith/seedbed@${expected.ref}`,
  );
  if (source.length !== 1 || source[0]?.digest.gitCommit !== expected.commit) throw new Error('invalid commit');
}
