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
one application-data volume, and one Docker-owned read-only protected-credential
volume. Workshop
binds `0.0.0.0:4317` inside its container; Compose publishes only
`127.0.0.1:<configured-port>` by default. The explicit IPv6 override publishes
`[::1]`. The optional `qdrant` profile remains internal. The default `waystone`
profile mounts verified immutable browser assets at `/app` inside Workshop and
starts no second service. `/`, `/mcp`, and health routes remain Workshop-owned.

The build consumes exact tarball paths and lowercase SHA-256 values from the config.
No Seedbed-owned application image is published.

## Credential handoff

For `local-bearer-v1`, apply creates a new protected user-state file outside the
project using exactly 32 OS-CSPRNG bytes encoded as canonical base64url without
padding and without a terminator. Readers accept exactly 43 encoded bytes, or those
same 43 bytes followed by exactly one LF. CRLF, empty values, additional newlines,
surrounding whitespace, and control bytes are rejected. The file is exclusively
created and owner-protected. Seedbed transfers the validated bytes only over a
bounded Docker stdin pipe into an owner-only Docker volume, then passes only the
in-container selector to `gnolith-workshop bootstrap-v1`. It never relaxes the
source file mode or places credential bytes in Compose, CLI arguments, or environment.

Receipts contain credential ID, a non-secret digest, the protected selector, and the
required environment selector `GNOLITH_BEARER_TOKEN`. They never contain the token.
Seedbed does not write Codex project configuration and reports `clientVerified:
false`; Alembic performs the authenticated verification and selector-to-environment
handoff.

## Semantic configuration

Seedbed binds a typed OpenAI-compatible provider and SQLite or Qdrant vector profile
into the digest-bound installation plan. Credential values are read only from the
Docker-owned protected-credential volume by the Workshop assembly adapter; receipts expose
only the configuration fingerprint, revision, and state. Configuration completes
after owner migrations and Workshop bootstrap but before the listener starts.
The provider `endpoint` is always the complete embeddings POST URL (for example,
`http://127.0.0.1:8787/v1/embeddings`), never an API base URL. Seedbed validates
and canonicalizes that URL once at the installation boundary, including the
Docker host-gateway hostname substitution described below, then passes the exact
result unchanged to the owner runtime. Neither Seedbed nor the owner appends a
path segment.
For a Qdrant profile, the generated graph waits for Qdrant health and
idempotently creates or validates the configured collection with the exact
dimensions and metric. After the full graph is stable, Seedbed repeats that
bounded check from the Workshop container's network view and asks Workshop's
public administration surface to reconnect before semantic planning.
When an installation requests semantic `ready`, Seedbed first asks Workshop's
public search administration surface to finish lexical catch-up, estimate one
bounded `asap` semantic plan, and explicitly approve that owner-created plan.
Seedbed records only the configuration ID, owner plan ID, and estimate digest in
a protected installation receipt so interrupted apply/resume reuses the same
approval and never creates a duplicate plan. Workshop—not Seedbed—owns the plan,
cost policy, execution, retries, materialization, and readiness transition.
External provider endpoints are denied by default. A loopback or single-label
Compose-private HTTP endpoint additionally requires explicit private-endpoint
approval and a protected credential selector; unsafe nonlocal/private targets,
redirects, and rebinding are rejected. Host loopback spellings (`127.0.0.1`,
`localhost`, and `::1`) are canonicalized in the plan to
`host.docker.internal`, and the generated Workshop/operator services bind that
exact name to Docker's host gateway. The same mapping applies to an explicitly
configured loopback Qdrant endpoint. This keeps configuration fingerprints stable
while making the endpoint reachable from the container; secrets remain Compose
secret files and are never moved into the URL, plan receipt, or image.

Workshop uses `restart: "no"` in the generated Compose graph. Explicit
Seedbed repair and operator-requested restarts remain supported, but malformed
or unreachable semantic configuration cannot create an automatic container
restart loop. Compose container health uses authenticated `/health/live`;
Seedbed separately verifies authenticated `/health/ready`, which must return
200 for ready or unconfigured semantics and 503 with a bounded diagnostic only
when the immutable installation request explicitly permits degraded semantics.
Workshop reports semantic degradation while lexical search and the
authenticated service remain available.

The Ollama-compatible type is reserved, but local Ollama is deliberately unavailable
in this candidate. Enabling it requires a separately supplied immutable model
artifact selector and digest plus an offline verifier. Seedbed never performs a
floating runtime model pull and does not report Ollama ready without that proof.

## Backup and adoption

Owner backup sections and namespace-sliced Diamond ledger evidence are opaque to
Seedbed. Packed dry-run and real restore first stage and build only the
checksum-pinned one-shot operator. Dry-run validates every exact owner section
in a networkless, read-only container with in-memory owner state and creates no
target volume, project network, credential volume, or application service. Real
restore validates before creating target storage, then passes those same opaque
section values to the owner import APIs.
Restore stages Taproot blob streams first, imports Diamond/Taproot/Workshop in
order, and exposes the canonical database last. Dry-run reports retained,
rebuildable, deferred, expired, and unsupported data.

`legacy-local-v1` accepts only raw Seedbed 0.3.2 state or snapshot-v1 with the exact
Diamond 0.4.1 / Taproot 0.4.2 / Workshop 0.4.2 / Seedbed 0.3.2 tuple. It refuses
locked, changed, lossy, empty-target-from-nonempty-source, or nonempty-target
operations and leaves source state untouched.
Snapshot-v1 envelope verification belongs to Seedbed. Owner conversion belongs to
the checksum-pinned public Diamond, Taproot, and Workshop adapters running against a
read-only portable source capability; Seedbed never parses owner tables or fragment
payloads.

The package includes a frozen endpoint- and credential-free public legacy fixture
under `fixtures/legacy-local-v1`. Its evidence records exact npm tarball integrity,
intentional domain/revision/payload coverage, semantic configuration count zero,
and onboarding count zero with the explicit
`unavailable-in-public-legacy-api` disposition.
The public `adopt legacy-local plan` command stages and builds the checksum-pinned
one-shot owner adapter from the installed package when the target is fresh. It
does not start Workshop, create an application container, or modify the source.

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
Compose bundle, complete CycloneDX composition/dependency SBOM, rendered graph inventory, and lowercase SHA-256
checksums. It never tags, publishes npm, creates a Release, or pushes an image.

## Eventual npm publication

`.github/workflows/registry.yml` is the only npm publication path. A maintainer must
manually dispatch it from `main` with the exact merged commit, the independently
qualified package SHA-256, and the literal package/version confirmation. The job
checks out that exact merged commit, reruns the complete candidate matrix, verifies
the candidate ledger and release boundary, refuses an existing registry version,
and publishes publicly with npm trusted publishing/OIDC provenance. It has no npm
token, tag, GitHub Release, or container-image capability. Running `npm run
candidate` locally remains non-publishing.
The npm package settings must name repository `gnolith/seedbed`, workflow
`registry.yml`, environment `npm`, and allow `npm publish`; the repository is
public so npm can attach provenance.
