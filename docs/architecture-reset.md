# Architecture-reset boundaries

## Owned

Seedbed owns deterministic plans/receipts, strict redacted config, local Compose
plumbing, protected credential selectors, migration/bootstrap ordering, bounded
Docker-local doctor output, offline backup envelopes, and legacy-local adoption.

## Delegated through public ports

- Diamond owns its migration, backup section, and exact 0.4.1 legacy-owner decoder.
- Taproot owns its migration/adoption/backup section and Resource-blob streaming
  enumerate/open/stage/collision/rebind/commit/rollback port, including exact 0.4.2
  legacy inspection.
- Workshop owns its migration/backup section, `bootstrap-v1`, sole HTTP service,
  installation diagnostics, catalog digest, readiness, and exact 0.4.2 legacy-owner
  adapter.
- Waystone is optional immutable static/browser content mounted into Workshop and
  has no service or migration authority. Seedbed byte-verifies its immutable JSON
  asset manifest, stages it outside the worktree, and mounts that manifest beside
  the read-only `waystone-assets` volume.
- Alembic owns remote Workshop setup, protected selector verification, Codex
  environment injection, project MCP configuration, and authenticated client checks.

Seedbed imports no private owner path and reads no owner table or Diamond ledger
table. Every owner section carries owner-produced namespace-sliced ledger evidence.
For legacy adoption Seedbed alone decodes and verifies snapshot-v1 envelopes, then
mounts the portable database and blobs read-only into the one-shot operator. That
operator injects the exact checksum-pinned public owner adapters. Seedbed treats
their fragments as opaque and streams legacy Taproot payloads through its public
blob port.

## Restore transaction

```text
inspect envelope → validate hashes/bounds/versions → owner validation
→ empty-target check → stage blobs → collision check → canonical rebind
→ Diamond import → Taproot import → Workshop import → blob commit
→ owner-local verification → expose canonical database last
```

Any failure rolls back blob staging and cleans the staging directory. No live
Workshop service starts during restore or adoption.
