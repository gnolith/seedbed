# Assembly migrations

Seedbed records one exact package set in `seedbed_assembly`. The marker is an
assembly compatibility claim, not a substitute for the package-owned migration
ledgers.

`seedbed migrate` accepts only the exact current package set or an exact
predecessor listed by the release's component migration plan. It never infers a
safe transition from semver. A future release that changes Diamond, Taproot,
Workshop, or Seedbed must add the complete released predecessor tuple to
`allowedPredecessors`; partial, unknown, drifted, and future tuples fail before
component mutation.

The coordinator advances components in this fixed order:

1. Seedbed performs a read-only whole-assembly preflight. Every component must
   be exactly the declared predecessor or, for interrupted recovery, the exact
   target. A corrupt or third state prevents all component writes.
2. Diamond applies its own migrations; Seedbed verifies its exact ordered
   migration IDs and checksums.
3. Taproot applies its own migrations and verifies its persistence schema and
   immutable base IRI.
4. Workshop applies its own migrations; Seedbed verifies its exact ordered
   migration IDs and checksums.
5. Seedbed conditionally updates the assembly marker from the previously read
   tuple and marker timestamp to the exact target tuple. A stale or ABA-changed
   marker cannot be overwritten.

Each owning package remains responsible for making its migration operation
atomic and idempotent. Seedbed deliberately leaves the predecessor marker in
place until every target component verifies current. A process interruption can
therefore leave target component migrations with the predecessor marker; the
next explicit `migrate` reruns the idempotent component operations and completes
the conditional marker update. Runtime commands and `doctor` never perform this
recovery or mutate persistence.

Before shipping a new assembly tuple, its blocking tests must simulate the
released predecessor without relying on unreleased packages and cover:

- deterministic interruption after every component boundary followed by
  successful repeated recovery;
- exact target-schema verification before marker advancement;
- rejection of checksum drift, extra/future migrations, unknown tuples, wrong
  component versions, and base-IRI changes;
- two concurrent migration attempts, with a stale attempt unable to overwrite
  the winning marker; and
- readiness of an existing `0.1.1` database after the transition.
