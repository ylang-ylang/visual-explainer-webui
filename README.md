# Visual Explainer Web UI

Independent Web UI and remote MCP wrapper for [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer). **This repository is not a fork of the renderer.** The upstream skill, prompts, kit and renderer are installed unmodified as a pinned dependency.

## Ownership

- **Official upstream:** skill/resources/prompts, HTML compilation and rendering.
- **This wrapper:** light visual library, sandboxed previews, authentication, signed page links, Entity grouping, HTTP management API and remote MCP transport.
- **Working agent:** inspects its own project, writes HTML and sends it to the renderer. The server does not run a model or accept local project paths.

The source of truth for the upstream revision is the `visual-explainer` dependency in `remote-app/package.json`: an official GitHub archive at an immutable commit. `remote-app/package-lock.json` locks the archive integrity and transitive dependencies. There is no copied renderer tree, fork patch set or startup download. The image installs the original package's dependencies rather than linking a fork checkout to wrapper dependencies.

The earlier [ylang-ylang/visual-explainer fork](https://github.com/ylang-ylang/visual-explainer) remains historical; it is no longer the deployment source. Wrapper code was extracted from its `eedec02cf126f1e5aba5d1e716f380dd898a5721` revision. Existing data, API routes, MCP endpoint, viewer sessions and signed URLs remain compatible.

## Build and run

```sh
git clone https://github.com/ylang-ylang/visual-explainer-webui.git
cd visual-explainer-webui
docker build --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -t visual-explainer-webui:1.1.0 .
```

Create a persistent data directory owned by UID/GID `1000:1000` and a private service-token file containing at least 32 random characters, readable by UID 1000. Set these values in a private `.env`:

```dotenv
PUBLIC_URL=http://your-server:8080
BIND_IP=127.0.0.1
PORT=8080
DATA_PATH=/absolute/path/to/diagrams
TOKEN_PATH=/absolute/path/to/api.token
```

Run `docker compose up -d`, or import `compose.yaml` as a TrueNAS Custom App after building/importing its image and resolving the placeholders. The container runs read-only as UID 1000; only the data volume and temporary runtime storage are writable.

The TrueNAS installation remains at `http://192.168.202.11:28319/`, with the same app ID `visual-explainer`, data volume, token and port. Updating to this wrapper requires an image change, not a data migration.

### Agents

Connect to `${PUBLIC_URL}/mcp` using `Authorization: Bearer <service-token>`. Read `visual-explainer://skill/SKILL.md` and the relevant resources/prompts, inspect your project locally, then call:

```json
{
  "name": "visual_explainer_render_html",
  "arguments": {
    "filename": "cosmos-attention.html",
    "html": "<!doctype html><html><head><title>Cosmos</title></head><body>...</body></html>",
    "entityId": "cosmos"
  }
}
```

The entity must already exist. Omit `entityId` to preserve an existing page's assignment; new pages default to unassigned. Explicit `null` unassigns. Render results include a persistent signed browser URL. All upstream read-only resources, prompts and supported tools are forwarded; remote rendering disables browser opening and executable Node models. Repository checks and video export require local project access and are not remote tools.

To use the original local Agent skill without the Web UI, install it directly from the official upstream, not from this wrapper.

### Viewers and security

Open `${PUBLIC_URL}/` and log in using the service token or a read-only viewer key: `HMAC-SHA256(token, "viewer-access")`, hex encoded. A `/?access=<viewer-key>` link establishes a seven-day HttpOnly viewer session and redirects to a clean URL.

A viewer session reads the whole library but cannot mutate it. A signed page URL grants read access to that page without a session. Entities organize diagrams; they are **not** separate permissions or filename namespaces. Generated pages run in sandboxed frames. Treat keys and page URLs as private; use TLS or an encrypted tunnel outside trusted networks. Rotating the service token invalidates viewer sessions and existing page URLs.

The official package currently includes `pptxgenjs` → `image-size`, with high-severity parser denial-of-service advisories [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) and [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr); npm reports no available dependency fix. This wrapper does not expose a PPTX export endpoint. The dependency is retained as declared by the unmodified upstream package; reassess these advisories when updating upstream.

## Entities and HTTP API

Reads accept a viewer session or service Bearer token; writes require the **service token**. Mutations with a cross-origin `Origin` header are rejected.

| Method | Endpoint | JSON body / result |
|---|---|---|
| GET | `/api/entities` | `{entities, unassignedCount, totalCount}`; each entity has `diagramCount` |
| POST | `/api/entities` | `{id, name}`; creates an entity |
| PATCH | `/api/entities/:id` | `{name}`; renames without changing its ID |
| DELETE | `/api/entities/:id` | Empty entities only; nonempty returns 409 |
| GET | `/api/pages?entityId=cosmos` | `{pages}`; omit filter for all, empty value for unassigned |
| GET | `/api/pages/:filename` | `{page}` including nullable `entityId` |
| PUT | `/api/pages/:filename` | `{html, entityId?}`; renders/creates or replaces; returns `{page, render}` |
| PATCH | `/api/pages/:filename` | `{entityId}`; moves, or `null` to unassign |

Entity IDs are lowercase slugs of 1–64 letters/digits, `_` or `-`, starting with a letter/digit. Names contain 1–120 characters. HTTP render filenames must be canonical `.html`/`.htm` basenames, not `.src.html` files. Filenames are globally unique: reusing one replaces the page even across entities. Moving a page changes only its assignment, not its HTML, modification time or URL. Errors return `{error}` and HTTP 400/401/403/404/409/413 as appropriate.

With `BASE_URL` and `VE_TOKEN` set privately:

```sh
curl --fail-with-body "$BASE_URL/api/entities" \
  -H "Authorization: Bearer $VE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"cosmos","name":"Cosmos"}'

jq -n --rawfile html architecture.html '{html:$html,entityId:"cosmos"}' |
  curl --fail-with-body -X PUT "$BASE_URL/api/pages/cosmos-architecture.html" \
    -H "Authorization: Bearer $VE_TOKEN" -H 'Content-Type: application/json' --data-binary @-
```

Back up the complete data directory, including HTML, `.src.html`, `.entities.json` and `.git`, plus the private token and deploy key separately. Invalid catalogs stop startup rather than silently discarding grouping.

## Page version history

The data directory is a Git repository on branch `main`, independent of this
wrapper's source repository. Startup imports existing pages without changing
their bytes or URLs. Successful API/MCP renders and Entity create/rename/delete
or page reassignment record a snapshot before returning success. Source,
rendered HTML and assignment changes from one publish share one commit.
Identical content does not produce an empty commit.

Only regular top-level `.html`/`.htm` files (including `.src.html`) and
`.entities.json` are versioned. Screenshots, symlinks, credentials and unrelated
files are excluded; unrelated staged entries are preserved. Direct filesystem
edits are captured at the next startup or successful mutation, not immediately.

Local history is enabled by default. Set `GIT_HISTORY_REMOTE` to push each
snapshot to an independent **private** repository. TrueNAS uses
[visual-explainer-pages](https://github.com/ylang-ylang/visual-explainer-pages).
For SSH, use a write-enabled deploy key scoped only to that content repository,
not a personal account key. Keep both credentials outside the page directory
and source checkout. An example `compose.override.yaml`:

```yaml
services:
  visual-explainer:
    environment:
      GIT_HISTORY_REMOTE: git@github.com:your-account/your-private-pages.git
      GIT_HISTORY_SSH_KEY: /run/secrets/history_ssh_key
      GIT_HISTORY_KNOWN_HOSTS: /run/secrets/history_known_hosts
    volumes:
      - /private/page-deploy-key:/run/secrets/history_ssh_key:ro
      - /private/trusted-known-hosts:/run/secrets/history_known_hosts:ro
```

The key must be readable by UID 1000, with mode `0600`; the trusted known-hosts
file must also be readable. SSH uses strict host verification and cannot prompt
or use an agent. The image includes Git/OpenSSH; no runtime installation is needed.

Commits are local-first and pushes synchronous. If Git fails, mutations report
503 rather than claiming successful synchronization; content may already be
saved, and a failed push preserves its local commit. The next mutation or startup
pushes pending commits, even if it creates no new version. There is no force-push,
pull, automatic reset or rollback. A configured remote that is unavailable during
startup prevents startup until it is reachable or the configuration is corrected.

Browse history on GitHub or clone the content repository. To restore a version,
extract its source using `git show <commit>:<filename>.src.html` in that clone,
then republish through the existing API/MCP with the intended `entityId`. This
records the restoration as a new commit. Do not reset the running data repository.
If a page has no source file, republish its saved `.html` instead.

## Following upstream

```sh
node scripts/update-upstream.mjs --check
node scripts/update-upstream.mjs
# Or select an explicit official commit:
node scripts/update-upstream.mjs --revision <40-character-commit-sha>
```

The updater changes the official archive pin and refreshes the npm lockfile. Review the upstream diff and run compatibility checks before merging. Daily/manual GitHub automation checks for a new official commit and opens an update PR only after building and exercising the updated wrapper. It does **not** merge or deploy updates automatically. Ordinary PR CI also builds and exercises the real container. Repository Actions permissions must allow GitHub Actions to create pull requests.

Compatibility checks use isolated data and a temporary token; **never run the smoke script against a real library**. They exercise official MCP resources/prompts/rendering, entity/API behavior, signed links, viewer read-only access and persistence after restart. The workflows contain the complete build/run commands.

## License

MIT. The upstream package retains its own license and attribution. The bundled Chinese font is derived from Debian `fonts-wqy-zenhei`; its license is included in `remote-app/static/`.
