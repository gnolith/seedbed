# Changelog

## Unreleased

- Add an explicit native installation adapter and future host-binding ports, plus
  search-admin-gated consistent snapshot/inspect/verify/restore for the complete
  SQLite installation and local blobs. Snapshots carry per-object integrity and
  package identity but never secret selectors or credential material; restore
  stages and validates everything before making the canonical database visible.
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
  authorization boundary will be released completely as Seedbed 0.2.2.
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
  `v0.2.1` fix-forward can verify signed provenance after `v0.2.0` stopped safely.
- Derive a portable, deterministic image-evidence artifact name that replaces every
  GitHub-forbidden character while retaining the exact container digest inside the
  evidence and immutable Release asset identities.
- Preserve the staged `docs/mcp-runtime-sbom.json` extraction path and add a
  capability-scoped manual recovery mode for the frozen v0.2.2 artifacts. Recovery
  verifies exact tag ancestry, npm SLSA/signatures/install, GHCR runtime/SBOM/signed
  provenance, retained artifact service digests and contents, then creates only the
  missing immutable GitHub Release last.

## 0.2.2 - 2026-07-22

- Published the OIDC-provenanced npm package and exact versioned GHCR image
  `sha256:f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389`.
- Verified the image runtime, SPDX SBOM, signed GitHub provenance, portable evidence
  upload, and `latest` identity.
- Stopped fail-closed before GitHub Release creation because the staging artifact
  retained `docs/mcp-runtime-sbom.json` while Release-last assumed a flattened path.

## 0.2.1 - 2026-07-22

- Published the OIDC-provenanced npm package and exact versioned GHCR image
  `sha256:9ec6b73aa9997e28da5a80f1b39e158532b744c42babf804257b15479a64be5f`.
- Verified the image runtime, SPDX SBOM, and signed GitHub provenance with the scoped
  `GH_TOKEN`, then moved `latest` to that exact verified digest.
- Stopped fail-closed when the image-evidence artifact name included the forbidden
  colon from `sha256:<hex>`. No GitHub Release was created; `0.2.2` is the immutable
  fix-forward.

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
