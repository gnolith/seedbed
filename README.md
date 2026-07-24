# Seedbed

Seedbed 0.4 is the deterministic Compose-first installer and offline operator control
plane for a local Gnolith installation. It is not the Gnolith application or a
server. Workshop is the sole HTTP `/mcp` service.

Seedbed owns:

- strict installation configuration and exact artifact/source digests;
- local Compose generation and hardened local-build plumbing;
- Diamond → Taproot → Workshop migration ordering;
- protected `local-bearer-v1` credential creation and Workshop `bootstrap-v1`
  invocation before listener start;
- bounded Docker-local diagnostics;
- opaque owner backup/restore and exact legacy 0.3.2 offline adoption;
- secret-safe plans and receipts for Alembic verification.

Seedbed contains no MCP transport, application runtime, domain CRUD, authorization
implementation, search/semantic dispatcher, live snapshot endpoint, HTTP listener,
published application image, or GHCR publication workflow.

Installable control planes use the fixed-command local adapter rather than
constructing child-process commands:

```ts
import { createSeedbedControl } from '@gnolith/seedbed/local-control';

const local = createSeedbedControl(immutableSeedbedPolicy);
const plan = await local.plan(dockerInstallationRequest);
const receipt = await local.apply(plan);
await local.resume(plan.id);
const inspection = await local.inspect({ installationId, projectRoot });
const doctor = await local.diagnose({ installationId, projectRoot });
```

The installable default uses `createDefaultSeedbedControl({ projectRoot })`.
Seedbed resolves its own installed package root and safe per-user external state
root, then returns the canonical opaque state selector in its plan. An explicitly
approved absolute external `stateRoot` may override the default; project-local,
worktree-local, symlink, junction, and path-alias selectors fail closed. Seedbed
alone reads and validates the fixed `seedbed-component-lock.json`; tests and
candidate staging may explicitly override `artifactRoot`.

`defaultSeedbedControlPolicy()` exposes `localBuild`, the exact
`seedbed-local-build-v1` image selection copied into every control plan. It has
the fixed selector `gnolith-seedbed-local-build-v1`, `pullPolicy: "never"`, and
SHA-256 attestations for the component lock, rendered graph, and deterministic
Compose bundle. Callers must pass that object unchanged as
`DockerInstallationRequest.image`. This selection trusts the pinned local
assembly and is never interpreted as an OCI image name. The separately typed
`digest-qualified-pulled-image-v1` selection requires an
`@sha256:<digest>` reference, but application-image pulls remain unsupported by
the architecture-reset control plane.

## Commands

```text
seedbed init --config <path> --from <canonical-config-template>
seedbed plan --config <path> [--out <path>]
seedbed apply --config <path> --plan <path>
seedbed migrate plan --config <path> [--out <path>]
seedbed migrate apply --config <path> --plan <path>
seedbed doctor --config <path>
seedbed backup create --config <path> --out <path>
seedbed backup inspect --config <path> --archive <path>
seedbed backup verify --config <path> --archive <path>
seedbed backup restore --config <path> --archive <path> [--dry-run]
seedbed adopt legacy-local plan --config <path> --manifest <path> [--out <path>]
seedbed adopt legacy-local apply --config <path> --manifest <path> --plan <path>
seedbed uninstall --config <path> --retain-data
```

There is no native or stdio product mode. Remote Workshop installation and Codex
configuration are Alembic responsibilities.

## Local topology

The default graph is one locally built Workshop service, an internal Compose network,
one application-data volume, and one read-only protected bearer secret. Workshop
binds `0.0.0.0:4317` inside its container; Compose publishes only
`127.0.0.1:<configured-port>` by default. The explicit IPv6 override publishes
`[::1]`. Optional `qdrant` and `ollama` profiles remain internal. The `waystone`
profile mounts verified immutable browser assets into Workshop and starts no second
service.

The build consumes exact tarball paths and lowercase SHA-256 values from the config.
No Seedbed-owned application image is published.

## Credential handoff

For `local-bearer-v1`, apply creates a new protected user-state file outside the
project using exactly 32 OS-CSPRNG bytes encoded as canonical base64url without
padding plus LF. The file is exclusively created and owner-protected. Seedbed passes
only its selector to `gnolith-workshop bootstrap-v1`.

Receipts contain credential ID, a non-secret digest, the protected selector, and the
required environment selector `GNOLITH_BEARER_TOKEN`. They never contain the token.
Seedbed does not write Codex project configuration and reports `clientVerified:
false`; Alembic performs the authenticated verification and selector-to-environment
handoff.

## Backup and adoption

Owner backup sections and namespace-sliced Diamond ledger evidence are opaque to
Seedbed. Restore validates owner ports, stages Taproot blob streams first, imports
Diamond/Taproot/Workshop in order, and exposes the canonical database last. Dry-run
reports retained, rebuildable, deferred, expired, and unsupported data.

`legacy-local-v1` accepts only raw Seedbed 0.3.2 state or snapshot-v1 with the exact
Diamond 0.4.1 / Taproot 0.4.2 / Workshop 0.4.2 / Seedbed 0.3.2 tuple. It refuses
locked, changed, lossy, empty-target-from-nonempty-source, or nonempty-target
operations and leaves source state untouched.
Snapshot-v1 envelope verification belongs to Seedbed. Owner conversion belongs to
the checksum-pinned public Diamond, Taproot, and Workshop adapters running against a
read-only portable source capability; Seedbed never parses owner tables or fragment
payloads.

See [architecture reset](docs/architecture-reset.md),
[migration guide](docs/migrations.md), and the
[example config](examples/seedbed.config.example.json).

## Candidate verification

```sh
npm ci --ignore-scripts
npm run check
npm run test:packed
npm run test:compose
npm run test:docker
```

After committing a clean candidate, `npm run candidate` regenerates the exact package,
Compose bundle, CycloneDX SBOM, rendered graph inventory, and lowercase SHA-256
checksums. It never tags, publishes npm, creates a Release, or pushes an image.
