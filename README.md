# Visual Explainer Web UI

Independent Web UI and remote MCP wrapper for [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer). **This repository is not a fork of the renderer.** The upstream skill, prompts, kit and renderer are installed unmodified as a pinned dependency.

## Ownership

- **Official upstream:** skill/resources/prompts, HTML compilation and rendering.
- **This wrapper:** light visual library, sandboxed previews, authentication, one folder hierarchy, scoped HTTP publishing, Git version previews/restores and remote MCP transport.
- **Working agent:** inspects its own project, writes HTML and sends it to the renderer. The server does not run a model or accept local project paths.
- **Feedback boundary:** original kit/Comment/Ask/Reply behavior belongs upstream; this wrapper must not add its own comment queue, feedback protocol or agent orchestration, or claim automatic cross-host return.
- **Browser feedback:** select text → Comment/Ask → Reply → Copy/paste into the working agent's chat.
- **Original automatic send-back:** native Pi + Glimpse only, not the browser or remote MCP wrapper.
- **Current sandbox limit:** the opaque preview blocks original localStorage draft persistence; unsent notes are lost on reload.

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

For direct HTTP publishing, right-click a folder in the Web UI and choose **文件夹 API** as an administrator: a usable **Key** appears automatically, with a **7-day** server-enforced expiry. Choose 1 / 7 / 30 days or no expiry, then use **复制提示词与命令**. This copies shell-commented agent instructions followed by an executable curl command; save your HTML as `./diagram.html` before running it. Changing validity updates the same key from now, without rotating it. Each key covers its API folder and all its current descendants; selecting an ordinary nested folder changes only the example upload target. Moving the API folder retains its key and stable endpoint; moving content into or out of its subtree changes membership. Agents do not need MCP, a repository clone or SSH access to TrueNAS.

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

The library is a compact file tree with folder/file icons, expand arrows, indentation and branch guides, including empty folders. File rows show their filenames (or a meaningful title for older UUID-named pages); hover for the diagram title, full path and update time, or select a file to see details in the reader. Previously unassigned diagrams appear at **根目录**.

Right-click the tree's blank area or **根目录** and choose **新建文件夹** to create a top-level folder. Right-click a folder to create a child **in that folder**, rename it, move it, open **文件夹 API**, or delete it when empty. Creation asks only for a name. Right-click a diagram for **重命名**, **移动到…**, **版本历史**, opening actions, or the final destructive **删除图解** entry. Deletion asks for confirmation naming the clicked diagram and full path; cancel changes nothing. Only administrators can delete diagrams. The reader's title also offers that diagram's menu. Context-clicking does not expand a folder or change the preview; actions always address the clicked item, not a previously selected diagram. There are no permanent management buttons or a separate workspace flow.

Focus a row and press **Shift+F10** or the **ContextMenu** key for the same menu; use arrows, Home/End and Enter within it, and Escape to dismiss. Arrow keys also navigate visible tree rows and expand/collapse folders. Menus stay inside the viewport and close on outside click, scroll or context change. Viewers get reading actions and API information only, without key issuance or management actions.

Administrators can still drag diagrams and folders onto any folder or **根目录**; highlighted targets show where the item will go. Folder subtrees move together, including nested API folders. Dragging a row elsewhere does not reorder it; Esc cancels. Menu actions reuse the existing destination/name dialogs. The preview fills the current reader width directly, with responsive navigation, fullscreen and independent opening retained.

API folders retain stable internal Entity IDs even when nested inside other folders. Their own endpoints/keys remain rooted there, while their new parent's key includes the moved-in subtree and their former parent's key loses it. Moving an ordinary folder to Root creates a stable API-folder ID, but never creates a key. Files, source companions, signed links and existing versions retain their identities. Cycles and destination-name collisions are rejected before the catalog changes.

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

Folder tokens can access only their top-level folder's tree, files and permitted history/restores. They cannot list the whole library, administer top-level folders or credentials, or invoke MCP. The server returns each secret only on creation; lists and expiry edits contain metadata only. The page retains its new key only in memory and reuses it across panel close/reopen and library refresh; closing the panel does not revoke it. Reloading/leaving the page loses that secret, so the next API open issues a new key without revoking already-copied commands. Read-only viewers never issue or receive keys. Existing named/unnamed non-expiring tokens remain unchanged; administrators can still list and explicitly revoke them through the existing endpoints below.

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
| PATCH | `/api/pages/:filename` | `{entityId, path?}`; move/rename, or `null` for Root |
| DELETE | `/api/pages/:filename` | Administrator only; exact stable page identity; 204 after deletion/history synchronization, 404 if absent. Scoped folder keys cannot delete diagrams |
| POST | `/api/moves` | Administrator only; `{source, destination, name?}`; source is `{kind:"page", filename}` or `{kind:"folder", entityId, path}`; destination is `{entityId, path}` (`null, ""` for Root). Returns `{move:{moved,...}}`; no-op does not create a version |
| GET | `/api/session` | `{role, entityId?}`; `admin`, `viewer` or `agent` |
| GET | `/api/entities/:id/tree` | `{folders:[{path}], pages}` including descendant API folders; all response paths are relative to this stable API folder |
| POST | `/api/entities/:id/folders` | `{path}`; creates parents |
| PATCH | `/api/entities/:id/folders` | `{path, newPath}`; recursive move |
| DELETE | `/api/entities/:id/folders?path=...` | Empty folders only |
| GET / PUT | `/api/entities/:id/files/<path>` | Read source / publish raw `text/html`, up to 12 MiB |
| PATCH | `/api/entities/:id/files/<path>` | `{path}`; move/rename without changing page identity |
| GET / POST | `/api/entities/:id/tokens` | Administrator only; list metadata / create `{name?, expiresIn?}`; name defaults to an automatic label. `expiresIn`: integer 1–2592000 seconds or `null`; omitted/null retains legacy no-expiry behavior. Expiring metadata includes `expiresAt` (UTC ISO timestamp); secret returned only on creation |
| PATCH | `/api/entities/:id/tokens/:tokenId` | Administrator only; `{expiresIn}` updates the same active key's expiry from now (or `null` removes expiry); no secret returned; expired keys cannot be reactivated |
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

Back up the complete data directory, including HTML/source companions, `.entities.json`, the private `.tokens.json` registry and `.git`, plus the service token and deploy key separately. The token registry is mode 0600 and contains hashes, never cleartext secrets; it is excluded from content Git. Catalog v1/v2 upgrades automatically to v3, adding real parent edges to API folders and root-page logical names; the exact old catalog is saved privately as `.entities.pre-v3.<uuid>.backup.json`. Older images cannot read v3. To downgrade, stop the service and restore the complete pre-upgrade data backup (including `.git`), not just that catalog copy; migration itself records a v3 history snapshot. Expiry adds an optional `expiresAt` field to v1 token records; records without that field stay non-expiring. Older images cannot read newly expiring records. Invalid catalogs or credential registries stop startup rather than silently losing metadata.

## Page version history

Page history is stored on branch `main`, independently of this wrapper's source
repository. The repository mirrors the library's Entity groups:

- `<entity-id>/<logical/path>.html` and its companion source files.
- `_unassigned/<filename>` for unassigned pages and orphan sources.
- `.entities.json` at the root, retaining the exact Entity metadata and names.

Top-level Git directory names use stable API-folder IDs, independent of visual parents. Reparenting such a folder changes its catalog edge, not its stable Git root. Moving an ordinary subtree across API folders moves rendered HTML and source projections together in one commit; flat serving files never move. Empty directories are retained using generated empty `.gitkeep` markers, removed when content arrives. Folder structure and page identities are recorded in the catalog; credentials are not.

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

The reader's versions panel reads real Git snapshots by stable page identity, including paths before folder moves. Historical HTML is served through revision-specific signed sandbox URLs. Restoring republishes saved source (or old rendered HTML when no source exists) into the current Entity/path and records a new commit; it never rolls back the whole catalog. Folder tokens must have current subtree membership to list, read or restore a page's history, and each returned version must also have belonged to that scope at the time. Historical membership never grants a former parent access after a move. Previously issued signed page/version URLs remain independent read capabilities. Deleting a diagram removes its current rendered HTML, owned editable source companions (including legacy suffix/case variants), and uniquely owned renderer `<stem>.sheet[-N].png` files. Its current signed URL and current API routes then return 404; containing folders, API anchors, credentials, shared assets and other diagrams remain. Symlink/nonregular targets and ambiguous shared render-sheet ownership are rejected before deletion. Files are preflighted and staged temporarily so filesystem/catalog failures restore the originals; history synchronization remains local-first with explicit 503 errors, not rollback. A pre-deletion snapshot also preserves edits made directly on disk. Deletion is a new history commit, never a history rewrite; old signed historical-version URLs still read their saved bytes. There is no trash or undelete UI: recover an old source from Git and republish it. Renderer sheets remain excluded from Git, as before.

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

Compatibility checks use isolated data and a temporary token; **never run the smoke script against a real library**. They exercise official MCP resources/prompts/rendering, migration, nested directories, scoped credentials and cross-folder denial, same-origin administrator sessions, real Git version previews/restores, signed links and restart persistence. `scripts/folders-smoke.mjs` additionally drives real right-click menus through name-only root/nested creation, existing-tree preservation, root rename/delete, automatic key issuance/reuse, validity edits, real clipboard copy, publication and version restore, mobile layout and read-only behavior. Its host runner executes the exact clipboard payload with curl against the disposable server and checks exact source bytes and explicit revocation. `scripts/token-expiry-smoke.mjs` advances a disposable server's clock to check expiry at the exact boundary and across restart, along with unchanged legacy records, metadata-only edits and hash-only storage. `scripts/catalog-test.mjs` checks exact-byte v1/v2 backup migration and atomic hierarchy transformations. `scripts/organize-check.mjs` drives actual Chromium pointer gestures (not synthetic drop events) through cross-folder/root diagram moves, nested API folders, mixed subtrees, rejection/cancel/no-op, in-flight refresh, current-scope authorization and restart persistence, plus responsive preview/fullscreen checks. `scripts/context-menu-smoke.mjs` is the focused context-tree browser check: real right clicks, explicit non-selected file targets, root/child creation, ordinary and nested API-folder rename/move, versions, API reuse, deletion, keyboard dismissal/navigation, menu viewport edges, native pointer drag and viewer restrictions. It also runs in `check-image.sh`. For focused local iteration, run it only against a disposable local container (localhost `PUBLIC_URL`, temporary data/token, `VE_CONTEXT_SMOKE=1`), mounting the current `index.html` and `scripts/` into the existing development image; no release rebuild is needed. It writes secret-free desktop and narrow screenshots to `/tmp/ve-context-*.png` inside that container. For diagram deletion specifically, `bash scripts/delete-check.sh` reuses `visual-explainer-webui:local-debug` (override with `VE_DELETE_IMAGE`), source-mounts a disposable container, and runs adjacent context-menu checks plus `scripts/delete-smoke.mjs` and a real restart. `VE_DELETE_EVIDENCE=/tmp/your-evidence` selects the host evidence directory; only disposable data/token/remote fixtures are removed. It covers cancel/no-write, non-selected targeting, selected historical-preview/hash cleanup, stale refresh, root/nested/legacy sources, render sheets, symlink/collision rejection, admin/viewer/scoped/Origin boundaries, catalog rollback, failed history push/recovery, and old historical bytes. The deletion smoke also runs in `check-image.sh`; the workflows contain the complete release check commands.

## License

MIT. The upstream package retains its own license and attribution. The bundled Chinese font is derived from Debian `fonts-wqy-zenhei`; its license is included in `remote-app/static/`.
