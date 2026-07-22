# Seedbed

Seedbed assembles Gnolith as one local, headless Node.js process. It uses a durable
SQLite file, exposes tools over MCP stdio or one-shot commands, and never starts an
HTTP server, listening socket, UI, or implicit migration.

## Requirements

- Node.js 24
- public exact `@gnolith/diamond`, `@gnolith/taproot`, and `@gnolith/workshop` versions
- a restart-stable file or inherited descriptor containing exactly 32 random bytes

## Start

Create the root-secret file with an operating-system secret manager or a CSPRNG,
and restrict it to the Seedbed process account. Never place the bytes in a command,
environment variable, JSON configuration, log, or MCP argument.

```sh
seedbed --base-iri https://example.com/my-gnolith/ --root-secret-file /run/secrets/seedbed-root init
seedbed --base-iri https://example.com/my-gnolith/ --root-secret-file /run/secrets/seedbed-root \
  --principal owner --workspace primary auth bootstrap
seedbed --base-iri https://example.com/my-gnolith/ --root-secret-file /run/secrets/seedbed-root \
  --principal owner --workspace primary auth status
seedbed --base-iri https://example.com/my-gnolith/ --root-secret-file /run/secrets/seedbed-root \
  --principal owner --workspace primary mcp --stdio
```

`init` only creates a new package assembly. `migrate` is the only normal command
that advances package schemas. Authorization remains quarantined until the explicit,
one-time `auth bootstrap` atomically creates the first durable grants and advances
Taproot's sole authorization/search generation. An identical bootstrap retry is
idempotent; a different second bootstrap is rejected.

## Commands

```text
seedbed init
seedbed migrate
seedbed doctor
seedbed auth bootstrap
seedbed auth status
seedbed auth apply --manifest ./principal-authorization.json
seedbed auth backfill taproot --manifest <path>
seedbed auth backfill workshop --domain <task|memory>
seedbed snapshot create --output ./installation.seedbed-snapshot.gz
seedbed snapshot inspect --input ./installation.seedbed-snapshot.gz
seedbed snapshot verify --input ./installation.seedbed-snapshot.gz
seedbed snapshot restore --input ./installation.seedbed-snapshot.gz
seedbed mcp --stdio
seedbed tools
seedbed call <tool-name> [--arguments '{"key":"value"}']
```

Principal authorization changes are strict host-only manifests and never MCP tools.
They replace the principal's enabled flag, complete workspace set, and complete
capability set in one Taproot authorization advance. Bind every change to the
revision reported by `auth status`:

```json
{
  "version": 1,
  "expectedAuthorizationRevision": 2,
  "principal": "agent",
  "enabled": true,
  "workspaces": ["primary"],
  "capabilities": ["read", "task-write"]
}
```

To revoke a principal, set `enabled` to `false` and both arrays to empty. Stale
manifests fail without writes. Seedbed also rejects any update that would remove
the final enabled principal holding exact `admin`, `knowledge:write`, and
`knowledge:policy`, preventing an unrecoverable authorization lockout.

There is no raw SPARQL command. Legacy authorization rows remain invisible until
an explicit, bounded host-only backfill. Maintenance requires exact `search:admin`;
principal changes additionally require exact `admin`, Taproot `knowledge:write`, and
Taproot `knowledge:policy`. These Taproot capabilities are required by its guarded
installation advance and are distinct from Workshop's `knowledge-write`; generic
`admin` implies none of them.

Taproot's `search` and `search_hydrate` tools provide the single relevance-search
surface. Seedbed owns Resource and Annotation CRUD/hydration tools and runs the
bounded Taproot materializer after successful mutations and during graceful drain.
Materialization and semantic maintenance tools require exact `search:admin`.
Task, Memory, and Prompt results are enabled only when their exact Workshop-owned
producer adapters are present; Seedbed does not duplicate those domain owners.

Structured results are one-line JSON on stdout. Diagnostics and JSON logs go only
to stderr. Exit codes are `0` success, `2` usage, `3` configuration, `4`
persistence/readiness, `5` authorization, and `6` operation failure.

## Configuration

Precedence is CLI, then `SEEDBED_*` environment variables, then
`seedbed.config.json`, then defaults.

| Setting | CLI | Environment | Default |
| --- | --- | --- | --- |
| SQLite path | `--database` | `SEEDBED_DATABASE_PATH` | `./.seedbed/gnolith.sqlite` |
| local blob path | `--blobs` | `SEEDBED_BLOB_PATH` | `./.seedbed/blobs` |
| SQLite busy timeout | `--busy-timeout-ms` | `SEEDBED_BUSY_TIMEOUT_MS` | `5000` |
| stable base IRI | `--base-iri` | `SEEDBED_BASE_IRI` | none |
| root-secret file selector | `--root-secret-file` | `SEEDBED_ROOT_SECRET_FILE` | none |
| inherited secret descriptor | `--root-secret-fd` | `SEEDBED_ROOT_SECRET_FD` | none |
| principal selector | `--principal` | `SEEDBED_PRINCIPAL_SELECTOR` | none |
| workspace selector | `--workspace` | `SEEDBED_WORKSPACE_SELECTOR` | none |
| log level | `--log-level` | `SEEDBED_LOG_LEVEL` | `info` |

Exactly one root-secret selector is required for authorization. Seedbed derives
non-extractable, installation-bound and domain-separated keys with HKDF-SHA-256.
Changing the secret, installation, or base IRI fails closed across restarts.

Optional `semanticConfigurations` are declared only in the JSON configuration.
Each chooses an OpenAI- or Ollama-compatible embedding endpoint and either SQLite
or Qdrant vectors. Provider and Qdrant credentials use `{ "file": "..." }` or
`{ "fd": 3 }` selectors; literal credential values, environment credential bytes,
CLI credential flags, and MCP credential arguments are intentionally unsupported.
Private endpoints require the explicit `allowPrivateEndpoint` opt-in. See
[`seedbed.config.example.json`](seedbed.config.example.json) for the complete shape.

## Snapshot and restore

Snapshot maintenance requires an authorized principal with exact `search:admin`.
`snapshot create` uses SQLite's consistent `VACUUM INTO` boundary, includes every
local blob with byte length and SHA-256 metadata, and writes a compressed portable
envelope with an exclusive create. Root secrets, credential bytes, access tokens,
and secret selectors are never included. Keep those separately in an OS secret
facility.

`snapshot verify` checks the database and every blob before any restore write.
`snapshot restore` accepts only an empty target installation, validates the exact
package schema, stable base IRI, root-secret binding, installation identity, and
administrator authorization in staging, installs blobs first, and exposes the
canonical database last. A failed or interrupted restore removes staging state
without replacing a valid installation.

## Docker

The image runs as the unprivileged `node` user, uses `tini`, exposes no port,
defaults to MCP stdio, and stores SQLite at `/var/lib/seedbed/gnolith.sqlite`.
Mount the root secret read-only; do not pass its bytes as an environment value. On
Linux it must be owned so the image's non-root `node` user can read it while group
and other permission bits remain clear (for example, owner-readable mode `0400`).

```sh
docker volume create seedbed-data
docker run --rm -i \
  -v seedbed-data:/var/lib/seedbed \
  -v /host/secret/seedbed-root:/run/secrets/seedbed-root:ro \
  -e SEEDBED_BASE_IRI=https://example.com/my-gnolith/ \
  -e SEEDBED_ROOT_SECRET_FILE=/run/secrets/seedbed-root \
  ghcr.io/gnolith/seedbed:0.3.1 init
```

See [`docs/migrations.md`](docs/migrations.md) for exact transition and recovery
rules and [`docs/release.md`](docs/release.md) for trusted publishing.
