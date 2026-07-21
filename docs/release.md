# Release process

Seedbed is published from an immutable GitHub Release whose `vX.Y.Z` tag exactly
matches `package.json`. Configure npm trusted publishing for the `release.yml`
workflow in `gnolith/seedbed` and the protected `release` environment. GitHub's
`packages: write` permission publishes the public GHCR image.

Repository-level immutable releases are enabled through GitHub's supported
`immutable-releases` setting. GitHub applies that setting only to Releases created
after enablement, so every new release must report `immutable: true` through the
release API. Active no-bypass tag ruleset `19395217` independently blocks updates
and deletion for `refs/tags/v*`.

The npm trusted publisher is restricted to `gnolith/seedbed`, `release.yml`, the
protected `release` environment, and the `npm publish` workflow event. Token
publishing is disallowed, and the GitHub environment contains no npm token secret.
The workflow packs and verifies the exact publication tarball in a credential-free
job, names it by its SHA-256 digest, and uploads it for 30 days with expected digest,
package-name, and version metadata. The repository's selected-actions policy permits
SHA-pinned GitHub-owned upload/download artifact actions; the immutable artifact ID
and service digest independently bind the handoff. A fresh protected-environment
runner with no checkout downloads that exact artifact and installs Node from a
pinned, SHA-verified archive rather than a setup action. Its only repository
permission is OIDC token issuance. The terminal trusted-publishing step derives the
expected version directly from the validated release tag, rejects links, non-regular
or ambiguous paths, outside-package entries, and duplicate manifests, then
recomputes and checks all metadata. It publishes only the absolute verified-tarball
path with lifecycle scripts disabled, so no repository-controlled content or process
shares the runner.

The terminal step is idempotent: if that exact name, version, and SHA-512 integrity
already exist on npm, it also requires the exact SLSA v1 attestation endpoint and a
successful `npm audit signatures` verification before recording recovery success.
Missing or invalid provenance fails closed. After a new publish it waits for and
verifies the same integrity and provenance evidence before the image job can run.
Registry readiness requires the exact-version document, the corresponding entry in
the root packument, and a successful ordinary exact-version install with matching
lockfile integrity. Those checks retry together so a version endpoint that becomes
visible before the root packument cannot prematurely fail an accepted publication.
The decoded SLSA statement must bind its sole npm subject and SHA-512 digest to the
exact `gnolith/seedbed` repository, `.github/workflows/release.yml`, release tag ref,
and tag commit. Cryptographic signature and attestation verification relies on npm's
authoritative registry verification through `npm audit signatures`; the workflow
then inspects the predicate returned by the same immutable registry attestation URL.
It does not claim to perform a second local Sigstore-bundle verification. This and
the 30-day source-artifact retention allow a rerun to recover if npm accepted a
publication before the workflow recorded success. Each rerun uploads a new
attempt-suffixed immutable handoff while retaining the prior attempt's
content-addressed evidence.

The Actions allowlist evidence is reproducible with:

```sh
gh api repos/gnolith/seedbed/actions/permissions
gh api repos/gnolith/seedbed/actions/permissions/selected-actions
```

The 2026-07-21 responses reported `allowed_actions: selected`,
`sha_pinning_required: true`, and `github_owned_allowed: true`. Recheck these live
settings before releasing; the workflow depends only on SHA-pinned GitHub-owned
checkout and artifact actions.

## Dependency release inputs

Seedbed 0.1.1 binds Workshop 0.2.3's source identity to the peeled `v0.2.3` tag
commit `bf168ebd21cc0c4529fc721c1e1ab9b498b4ddd5`. Its assembly, packed-package,
and Docker gates consume the published npm artifact, not a Seedbed-side source
repack. The release input must have SHA-256
`8fafde79477831b1bbe71da9fa0d55e9546e9845bd1689f756668e81341ac791` and npm
integrity
`sha512-WRuAhNyM5xoj6XQyLGSCcDinkPaWSiPi/74VuvY4gR1swpz9pCrZBSVJBA5Cc9Kff6RxulC6gJqPYrsRhrCqGw==`.
CI also verifies its npm registry signature and SLSA provenance, including the
Workshop repository, release workflow, tag ref, and exact source commit.

Workshop's generated source maps can encode build-path differences, so a fresh
source repack is not authoritative for the bytes npm published. Keeping source/tag
verification separate from registry-artifact verification preserves both identities
without incorrectly requiring path-dependent repacks to be byte-identical. The
verified registry tarball is the single Workshop input used by all Seedbed release
acceptance paths.

## Tracked production advisory

The 0.1.1 production tree contains
`@modelcontextprotocol/sdk@1.29.0 -> @hono/node-server@1.19.14`, which is affected by
moderate advisory GHSA-frvp-7c67-39w9 (`@hono/node-server <2.0.5`). The vulnerable
Windows `serve-static` path is not reachable through Seedbed's stdio-only process
surface, and the container is Linux, but the code remains installed. The latest MCP
SDK still constrains Hono to `^1.19.9`; npm's suggested SDK downgrade and an
unsupported Hono major override are not accepted as safe release fixes. Track the
upstream remediation in [issue #11](https://github.com/gnolith/seedbed/issues/11).
The high-severity production audit gate therefore passes with two audit entries for
this one upstream moderate advisory; reviewers must explicitly accept this residual
risk before release.

## Failed 0.1.0 publication evidence

The `v0.1.0` source tag points to commit
`8371d33f9e1d5182ad38d05d15aad1a35dc1bf75` and is protected from update or
deletion by active no-bypass tag ruleset `19395217`. Its GitHub Release predates
repository-level immutable-release enablement and therefore accurately reports
`immutable: false`; it has no attached assets and is frozen by project policy, not
by GitHub's technical Release immutability. Release workflow run
[`29867240910`](https://github.com/gnolith/seedbed/actions/runs/29867240910)
completed the tokenless package job, then stopped before executing any publish
command because Bash rejected an indented heredoc terminator while parsing the
protected runner's inline verifier. The image job was skipped. npm and GHCR both
remained absent for 0.1.0.

The retained attempt-1 handoff has artifact ID `8509697703`, service digest
`sha256:6fdb84c7486fabb4e95e8ef71bbf8d66159449f573e6d61f1e7a969dadf87466`,
tarball SHA-256
`1126ebc52a05369bc26903fc10538972d72630723fa93a926380b0b2bddff47a`, and npm
integrity
`sha512-SPs/YaoenUjS90t3pLQc7RRvnyg9aX8BTf8QiYtw2sco9fTSAEXEUYxfhJkGgzvOBB2mO0cW6L2wUtm+4fpYuQ==`.
The artifact expires on 2026-08-20. Never edit, delete, republish, or reuse the
historical 0.1.0 Release or handoff; 0.1.1 is the technically immutable fix-forward
publication candidate.

The initial 0.1.1 publication used a temporary protected-environment bootstrap token.
After publication, npm trusted publishing was configured for `gnolith/seedbed`,
`release.yml`, environment `release`, and `npm publish`; token publishing was
disabled and the `NPM_BOOTSTRAP_TOKEN` environment secret was deleted. Current and
future releases are OIDC-only.

The workflow publishes npm with provenance, installs the exact registry version in
a clean directory, then binds the downloaded Seedbed, Diamond, Taproot, and Workshop
tarballs to their verified integrity values. It realizes the committed
`docker/package-lock.json` from a fresh cache and proves that the complete production
graph can be reinstalled with npm offline while the registry points to an invalid
local endpoint. Docker receives only the resulting deterministic, SHA-256-addressed
closure. Its extraction step runs with BuildKit networking disabled and verifies the
closure digest before exposing the Seedbed executable; the Dockerfile performs no npm
or registry operation. Image acceptance checks the exact component tuple, closure
label and reconstructed closure digest. The versioned image is pushed with provenance
and SBOM before `latest` is updated.

If a release fails after an immutable artifact is public, fix forward with a new
patch version and new tag. Never move or overwrite a released tag, npm version, or
container digest. A rerun may resume only idempotent verification/push operations;
npm version conflicts must be treated as evidence to verify, not overwritten.

