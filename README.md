# Seedbed

Seedbed assembles Gnolith as one local, headless Node.js process. It uses a durable
SQLite file, exposes tools over MCP stdio or one-shot commands, and never starts an
HTTP server, listening socket, UI, or implicit migration.

## Requirements

- Node.js 24
- public `@gnolith/diamond`, `@gnolith/taproot`, and `@gnolith/workshop` versions

## Start

```sh
npm install --global @gnolith/seedbed@0.1.0
seedbed --base-iri https://example.com/my-gnolith/ --local-owner local-owner init
seedbed --base-iri https://example.com/my-gnolith/ --local-owner local-owner doctor
seedbed --base-iri https://example.com/my-gnolith/ --local-owner local-owner mcp --stdio
```

`init` is only for a new database. `migrate` is the only normal command that may
advance an existing database. `doctor`, `mcp`, `tools`, `call`, and `sparql` inspect
readiness and refuse pending, unknown, newer, partially applied, checksum-divergent,
or assembly-inconsistent state without changing it.

## Commands

```text
seedbed init
seedbed migrate
seedbed doctor
seedbed mcp --stdio
seedbed tools
seedbed call <tool-name> [--arguments '{"key":"value"}']
seedbed sparql 'SELECT * WHERE { ?s ?p ?o } LIMIT 10'
seedbed sparql --file query.rq
```

Structured command results are one-line JSON on stdout. Diagnostics and JSON logs
go only to stderr. Exit codes are `0` success, `2` usage, `3` configuration, `4`
persistence/readiness, `5` authorization, and `6` operation failure.

## Configuration

Precedence is CLI, then `SEEDBED_*` environment variables, then
`seedbed.config.json` in the working directory, then defaults.

| Setting | CLI | Environment | Default |
| --- | --- | --- | --- |
| SQLite path | `--database` | `SEEDBED_DATABASE_PATH` | `./.seedbed/gnolith.sqlite` |
| stable base IRI | `--base-iri` | `SEEDBED_BASE_IRI` | none; required for `init` and runtime |
| owner principal | `--local-owner` | `SEEDBED_LOCAL_OWNER_ID` | none; required |
| log level | `--log-level` | `SEEDBED_LOG_LEVEL` | `info` |
| drain timeout | `--shutdown-timeout-ms` | `SEEDBED_SHUTDOWN_TIMEOUT_MS` | `10000` |

The base IRI must be an absolute HTTP(S) URL and becomes immutable database identity.
The local owner is explicit and receives only the granular `read`, `task-write`,
`knowledge-write`, and `memory-write` capabilities. Administrative authority is
not granted. Missing or invalid identity fails safely.

## Docker

The image runs as the unprivileged `node` user, uses `tini`, declares no exposed
port, defaults to `mcp --stdio`, and stores SQLite at
`/var/lib/seedbed/gnolith.sqlite`.

```sh
docker volume create seedbed-data
docker run --rm -i \
  -v seedbed-data:/var/lib/seedbed \
  -e SEEDBED_BASE_IRI=https://example.com/my-gnolith/ \
  -e SEEDBED_LOCAL_OWNER_ID=local-owner \
  ghcr.io/gnolith/seedbed:0.1.0 init

docker run --rm -i \
  -v seedbed-data:/var/lib/seedbed \
  -e SEEDBED_BASE_IRI=https://example.com/my-gnolith/ \
  -e SEEDBED_LOCAL_OWNER_ID=local-owner \
  ghcr.io/gnolith/seedbed:0.1.0 mcp --stdio
```

See [release documentation](docs/release.md) for trusted-publisher and recovery
details.
