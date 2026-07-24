# Changelog

## 0.4.0 — architecture-reset candidate

- Breaking: reduce Seedbed to Compose-first installation, configuration, migration
  ordering, Workshop bootstrap, offline backup/adoption orchestration, diagnostics,
  and retain-data uninstall.
- Remove MCP/stdio transport, runtime/domain/auth/search/semantic/snapshot
  implementations, native product mode, one-shot tools/call commands, server
  lifecycle, and application-image/GHCR ownership.
- Add exact artifact/source coordinates, hardened loopback-only Compose, protected
  32-byte local bearer generation, digest-bound resumable operations, secret-safe
  receipts, opaque owner backup/restore, and exact 0.3.2 legacy adoption.
- Add candidate-only packed, Compose, inventory, audit, static-analysis, and
  secret-canary gates. No tag or publication is part of this candidate.
