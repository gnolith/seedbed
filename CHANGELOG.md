# Changelog

## Unreleased

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
