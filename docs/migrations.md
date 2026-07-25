# Seedbed 0.4 migration and adoption

Seedbed 0.4 is a breaking architecture reset. It does not open or migrate foreign
tables. Its one-shot Compose operator opens the qualified shared database capability
and imports only pinned public package APIs in this immutable order:

1. Diamond public migration plan/apply/inspection exports;
2. Taproot public migration plan/apply/inspection exports;
3. Workshop public migration plan/apply/inspection exports;
4. Workshop `bootstrap-v1` CLI by mounted bearer-file selector;
5. Compose start;
6. owner-local diagnostics;
7. secret-safe receipt.

The committed [migration order](../migration-order.json) is machine-readable.
The operator exits before listener start. Ordinary `gnolith-workshop serve --config`
never migrates, and Seedbed does not require or invent a Taproot CLI.

Plans bind the complete canonical config digest, migration versions, package artifact
hashes, and operation ID. Apply uses an exclusive operation lock and an atomically
written state file. Completed steps resume without replay. Failure records a bounded
quarantine issue; it does not silently migrate, restore, or rebuild.

## Adopting Seedbed 0.3.2 local state

Use `adopt legacy-local plan --manifest ...`, inspect the plan and source digests,
then apply the exact plan. The manifest must be canonical
`gnolith-legacy-local-adoption-v1` and select either:

- a raw database and blob directory from Seedbed 0.3.2; or
- a `gnolith-seedbed-snapshot-v1` archive.

The only accepted tuple is Diamond 0.4.1, Taproot 0.4.2, Workshop 0.4.2, Seedbed
0.3.2. Seedbed verifies and decodes the snapshot-v1 envelope, if present, then passes
a read-only portable database/blob capability to checksum-pinned public
Diamond/Taproot/Workshop legacy-owner adapters in the one-shot operator. Seedbed
treats every returned owner fragment as opaque and never parses the legacy database.
Taproot payloads are streamed through its public Resource-blob port. Seedbed
recursively hashes blob path records, refuses links and path aliases, and refuses
legacy SQLite maintenance, WAL, shared-memory, or rollback-journal sidecars until
the source has been stopped and cleanly checkpointed. It stages payloads and owner
imports offline, compares every canonical
domain count and payload digest, and exposes the new database last.

The original database, blobs, snapshot, config, and receipts are never modified.
Alembic must not activate project configuration until both the adoption receipt and
its independent authenticated Workshop verification pass.
