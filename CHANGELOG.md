# Changelog

## 1.0.0 — 2026-11-22

- Extracted the Web UI, entity library, HTTP API and remote MCP bridge into an independent repository, separate from the renderer fork.
- Installed the unmodified official `nicobailon/visual-explainer` archive as an immutable npm dependency with an integrity-checked lockfile.
- Retained the existing light reader, generated diagrams, entity catalog, viewer access, signed URLs and native playback behavior.
- Added scheduled upstream update PRs gated on real container/MCP/API compatibility checks and persistence verification; no automatic merge or production deployment.
