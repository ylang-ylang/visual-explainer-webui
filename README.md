# Visual Explainer Web UI

Independent Web UI and remote MCP wrapper for [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer). **This repository is not a fork of the renderer.** The upstream skill, prompts, kit and renderer are installed unmodified as a pinned dependency.

## Ownership

- **Official upstream:** skill/resources/prompts, HTML compilation and rendering.
- **This wrapper:** light visual library, sandboxed previews, authentication, one folder hierarchy, scoped HTTP publishing, Git version previews/restores and remote MCP transport.
- **Working agent:** inspects its own project, writes HTML and sends it to the renderer. The server does not run a model or accept local project paths.

The source of truth for the upstream revision is the `visual-explainer` dependency in `remote-app/package.json`: an official GitHub archive at an immutable commit. `remote-app/package-lock.json` locks the archive integrity and transitive dependencies. There is no copied renderer tree, fork patch set or startup download. The image installs the original package's dependencies rather than linking a fork checkout to wrapper dependencies.

The earlier [ylang-ylang/visual-explainer fork](https://github.com/ylang-ylang/visual-explainer) remains historical; it is no longer the deployment source. Wrapper code was extracted from its `eedec02cf126f1e5aba5d1e716f380dd898a5721` revision. Existing data, API routes, MCP endpoint, viewer sessions and signed URLs remain compatible.

## Build and run

```sh
git clone https://github.com/ylang-ylang/visual-explainer-webui.git
cd visual-explainer-webui
docker build --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -t visual-explainer-webui:1.3.0 .
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

The TrueNAS installation remains at `http://192.168.202.11:28319/`, with the same app ID `visual-explainer`, data volume, token and port. Version 1.3 upgrades the catalog in place while retaining existing serving files, signed links and Git ancestry. Back up the data directory before updating; older images cannot read the upgraded catalog.

### Agents

For direct HTTP publishing, select a folder in the Web UI and open **API**, then click **生成 API 令牌**. No name or other input is needed; copy the one-time secret or ready-to-use upload command, and revoke the token later. Each token covers that top-level folder and all its descendants; opening API from a nested folder does not narrow the token's scope. Agents do not need MCP, a repository clone or SSH access to TrueNAS.

For clients that prefer MCP, connect to `${PUBLIC_URL}/mcp` using `Authorization: Bearer <service-token>`. Read `visual-explainer://skill/SKILL.md` and the relevant resources/prompts, inspect your project locally, then call:

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

### Direct HTTP publishing

The library shows one folder tree, including existing content and empty folders. Previously unassigned diagrams appear at the root. **New Folder** asks only for a name: at **Root** it creates a top-level folder; after selecting a folder it creates a child there. There is no separate workspace selector, create-space action or identifier field. The current destination is shown above the tree; choose **Root** to create another top-level folder.

Top-level folders retain internal Entity IDs for API addresses, credential boundaries and existing content history. New IDs are generated automatically; existing IDs, assignments, serving files and signed links are unchanged, with no catalog migration. Folders can be renamed and empty folders deleted through their tree menu; nested folders and files retain their existing move controls. Git records edits, with revision previews and restores in the reader.

Configure `BASE_URL` and the folder's `PAGE_TOKEN` through the agent's secret environment, not its prompt or repository:

```sh
curl --fail-with-body -X PUT \
  "$BASE_URL/api/entities/ray/files/architecture/overview.html" \
  -H "Authorization: Bearer $PAGE_TOKEN" \
  -H 'Content-Type: text/html' \
  --data-binary @diagram.html
```

The top-level folder (internal Entity) must exist; missing parent folders are created automatically. A new path creates a diagram, and the same path updates it with a new Git revision. The response includes `page.url` and `revision`. Upload complete HTML, optionally containing SVG, CSS and JavaScript; this is not an arbitrary asset-hosting or server-execution API. `GET` on the same endpoint returns the exact saved source, or the rendered HTML for older pages without source.

Logical API paths are relative to one top-level folder's internal Entity ID. The same path can exist independently in different top-level folders. Use URL-encoded UTF-8 path segments; traversal, hidden segments and encoded separators are rejected. The internal `filename` remains a stable page identity, so moving a logical path does not change its signed URL.

Folder tokens can access only their top-level folder's tree, files and permitted history/restores. They cannot list the whole library, administer top-level folders or credentials, or invoke MCP. Secrets are shown once; token lists contain metadata only. Revoke a token from the API dialog when access ends.

### Viewers and security

Open `${PUBLIC_URL}/` and log in once using the existing service token. Successful web login grants management immediately; there is no separate management password or second unlock. Scoped API tokens remain separate credentials for external agents, not browser passwords. Credentials are not stored in browser storage.

Valid legacy `ve_viewer` browser sessions are accepted as management sessions and exchanged for an administrator cookie on the next library load, so existing users do not need to enter their credential again. **This migration upgrades all already-issued legacy browser sessions, including legacy read-only sessions, until they expire or are logged out.**

Fresh `/?access=<viewer-key>` links use a separate read-only cookie and redirect to a clean URL. The viewer key is `HMAC-SHA256(token, "viewer-access")`, hex encoded; it is accepted only through the viewing link, not the login form. Opening a viewing link does not downgrade an already logged-in owner.

A viewer session reads the whole library and its versions but cannot mutate it. Folder tokens are scoped API credentials, not viewer sessions; the service token remains a global administrator credential. Signed current-page URLs grant read access only to the current diagram; historical previews use separate revision-specific signed URLs. Generated pages run in opaque sandboxed frames. Treat keys and page URLs as private; use TLS or an encrypted tunnel outside trusted networks. Rotating the service token invalidates signed links and sessions.

The official package currently includes `pptxgenjs` → `image-size`, with high-severity parser denial-of-service advisories [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) and [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr); npm reports no available dependency fix. This wrapper does not expose a PPTX export endpoint. The dependency is retained as declared by the unmodified upstream package; reassess these advisories when updating upstream.

## Folders and HTTP API

The existing `/api/entities` endpoints and `entityId` fields remain compatible; they identify top-level folders internally, not a second organizational layer.

Reads accept a viewer session or service Bearer token; Entity-scoped routes also accept the matching folder Bearer token. Management requires the service Bearer or an administrator cookie; cookie mutations require an exact same-origin `Origin`. Folder tokens can mutate only their own top-level folder's files and descendants and restore permitted file versions. Any supplied cross-origin `Origin` is rejected.

| Method | Endpoint | JSON body / result |
|---|---|---|
| GET | `/api/tree` | `{entities, folders, pages, unassignedCount, totalCount}`; all top-level and nested folders, including empty folders; each nested folder has `entityId` and `path`; no scoped-token access |
| GET | `/api/entities` | `{entities, unassignedCount, totalCount}`; each entity has `diagramCount` |
| POST | `/api/entities` | `{name, id?}`; creates a top-level folder, generating its ID when omitted; explicit legacy IDs still accepted |
| PATCH | `/api/entities/:id` | `{name}`; renames without changing its ID |
| DELETE | `/api/entities/:id` | Empty entities only; nonempty returns 409 |
| GET | `/api/pages?entityId=cosmos` | `{pages}`; omit filter for all, empty value for unassigned |
| GET | `/api/pages/:filename` | `{page}` including nullable `entityId` |
| PUT | `/api/pages/:filename` | `{html, entityId?}`; renders/creates or replaces; returns `{page, render}` |
| PATCH | `/api/pages/:filename` | `{entityId}`; moves, or `null` to unassign |
| GET | `/api/session` | `{role, entityId?}`; `admin`, `viewer` or `agent` |
| GET | `/api/entities/:id/tree` | `{folders:[{path}], pages}` including empty folders |
| POST | `/api/entities/:id/folders` | `{path}`; creates parents |
| PATCH | `/api/entities/:id/folders` | `{path, newPath}`; recursive move |
| DELETE | `/api/entities/:id/folders?path=...` | Empty folders only |
| GET / PUT | `/api/entities/:id/files/<path>` | Read source / publish raw `text/html`, up to 12 MiB |
| PATCH | `/api/entities/:id/files/<path>` | `{path}`; move/rename without changing page identity |
| GET / POST | `/api/entities/:id/tokens` | Administrator only; list metadata / create `{}` with an automatic label; legacy `{name}` remains supported |
| DELETE | `/api/entities/:id/tokens/:tokenId` | Administrator only; revoke |
| GET | `/api/pages/:filename/versions` | `{versions}`; newest 50 meaningful Git revisions with signed preview URLs |
| GET | `/api/pages/:filename/versions/:revision` | `{version, html}`; saved source when available |
| POST | `/api/pages/:filename/restore` | `{revision}`; restore content at its current path as a new commit |

Entity IDs are lowercase slugs of 1–64 letters/digits, `_` or `-`, starting with a letter/digit. Names contain 1–120 characters. Logical file paths end in `.html`/`.htm`, not `.src.html`, and are unique within an Entity. Page responses include both logical `path` and stable internal `filename`. Existing basename-based HTTP/MCP uploads remain supported; updating an existing page preserves its logical path. Moving an assignment rejects destination-path collisions rather than overwriting another diagram. Nonempty folders and Entities cannot be deleted. Errors return `{error}` with the relevant HTTP status, including 415 for unsupported upload content types and 503 for Git synchronization failures.

With `BASE_URL` and `VE_TOKEN` set privately:

```sh
curl --fail-with-body "$BASE_URL/api/entities" \
  -H "Authorization: Bearer $VE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"cosmos","name":"Cosmos"}'

jq -n --rawfile html architecture.html '{html:$html,entityId:"cosmos"}' |
  curl --fail-with-body -X PUT "$BASE_URL/api/pages/cosmos-architecture.html" \
    -H "Authorization: Bearer $VE_TOKEN" -H 'Content-Type: application/json' --data-binary @-
```

Back up the complete data directory, including HTML/source companions, `.entities.json`, the private `.tokens.json` registry and `.git`, plus the service token and deploy key separately. The token registry is mode 0600 and contains hashes, never cleartext secrets; it is excluded from content Git. Invalid catalogs or credential registries stop startup rather than silently losing metadata.

## Page version history

Page history is stored on branch `main`, independently of this wrapper's source
repository. The repository mirrors the library's Entity groups:

- `<entity-id>/<logical/path>.html` and its companion source files.
- `_unassigned/<filename>` for unassigned pages and orphan sources.
- `.entities.json` at the root, retaining the exact Entity metadata and names.

Top-level Git directory names use stable Entity IDs. Renaming a display name does not rename that root directory; moving a file or nested folder moves rendered HTML and source together in one commit. Empty directories are retained using generated empty `.gitkeep` markers, removed when content arrives. Folder structure and page identities are recorded in the catalog; credentials are not.

Successful API/MCP renders and Entity mutations snapshot and synchronize the
directory layout before returning success. Identical content creates no empty
commit. Screenshots, symlinks, credentials and unrelated files are excluded.
Direct filesystem edits are captured at the next startup or successful mutation.

The serving files remain canonical and flat, so page URLs, API basename IDs and
file bytes do not change. `data/.git` is a bare object store, not a second writable
copy of pages; clone the content repository to obtain real Entity/nested directories
and a normal clean worktree. Existing flat and Entity-folder history is migrated with
an additional commit, retaining all previous commits and unrelated legacy index bytes.

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

The reader's versions panel reads real Git snapshots by stable page identity, including paths before folder moves. Historical HTML is served through revision-specific signed sandbox URLs. Restoring republishes saved source (or old rendered HTML when no source exists) into the current Entity/path and records a new commit; it never rolls back the whole catalog. Folder tokens cannot read or restore a version that belonged to another Entity.

Browse history on GitHub or clone the content repository. To restore a version,
extract its source using `git show <commit>:<entity-id>/<logical/path>.src.html` in that clone,
then republish through the existing API/MCP with the intended `entityId`. This
records the restoration as a new commit. Do not reset the running data repository.
If a page has no source file, republish its saved `.html` instead.
Versions before the folder migration retain their original root-level filenames.

## Following upstream

```sh
node scripts/update-upstream.mjs --check
node scripts/update-upstream.mjs
# Or select an explicit official commit:
node scripts/update-upstream.mjs --revision <40-character-commit-sha>
```

The updater changes the official archive pin and refreshes the npm lockfile. Review the upstream diff and run compatibility checks before merging. Daily/manual GitHub automation checks for a new official commit and opens an update PR only after building and exercising the updated wrapper. It does **not** merge or deploy updates automatically. Ordinary PR CI also builds and exercises the real container. Repository Actions permissions must allow GitHub Actions to create pull requests.

Compatibility checks use isolated data and a temporary token; **never run the smoke script against a real library**. They exercise official MCP resources/prompts/rendering, migration, nested directories, scoped credentials and cross-folder denial, same-origin administrator sessions, real Git version previews/restores, signed links and restart persistence. `scripts/folders-smoke.mjs` additionally drives the real browser through the single name-only root/nested creation flow, existing-tree preservation, root rename/delete, API-token issuance, publication and version restore, mobile layout and read-only login behavior. The workflows contain the complete build/run commands.

## License

MIT. The upstream package retains its own license and attribution. The bundled Chinese font is derived from Debian `fonts-wqy-zenhei`; its license is included in `remote-app/static/`.
