#!/usr/bin/env bash
# Focused local iteration using an existing image; never contacts a live library.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fixture=$(mktemp -d /tmp/ve-delete-fixture.XXXXXX)
name="ve-delete-check-$(basename "$fixture" | tr '[:upper:]' '[:lower:]')"
image="${VE_DELETE_IMAGE:-visual-explainer-webui:local-debug}"
evidence="${VE_DELETE_EVIDENCE:-$(mktemp -d /tmp/ve-delete-evidence.XXXXXX)}"
mkdir -p "$fixture/data" "$fixture/remote" "$evidence"
chmod 0777 "$fixture" "$fixture/data" "$fixture/remote"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$fixture/token"
chmod 0444 "$fixture/token"
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then docker logs "$name" > "$evidence/server.log" 2>&1 || true; fi
  docker rm --force "$name" >/dev/null 2>&1 || true
  docker run --rm --user 0 --mount "type=bind,src=$fixture,dst=/fixture" "$image" chown -hR "$(id -u):$(id -g)" /fixture >/dev/null
  /bin/rm -rf -- "$fixture"
  exit "$status"
}
trap cleanup EXIT

docker run --rm --mount "type=bind,src=$fixture/remote,dst=/history-remote" "$image" git init --bare --initial-branch=main /history-remote/repo.git >/dev/null
mounts=()
for file in server.mjs catalog.mjs comments.mjs history.mjs tokens.mjs index.html; do
  mounts+=(--mount "type=bind,src=$(pwd)/remote-app/$file,dst=/opt/bridge/$file,readonly")
done
docker run --detach --name "$name" \
  --env PUBLIC_URL=http://127.0.0.1:8080 --env PORT=8080 \
  --env VISUAL_EXPLAINER_OUTPUT_DIR=/data --env TOKEN_FILE=/run/secrets/api_token \
  --env GIT_HISTORY_REMOTE=/history-remote/repo.git \
  --mount "type=bind,src=$fixture/data,dst=/data" \
  --mount "type=bind,src=$fixture/remote,dst=/history-remote" \
  --mount "type=bind,src=$fixture/token,dst=/run/secrets/api_token,readonly" \
  --mount "type=bind,src=$(pwd)/scripts,dst=/opt/bridge/scripts,readonly" \
  "${mounts[@]}" "$image" >/dev/null
wait_ready() {
  docker exec "$name" node --input-type=module -e '
    import { setTimeout } from "node:timers/promises";
    for (let n = 0; n < 90; n++) {
      try { const r = await fetch("http://127.0.0.1:8080/health"); if (r.ok && await r.text() === "ok") process.exit(0); } catch {}
      await setTimeout(500);
    }
    throw new Error("Disposable deletion fixture did not become healthy");'
}
wait_ready
# Adjacent menu/key/DnD behavior runs on the same disposable server, never the live demo.
docker exec --env VE_CONTEXT_SMOKE=1 "$name" node scripts/context-menu-smoke.mjs | tee "$evidence/context-menu.log"
docker exec --env VE_DELETE_SMOKE=1 "$name" node scripts/delete-smoke.mjs | tee "$evidence/delete.log"
docker cp "$name:/tmp/ve-delete-confirm-fixture.png" "$evidence/confirm-disposable.png" >/dev/null
docker cp "$name:/tmp/ve-context-desktop.png" "$evidence/context-desktop.png" >/dev/null
docker cp "$name:/tmp/ve-context-narrow-edge.png" "$evidence/context-narrow-edge.png" >/dev/null
docker restart "$name" >/dev/null
wait_ready
docker exec --env VE_DELETE_SMOKE=1 --env VE_DELETE_PHASE=persistence "$name" node scripts/delete-smoke.mjs | tee "$evidence/persistence.log"
printf 'Deletion evidence: %s\n' "$evidence"
