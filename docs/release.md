# Release process

Seedbed is published from an immutable GitHub Release whose `vX.Y.Z` tag exactly
matches `package.json`. Configure npm trusted publishing for the `release.yml`
workflow in `gnolith/seedbed` and the protected `release` environment. GitHub's
`packages: write` permission publishes the public GHCR image.

For the first publication only, create a short-lived granular npm token with
write access to the `@gnolith` scope and bypass-2FA enabled. Store it as the
`NPM_BOOTSTRAP_TOKEN` secret in the GitHub `release` environment. The workflow
packs and verifies the exact publication tarball in a tokenless job, names it by its
SHA-256 digest, and uploads it for 30 days with expected digest, package-name, and
version metadata. The repository's selected-actions policy permits SHA-pinned
GitHub-owned upload/download artifact actions; the immutable artifact ID and service
digest independently bind the handoff. A fresh protected-environment runner with no
checkout downloads that exact artifact and installs Node from a pinned, SHA-verified
archive rather than a setup action. Its only repository permission is OIDC token
issuance. The terminal secret-bearing step derives the expected version directly
from the validated release tag, rejects links, non-regular or ambiguous paths,
outside-package entries, and duplicate manifests, then recomputes and checks all
metadata. It publishes only the absolute verified-tarball path with lifecycle
scripts disabled, so no repository-controlled content or process shares the runner.

The terminal step is idempotent: if that exact name, version, and SHA-512 integrity
already exist on npm, it also requires the exact SLSA v1 attestation endpoint and a
successful `npm audit signatures` verification before recording recovery success.
Missing or invalid provenance fails closed. After a new publish it waits for and
verifies the same integrity and provenance evidence before the image job can run.
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

Seedbed 0.1.0 binds Workshop 0.2.3's source identity to the peeled `v0.2.3` tag
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

The 0.1.0 production tree contains
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

After `@gnolith/seedbed` exists, configure its npm trusted publisher for
`gnolith/seedbed`, `release.yml`, environment `release`, and `npm publish`; then
remove the bootstrap-token wiring in a cleanup PR and delete and revoke the
environment secret and token.

The workflow publishes npm with provenance, installs the exact registry version in
a clean directory, then builds the image from the exact downloaded npm tarball. The
versioned image is pushed with provenance and SBOM before `latest` is updated.

If a release fails after an immutable artifact is public, fix forward with a new
patch version and new tag. Never move or overwrite a released tag, npm version, or
container digest. A rerun may resume only idempotent verification/push operations;
npm version conflicts must be treated as evidence to verify, not overwritten.

