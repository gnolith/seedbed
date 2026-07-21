# Release process

Seedbed is published from an immutable GitHub Release whose `vX.Y.Z` tag exactly
matches `package.json`. Configure npm trusted publishing for the `release.yml`
workflow in `gnolith/seedbed` and the protected `release` environment. GitHub's
`packages: write` permission publishes the public GHCR image.

For the first publication only, create a short-lived granular npm token with
write access to the `@gnolith` scope and bypass-2FA enabled. Store it as the
`NPM_BOOTSTRAP_TOKEN` secret in the GitHub `release` environment. The workflow
exposes it only to the npm publish step through a runner-temporary npmrc while
retaining OIDC provenance. After `@gnolith/seedbed` exists, configure its npm
trusted publisher for `gnolith/seedbed`, `release.yml`, environment `release`,
and `npm publish`; then remove the bootstrap-token wiring in a cleanup PR and
delete and revoke the environment secret and token.

The workflow publishes npm with provenance, installs the exact registry version in
a clean directory, then builds the image from the exact downloaded npm tarball. The
versioned image is pushed with provenance and SBOM before `latest` is updated.

If a release fails after an immutable artifact is public, fix forward with a new
patch version and new tag. Never move or overwrite a released tag, npm version, or
container digest. A rerun may resume only idempotent verification/push operations;
npm version conflicts must be treated as evidence to verify, not overwritten.

