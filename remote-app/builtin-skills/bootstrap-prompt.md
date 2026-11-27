{{SCOPE_INTRO}}

{{ENDPOINT_LIST}}
- Official skill & docs bundle: {{ORIGINAL_BASE}}/bundle
- Page & child-page templates catalog: {{ORIGINAL_BASE}}/templates (default: {{ORIGINAL_BASE}}/templates/default.md)
- Zero-idle-token comment watcher script: {{ORIGINAL_BASE}}/watch.sh

## 1. Read the official skill before writing HTML

Do not upload arbitrary HTML. First fetch the official bootstrap bundle (index, `SKILL.md`, `references/style-guide.md`, `references/kit.md`, and `references/diagrams.md`) in one command:

```bash
VE_KEY={{VE_KEY_QUOTED}}

curl --fail-with-body {{BUNDLE_URL_QUOTED}} -H "Authorization: Bearer $VE_KEY"
```

Individual docs (`{{ORIGINAL_BASE}}/SKILL.md`, `{{ORIGINAL_BASE}}/references/style-guide.md`, `{{ORIGINAL_BASE}}/references/<name>.md`) also remain available separately, and `?refs=...` can include extra references like `motion` in one call.
**Page & child-page templates:** The `/bundle` index JSON (and `GET {{ORIGINAL_BASE}}/templates`) lists available multi-page templates (`id`, `default`, `whenToUse`, `url`). Before structuring a diagram, proposal, or multi-page Wiki, fetch the matching template (default: `GET {{ORIGINAL_BASE}}/templates/default.md`, or another template from the catalog if the user asks for it or `whenToUse` fits better) with `Authorization: Bearer $VE_KEY`. Follow the template for parent/child page organization and component diffs, and upstream `SKILL.md` / `references/*` for single-page visual rendering & checksheet QA.
Optional official helpers (`POST` JSON with `Authorization: Bearer $VE_KEY` and `Content-Type: application/json`):
- Prepare: `POST {{ORIGINAL_BASE}}/prepare` (matches `visual_explainer_prepare.inputSchema`, e.g. `{"topic":"..."}`)
- Prompt: `POST {{ORIGINAL_BASE}}/prompts/<name>` (e.g. `generate-web-diagram` with `{"request":"..."}`)

## 2. Write, publish, and verify

Verify project facts locally, write `./diagram.src.html` (never send local filesystem paths), then publish it (`Content-Type: text/html; charset=utf-8`, max 12 MiB, `.html`/`.htm`, not `.src.html`; optional `?note=...` or `-H 'X-VE-Note: ...'` for a version note):

```bash
curl --fail-with-body -X PUT \
  {{TARGET_URL_QUOTED}} \
  -H "Authorization: Bearer $VE_KEY" \
  -H 'Content-Type: text/html; charset=utf-8' \
  --data-binary @./diagram.src.html \
  --output ./diagram.render.json
```

Inspect `./diagram.render.json`:
- Check `render.structuredContent.report` and every diagnostic in `render.content`; decode any `type: "image"` base64 blocks to inspect the official checksheet screenshots.
- Fix every `✗` diagnostic with small targeted edits to `./diagram.src.html` and re-PUT the same path until clean.
- Include `<meta name="description" content="...">` for a concise 1-line hover preview summary (Light and Dark thumbnails are captured automatically on publish).
- Wiki drill-down & templates: follow the selected template (default `{{ORIGINAL_BASE}}/templates/default.md`) for L0 overview vs L1 component child pages and change diffs; publish child diagrams under `{{CHILD_PATH_EXAMPLE}}` (same scoped folder key) and add `data-ve-child="<child>"` (omit `.html`) on any SVG node (`<g class="ve-n" data-ve-child="...">`) or inline `<span>`. The WebUI viewer injects portal styling, stacked badges, hover previews, and click navigation at view time — plain appearance in standalone checksheets is expected, so do NOT add custom fake-portal CSS.
- **Before replying with `page.url`**, start the non-blocking background comment watcher in §3 by default (if your harness supports background/async execution), then share `page.url` from the response (also returns `page.filename`, `version`, `commentsUrl`, and `openComments`).

## 3. Live comment listener (default, zero idle tokens)

By default, after publishing and passing visual checks, start **ONE non-blocking background watcher** (using your harness background task / async command runner — never block your reply) **before** replying with `page.url`, so the WebUI immediately shows an active listener and any new comment, reply, reopen, or **Send** wakes you automatically without burning idle LLM tokens:
- Fetch the zero-dependency POSIX watcher once: `curl -fsSL -H "Authorization: Bearer $VE_KEY" '{{ORIGINAL_BASE}}/watch.sh' -o ./ve-watch.sh && chmod +x ./ve-watch.sh`
- Start ONE background watcher covering the whole scope: `VE_KEY="$VE_KEY" ./ve-watch.sh --url '{{EVENTS_BASE_URL}}'` (omit `--path` for Folder API so ONE connection covers the whole folder & all child pages{{WATCH_SCOPE_NOTE}}; **NEVER** run bare `once=1` curl loops or open parallel per-page watchers!). If your harness has no non-blocking background task capability, skip this step rather than blocking your reply.
- **Default event behavior:** omitting `--events` watches ALL comment events (`comment.created`, `comment.replied`, `comment.reopened`, `comment.dispatch`) so normal comments and replies wake you immediately. Add `--events comment.dispatch` only if batch-then-Send mode is preferred.
- **Key-lifetime lifecycle & auto-stop:** `./ve-watch.sh` passes `VE_KEY` via stdin (never in `ps aux`), swallows `204` idle polls locally (**0 LLM tokens, ~0% CPU**), auto-recovers with backoff across server restarts, enforces a single watcher per scope (auto-replacing any stale watcher via PID lock), and auto-exits with `{"status":"key_expired","action":"stop"}` as soon as the scoped key expires or is revoked.
- **On `{"status":"key_expired",...}`, `{"status":"scope_gone",...}`, or `{"status":"idle_timeout",...}`:** stop quietly and **DO NOT re-arm**.
- **When a real comment event (`"type":"comment.*"`) arrives:**
  1. Fetch open comments (`GET {{COMMENT_LIST_URL}}`{{COMMENT_LIST_SUFFIX}}) and current source (`GET {{READ_SOURCE_URL}}`) to confirm the latest threads and HTML.
  2. Edit `./diagram.src.html` locally, re-`PUT` the same path (with optional `?note=...` or `-H 'X-VE-Note: ...'`), and verify `./diagram.render.json` has no `✗` diagnostics.
  3. Resolve each addressed thread via `POST {{BASE_URL}}/comments/<threadId>/resolve` with `{"note":"Done in v2: ..."}` (or reply via `POST {{BASE_URL}}/comments` if clarification is needed).
  4. **Re-arm** the single background watcher with `--after <eventId>` from the received event (`VE_KEY="$VE_KEY" ./ve-watch.sh --url '{{EVENTS_BASE_URL}}' --after <eventId>`) before finishing your reply so nothing posted while editing is missed.
- *Context hygiene tip:* for long-lived watching after heavy diagram authoring, prefer a lightweight/fresh session context if your harness supports it.

## 4. Comments, SSE & versions reference

- List open comments: `GET {{COMMENT_LIST_URL}}`{{COMMENT_LIST_SUFFIX}}. Returns structured `threads` (anchor quote/selector/headings, `version`, `replies`) and a readable `summary`.
- Read current source: `GET {{READ_SOURCE_URL}}` — edit locally and re-`PUT` the same path for a new version (`v2`, `v3`, …).
- Reply: `POST {{BASE_URL}}/comments` with `{"path":{{REPLY_PATH_ARG}},"replyTo":"c_1","body":"..."}` (replying to a resolved thread reopens it automatically).
- Resolve: `POST {{BASE_URL}}/comments/<threadId>/resolve` with `{"note":"Done in v2: ..."}` (optional `note` is posted as a reply first).
- Reopen: `POST {{BASE_URL}}/comments/<threadId>/reopen`.
- Watcher stream mode / raw SSE (for daemon runners): `VE_KEY="$VE_KEY" ./ve-watch.sh --url '{{EVENTS_BASE_URL}}' --mode stream` or `GET {{EVENTS_STREAM_URL}}` (supports `Last-Event-ID` / `after=<id>`, optional `path=`, `events=comment.dispatch`, `client=`).
- Folder tree & moves: `GET {{BASE_URL}}/tree` (list folder & child pages); `POST/PATCH/DELETE {{BASE_URL}}/folders`; `PATCH {{BASE_URL}}/files/<path>` `{"path":"new/name.html"}`.
- Version history{{VERSION_HINT}}: `GET {{VERSION_BASE}}/versions`, `GET {{VERSION_BASE}}/versions/v2`, `POST {{VERSION_BASE}}/restore` `{"version":"v2"}`.
