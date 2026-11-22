# Changelog

## 1.2.0 — 2026-11-22

- Mirror library Entities as stable-ID folders in content Git, with an `_unassigned` directory and markers for empty groups.
- Move rendered pages and companion sources together when assignments change, without changing serving files, URLs or modification times.
- Migrate flat history in place to a bare object store, preserving existing commits and legacy staged-index bytes.
- Verify real legacy migration, source-extension pairing, automatic moves, empty groups, clean clones and restart persistence.

## 1.1.0 — 2026-11-22

- Added automatic Git snapshots for existing HTML/source pages and Entity metadata, independent of the wrapper source repository.
- Version API/MCP publications and grouping mutations atomically per operation; skip empty commits and exclude credentials, screenshots and symlinks.
- Added optional synchronous private-repository pushes with dedicated deploy-key SSH, explicit failure reporting and preservation of pending local commits.
- Added real Git import, revision, staged-file isolation, push-failure recovery and restart regression checks.

## 1.0.0 — 2026-11-22

- Extracted the Web UI, entity library, HTTP API and remote MCP bridge into an independent repository, separate from the renderer fork.
- Installed the unmodified official `nicobailon/visual-explainer` archive as an immutable npm dependency with an integrity-checked lockfile.
- Retained the existing light reader, generated diagrams, entity catalog, viewer access, signed URLs and native playback behavior.
- Added scheduled upstream update PRs gated on real container/MCP/API compatibility checks and persistence verification; no automatic merge or production deployment.
