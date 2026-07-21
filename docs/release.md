# Release process

Seedbed is published from an immutable GitHub Release whose `vX.Y.Z` tag exactly
matches `package.json`. Configure npm trusted publishing for the `release.yml`
workflow in `gnolith/seedbed`; no `NPM_TOKEN` is used. GitHub's `packages: write`
permission publishes the public GHCR image.

The workflow publishes npm with provenance, installs the exact registry version in
a clean directory, then builds the image from the exact downloaded npm tarball. The
versioned image is pushed with provenance and SBOM before `latest` is updated.

If a release fails after an immutable artifact is public, fix forward with a new
patch version and new tag. Never move or overwrite a released tag, npm version, or
container digest. A rerun may resume only idempotent verification/push operations;
npm version conflicts must be treated as evidence to verify, not overwritten.

