# Changelog

## Unreleased

- Replace the separate workspace selector and two creation flows with one folder tree and one **New Folder** action. Create top-level or nested folders by name only, with the destination visible above the tree and internal IDs generated automatically.
- Keep existing content, catalog IDs, scoped credentials, direct HTTP/MCP publishing, signed links and Git versions unchanged. Existing groups are top-level folders; unassigned diagrams appear at the root.
- Add a whole-library `/api/tree` read endpoint, retain explicit-ID API creation, and make nested-folder API examples disclose their top-level credential scope.
- Exercise the real browser's folder creation, rename/delete, scoped upload and version restore on desktop/mobile alongside the existing compatibility suite.

## 1.3.0 — 2026-11-23

- Correct the browser login flow: existing valid legacy web sessions migrate directly to management without another credential prompt; fresh read-only links use a separate cookie and cannot be used as login passwords.
- Organize each Entity as a workspace with nested folders, logical file paths and a matching content Git tree; preserve existing signed links and serving bytes during catalog migration.
- Publish HTML directly through Entity-scoped HTTP endpoints, retain exact source companions, and issue revocable workspace API tokens without exposing the service credential.
- Add signed administrator sessions, same-origin management, folder/file moves, and private hash-only token persistence outside content Git.
- Browse, preview and restore real Git file versions from the reader; restoring records a new publication instead of rewriting history.
- Add compact workspace, folder, API credential and version controls to the light reader, retaining sandboxed diagram playback and mobile layouts.

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
