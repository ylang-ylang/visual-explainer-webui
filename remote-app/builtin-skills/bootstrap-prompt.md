{{SCOPE_INTRO}}

{{ENDPOINT_LIST}}
- Official skill & docs bundle: {{ORIGINAL_BASE}}/bundle

## 1. Read the official skill before writing HTML

Do not upload arbitrary HTML. First fetch the official bootstrap bundle (index, `SKILL.md`, `references/style-guide.md`, `references/kit.md`, and `references/diagrams.md`) in one command:

```bash
VE_KEY={{VE_KEY_QUOTED}}

curl --fail-with-body {{BUNDLE_URL_QUOTED}} -H "Authorization: Bearer $VE_KEY"
```

Individual docs (`{{ORIGINAL_BASE}}/SKILL.md`, `{{ORIGINAL_BASE}}/references/style-guide.md`, `{{ORIGINAL_BASE}}/references/<name>.md`) also remain available separately, and `?refs=...` can include extra references like `motion` in one call.
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
- Wiki drill-down: publish child diagrams under `{{CHILD_PATH_EXAMPLE}}` (same scoped folder key) and add `data-ve-child="<child>"` (omit `.html`) on any SVG node (`<g class="ve-n" data-ve-child="...">`) or inline `<span>`. The WebUI viewer injects portal styling, stacked badges, hover previews, and click navigation at view time — plain appearance in standalone checksheets is expected, so do NOT add custom fake-portal CSS.
- **Before replying with `page.url`**, start the non-blocking background comment listener in §3 by default (if your harness supports background/async execution), then share `page.url` from the response (also returns `page.filename`, `version`, `commentsUrl`, and `openComments`).

## 3. Live comment listener (default) & closed-loop updates

By default, after publishing and passing visual checks, start a **non-blocking background listener** (using whatever background task / async command / watcher mechanism your harness provides — never block your reply) **before** replying with `page.url`, so the WebUI immediately shows an active listener and clicking **Send** in Comments wakes you automatically:
- Background one-shot listener: `curl -sS -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $VE_KEY" {{EVENTS_ONCE_URL_QUOTED}}` (waits up to 300s and exits with a JSON `comment.dispatch` event on `200`, or `204` on timeout{{EVENTS_ONCE_NOTE}}). If your harness has no non-blocking background task capability, skip this step rather than blocking your reply.
- **When a `comment.dispatch` event arrives (`200` JSON):**
  1. Fetch open comments (`GET {{COMMENT_LIST_URL}}`{{COMMENT_LIST_SUFFIX}}) and current source (`GET {{READ_SOURCE_URL}}`) to confirm the latest threads and HTML.
  2. Edit `./diagram.src.html` locally, re-`PUT` the same path (with optional `?note=...` or `-H 'X-VE-Note: ...'`), and verify `./diagram.render.json` has no `✗` diagnostics.
  3. Resolve each addressed thread via `POST {{BASE_URL}}/comments/<threadId>/resolve` with `{"note":"Done in v2: ..."}` (or reply via `POST {{BASE_URL}}/comments` if clarification is needed).
  4. **Re-arm** the non-blocking background listener (append `&after=<eventId>` from the received event so nothing dispatched while editing is missed) before finishing your reply.
- **On `204` timeout:** exit quietly, or re-arm if a review is still actively in progress.

## 4. Comments, SSE & versions reference

- List open comments: `GET {{COMMENT_LIST_URL}}`{{COMMENT_LIST_SUFFIX}}. Returns structured `threads` (anchor quote/selector/headings, `version`, `replies`) and a readable `summary`.
- Read current source: `GET {{READ_SOURCE_URL}}` — edit locally and re-`PUT` the same path for a new version (`v2`, `v3`, …).
- Reply: `POST {{BASE_URL}}/comments` with `{"path":{{REPLY_PATH_ARG}},"replyTo":"c_1","body":"..."}` (replying to a resolved thread reopens it automatically).
- Resolve: `POST {{BASE_URL}}/comments/<threadId>/resolve` with `{"note":"Done in v2: ..."}` (optional `note` is posted as a reply first).
- Reopen: `POST {{BASE_URL}}/comments/<threadId>/reopen`.
- Persistent SSE stream (alternative for daemon runners): `GET {{EVENTS_STREAM_URL}}` (supports `Last-Event-ID` / `after=<id>`, optional `path=`, `events=`, `client=`).
- Folder tree & moves: `GET {{BASE_URL}}/tree` (list folder & child pages); `POST/PATCH/DELETE {{BASE_URL}}/folders`; `PATCH {{BASE_URL}}/files/<path>` `{"path":"new/name.html"}`.
- Version history{{VERSION_HINT}}: `GET {{VERSION_BASE}}/versions`, `GET {{VERSION_BASE}}/versions/v2`, `POST {{VERSION_BASE}}/restore` `{"version":"v2"}`.
