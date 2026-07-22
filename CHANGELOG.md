# Changelog

## Unreleased

- Add installation-bound authorization state with durable principals, workspaces,
  memberships, exact grants, immutable audit records, and Taproot-owned revisions.
- Require an exact 32-byte root secret from a protected file or inherited descriptor;
  derive non-extractable installation, host-write, and cursor keys with HKDF.
- Replace the fixed local owner and raw SPARQL surface with explicit one-time bootstrap,
  authorization administration, bounded backfills, and guarded Task/Memory operations.
- Add revision-bound, file-driven principal updates that atomically replace enabled
  state, workspace memberships, and exact grants, including complete revocation,
  while preventing removal of the last durable grant administrator.
- Add native headless, packed-package, Docker replacement-volume, stale-context,
  rollback, and concurrent-bootstrap acceptance coverage.
- Upgrade the assembly to Taproot 0.3.0 and Workshop 0.3.3. This breaking pre-1.0
  authorization boundary will be released completely as Seedbed 0.2.1.
- Compile the exact MCP SDK 1.29.0 stdio server surface into an audited, tree-shaken
  runtime artifact, externalizing Gnolith/native dependencies and excluding Hono HTTP
  code; ship an exact integrity/license/input SBOM and parsed zero-vulnerability
  production and reproducible packed-consumer audit gates.
- Upgrade Vitest and its V8 coverage provider to 3.2.6 to remediate
  GHSA-5xrq-8626-4rwp in development tooling.
- Replace the temporary npm bootstrap token path with OIDC-only trusted publishing.
- Retry root-packument propagation and a clean exact-version install before accepting
  post-publish registry evidence.
- Drive releases from protected annotated `v*` tags, fail closed on remote artifact
  conflicts, verify recoverable npm and GHCR publication by exact identity, and create
  the content-addressed immutable GitHub Release only after all package/runtime gates.
- Map the built-in GitHub token only into signed image-attestation verification so the
  `v0.2.1` fix-forward can complete after `v0.2.0` stopped safely before `latest` and
  GitHub Release creation.

## 0.2.0 - 2026-07-22

- Published the OIDC-provenanced npm package and exact versioned GHCR image, including
  its SBOM and signed GitHub provenance.
- Stopped fail-closed when `gh attestation verify` lacked its required `GH_TOKEN`
  mapping. The workflow did not move `latest` or create a GitHub Release; `0.2.1` is
  the immutable fix-forward.

## 0.1.1 - 2026-07-21

- Publish the first npm and container artifacts for the headless Seedbed runtime.
- Fix the release verifier's inline heredoc so the exact YAML-decoded shell script
  parses and executes on the protected publish runner.
- Add syntax and safe recovery execution tests for the exact decoded publish script.

## 0.1.0 - 2026-07-21

- Created the initial public source tag and GitHub Release.
- Publication stopped before npm or GHCR mutation because the protected publish
  runner rejected a malformed inline verifier script. No npm package or container
  image exists for this version; `0.1.1` is the immutable fix-forward release.
