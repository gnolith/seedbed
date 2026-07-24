# Contributing

Open an issue before changing the installation contract. Pull requests must keep
Seedbed installation-only, add adversarial tests, run `npm run check`,
`npm run test:packed`, and `npm run test:compose`, and preserve exact digest-bound
inputs. Never commit credentials, databases, backups, candidate package tarballs, or
generated bearer files.

Application runtime, MCP transport, domain/search/auth/semantic behavior, remote
Workshop connection, and UI work belong in their owning repositories.
