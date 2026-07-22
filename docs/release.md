# Release process

Seedbed publication is started by pushing a protected annotated `vX.Y.Z` tag whose
peeled commit is the checked-out workflow commit, is reachable from `origin/main`,
and whose version exactly matches `package.json`. A lightweight tag, an off-main tag,
or any identity mismatch fails before publication. Configure npm trusted publishing
for the `release.yml` workflow in `gnolith/seedbed` and the protected `release`
environment. GitHub's `packages: write` permission publishes the public GHCR image.

Before pushing the tag, update the version and changelog on `main`, wait for required
checks, and use a maintainer credential to verify that
`GET /repos/gnolith/seedbed/immutable-releases` reports `enabled: true`. Record that
per-release external prerequisite with repository Actions variable
`IMMUTABLE_RELEASES_VERIFIED_FOR=vX.Y.Z`; the tag workflow fails before publication
if it does not exactly match. Then create the tag with
`git tag -a vX.Y.Z -m "Seedbed X.Y.Z"` and push that exact tag. Never move or recreate
a release tag. The workflow rechecks the evidence tag before creating the Release
and accepts the result only when GitHub reports the published Release immutable.

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

The credential-free job also stages the exact dependency tarballs, audits signatures,
builds and tests the packed process runtime, creates the production closure and SBOM,
and builds/tests the candidate non-root, no-port Docker image before npm publication.
Remote npm, GHCR, and GitHub Release probes are bounded and fail closed on authorization,
server, network, timeout, malformed-response, or identity errors; only a true 404 means
absent. A matching npm version or GHCR version tag enters exact-verification recovery
instead of being overwritten. After the digest-addressed image and provenance pass,
`latest` is moved to that verified digest and checked. The GitHub Release is created
last with content-addressed npm tarball, closure, package and image SBOMs, raw image
manifest, signed-provenance verification, and release-evidence assets;
reruns accept it only when its immutable identity and every asset match exactly.
Release asset identity contains only stable source and content identities; transient
Actions run attempts, artifact IDs, and service handoff digests remain workflow audit
data and never change immutable Release evidence. Existing exact signed provenance is
verified and reused rather than duplicated on a rerun.

The transient image-evidence handoff name is derived deterministically from the exact
container digest after replacing every GitHub-forbidden artifact-name character with
`-`. This portability transformation applies only to the Actions artifact name. The
unmodified `sha256:<hex>` identity remains inside the manifest, SBOM, signed-provenance
verification, job outputs, and content-addressed immutable Release evidence.

These gates accept the published package in its supported process and Docker runtimes.
They do not assemble, provision, deploy, or accept a complete Gnolith Site; that work
belongs to the agent constructing a Site.

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

Seedbed 0.2.2 binds Workshop 0.3.3 to annotated `v0.3.3` and exact source commit
`6c6accddc1d84351c16486ba36b65f711e822c8c`. Its authoritative npm tarball has
SHA-256 `c2bc2f3763a3d693662b584d0ed2270936644ab3d23ecd699f0f8b4a2ed0cdc3`
and integrity
`sha512-IXIExUsrVUv74a2ajci6Zml0LUSnumiUwRpfhNhxAiT1ApnIwqpwc3OB1GWi/Ny9GXo3U90e6vlmjMV9cYRSEg==`.
The successful tag-driven release workflow published through OIDC, verified the
sole matching SLSA statement and exact registry bytes, then created the immutable
GitHub Release last. Seedbed consumes only that registry artifact.

Workshop
`v0.3.2` exists as an immutable GitHub source Release, but its release run stopped
before npm publication because the tagged release gate ran before artifact
preparation. No `@gnolith/workshop@0.3.2` package exists, and Seedbed must never
substitute that source tag or a local repack for the 0.3.3 registry artifact.

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

## Production advisory remediation

The historical 0.1.1 production tree contains
`@modelcontextprotocol/sdk@1.29.0 -> @hono/node-server@1.19.14`, affected by moderate
advisory GHSA-frvp-7c67-39w9. Seedbed is an application/CLI distribution whose MCP
surface is stdio-only, so 0.2.2 compiles only the SDK server, protocol, and stdio code
reachable from `src/mcp.ts` into a package-owned artifact. The SDK is an exact build
dependency rather than a published runtime dependency; Gnolith and Node/native
dependencies remain external. Hono HTTP server code is neither reachable nor shipped.

The checked-in MCP runtime SBOM records every included package with exact registry
integrity, source, version, and license, plus SHA-256 for every input and output. Build
verification rejects Hono, StreamableHTTP, and serve-static bytes. Clean packed-consumer
install and invalid-registry offline `npm ci` gates both parse npm's JSON report and
require exactly zero production vulnerabilities; advisory thresholds are not used as
a substitute. This narrow bundle is temporary until the upstream SDK exposes a stable
stdio-only package without the Hono dependency, at which point the removal issue must
be completed rather than retaining a hidden fork.

The repository retains a root-only development override to
`@hono/node-server@2.0.11` while SDK 1.29.0 remains a build/test dependency. The full
development audit and stdio build/tests verify that hardening. The override is absent
from the published runtime and Docker closure manifests and can be removed with the
SDK build dependency when upstream provides the stable stdio-only surface.

## 0.2.2 candidate acceptance

The authorization candidate was exercised on 2026-07-22 against only the exact
public Diamond 0.4.0, Taproot 0.3.0, and Workshop 0.3.3 registry tarballs. Registry
signature verification succeeded for the complete development tree and for the
fresh production closure. The packed-process test initialized and bootstrapped a
new installation, performed Task/Memory operations across process restarts, applied
a revision-bound principal manifest, then proved the disabled principal was denied
in a new process.

The production closure was realized from an empty npm cache, verified against the
committed SHA-512 lock, and reinstalled offline with the registry set to an invalid
local endpoint. The Node 24 image accepted only the exact
`0.4.0 / 0.3.0 / 0.3.3 / 0.2.2` tuple, ran as non-root, exposed no ports, and had no
listening TCP or TCP6 sockets while MCP stdio was active. A replacement container
reopened the same named volume and authorized data; replacement with a different
root secret failed closed. SIGTERM drained in-flight writes and the database reopened
ready. These are candidate gates, not release evidence: the tagged release workflow
must rebuild, content-address, and reverify its own exact closure before publication.

## Partial 0.2.0 publication evidence

The protected `v0.2.0` tag is annotated and peels to main commit
`7caa0a0e8545124f96c81ba8f2a264365e757ca7`. Release workflow run
[`29911759348`](https://github.com/gnolith/seedbed/actions/runs/29911759348)
completed the credential-free package gates and published
`@gnolith/seedbed@0.2.0` through npm OIDC with integrity
`sha512-hFYaaRs+G8zgChgC6XlYCFIhib15jf4I33ZLzPFiCLLretIV86oauY6575BxYMrNv3Vtsyg4G1ZQ/fswEo5iUQ==`
and SLSA v1 provenance. It also published and accepted the exact versioned image
`ghcr.io/gnolith/seedbed@sha256:62c0ff3b16865dd37177e8fffdf55d216fb79bd1038ccb12f57a20349053f411`,
extracted its SPDX SBOM, and created one signed GitHub artifact attestation.

The next verification step stopped because GitHub CLI requires its Actions token in
`GH_TOKEN`; the token was available to the job but was not mapped into that step.
Consequently `latest` remained at its prior digest and no `v0.2.0` GitHub Release was
created. Never move, delete, overwrite, reuse, or manually complete the `v0.2.0`
identities. Version `0.2.1` was the first reviewed fix-forward and maps
`${{ github.token }}` only into the signed-attestation verification step before any
`latest` or Release mutation.

## Partial 0.2.1 publication evidence

The protected annotated `v0.2.1` tag object
`66a39a49c4d8097760654c50c5840d4277f7705b` peels to main commit
`33c1042fcabe614b925505d0bc9c214d52c2e8f6`. Release workflow run
[`29913671424`](https://github.com/gnolith/seedbed/actions/runs/29913671424)
published `@gnolith/seedbed@0.2.1` through npm OIDC with integrity
`sha512-zjUfEObjV1t9ZwViyZdZIWJfp1JQeOh0rYu010Lj0dFylKxk5GaZ46V8mrE9hlHq3TgCqhBTDisNgQwMpsURyA==`
and SLSA v1 provenance. It published and functionally accepted the exact image
`ghcr.io/gnolith/seedbed@sha256:9ec6b73aa9997e28da5a80f1b39e158532b744c42babf804257b15479a64be5f`,
extracted its SPDX SBOM, created and verified signed GitHub provenance with the exact
tag ref and commit, and moved `latest` to that verified digest.

The subsequent Actions handoff failed closed because its artifact name embedded the
literal digest and GitHub forbids `:` in artifact names. The immutable GitHub Release
job was skipped. Never move, delete, overwrite, reuse, rerun, or manually complete the
`v0.2.1` identities. Version `0.2.2` is the reviewed fix-forward; it changes only the
transient artifact-name representation while keeping every content identity exact.

## Frozen 0.2.2 Release recovery

The protected annotated `v0.2.2` tag object
`af24354dffe56a09ddcf302633d50d5ad53ed2eb` peels to main commit
`74737bec42368df4f006adcac5fe215edc732094`. Release workflow run
[`29915140208`](https://github.com/gnolith/seedbed/actions/runs/29915140208)
published `@gnolith/seedbed@0.2.2` through npm OIDC with integrity
`sha512-nyMdjkJJjSLXlppljaR4J37R8vQZtXO8KxohJYhwAjenniEA3Ix9q0mssrTGM4jnBSZVQTIAHEkMa37DJp/Cvg==`.
It published and accepted the exact image
`sha256:f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389`,
verified its runtime, SPDX SBOM, and signed GitHub provenance, uploaded the portable
image evidence, and moved `latest` to the same exact digest.

Release-last then failed before calling `gh release create`: Actions extraction
preserved the staging entry as `docs/mcp-runtime-sbom.json`, while the script assumed
the flattened path `mcp-runtime-sbom.json`. The retained artifact inventory proves
that this is the single path-contract defect; the other archive paths and hashes match.

The manual `workflow_dispatch` recovery accepts only explicit tag `v0.2.2` from the
current reviewed `main` workflow. It first checks out only current-main recovery
tooling without persisted credentials, proves the hard-coded remote tag object, peeled
commit, original release-workflow blob, and `origin/main` tooling identity, and only
then checks out the tag separately without credentials or runs the reviewed setup
action. It cannot publish npm or GHCR or mutate a tag. Before creating the
missing Release last, it proves the immutable setting, tag object/peel/main ancestry,
exact npm integrity/signatures/SLSA/install, exact versioned and `latest` image digest,
non-root/no-port runtime labels, image SBOM, signed attestation, retained run/artifact
IDs and service digests, every archive path/size/hash, and all seven deterministic
content-addressed Release assets. Missing, mutable, expired, mismatched, draft, or
unexpected evidence fails closed. Creation is allowed only while the prior latest
Release remains `v0.1.1`; an already-present Release is accepted only when it is the
latest immutable `v0.2.2` identity and every asset verifies byte-for-byte.

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
label and retained archive digest, and a complete portable manifest of extracted
files, directories, modes, hashes, and in-root symlink targets. Archive paths are
validated as safe and relative before extraction; the manifest also rejects extras.
The
versioned image is pushed with provenance and SBOM before `latest` is updated.

If a release fails after an immutable artifact is public, fix forward with a new
patch version and new tag. Never move or overwrite a released tag, npm version, or
container digest. A rerun may resume only idempotent verification/push operations;
npm version conflicts must be treated as evidence to verify, not overwritten.

