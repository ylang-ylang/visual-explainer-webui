#!/usr/bin/env bash
# Targeted local-only transport + adjacent UI/deletion checks. No image build or live data.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fixture=$(mktemp -d /tmp/ve-original-fixture.XXXXXX)
name="ve-original-check-$(basename "$fixture" | tr '[:upper:]' '[:lower:]')"
image="${VE_ORIGINAL_IMAGE:-visual-explainer-webui:local-debug}"
evidence="${VE_ORIGINAL_EVIDENCE:-$(mktemp -d /tmp/ve-original-evidence.XXXXXX)}"
mkdir -p "$fixture/data" "$fixture/remote" "$evidence"
chmod 0777 "$fixture" "$fixture/data" "$fixture/remote"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$fixture/token"
chmod 0444 "$fixture/token"
port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
base="http://127.0.0.1:$port"
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    docker logs "$name" > "$evidence/server.log" 2>&1 || true
    docker cp "$name:/tmp/ve-original-api-evidence/." "$evidence/" >/dev/null 2>&1 || true
  fi
  docker rm --force "$name" >/dev/null 2>&1 || true
  docker run --rm --user 0 --mount "type=bind,src=$fixture,dst=/fixture" "$image" chown -hR "$(id -u):$(id -g)" /fixture >/dev/null
  /bin/rm -rf -- "$fixture"
  exit "$status"
}
trap cleanup EXIT

docker run --rm --mount "type=bind,src=$fixture/remote,dst=/history-remote" "$image" git init --bare --initial-branch=main /history-remote/repo.git >/dev/null
mounts=()
for file in server.mjs catalog.mjs comments.mjs events.mjs accounts.mjs history.mjs tokens.mjs index.html; do
  mounts+=(--mount "type=bind,src=$(pwd)/remote-app/$file,dst=/opt/bridge/$file,readonly")
done
docker run --detach --name "$name" --publish "127.0.0.1:$port:$port" \
  --env "PUBLIC_URL=$base" --env "PORT=$port" \
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
      try { const r = await fetch(new URL("/health", process.env.PUBLIC_URL)); if (r.ok && await r.text() === "ok") process.exit(0); } catch {}
      await setTimeout(500);
    }
    throw new Error("Disposable original-API fixture did not become healthy");'
}
wait_ready
docker exec --env VE_ORIGINAL_API_SMOKE=1 "$name" node scripts/original-api-smoke.mjs | tee "$evidence/original-api.log"
docker cp "$name:/tmp/ve-original-api-evidence/." "$evidence/" >/dev/null
VE_HISTORY_FIXTURE="$fixture" VE_HISTORY_CONTAINER="$name" VE_BASE_URL="$base" VE_TOKEN="$(cat "$fixture/token")" \
  node scripts/folders-check.mjs | tee "$evidence/folders.log"
docker cp "$name:/tmp/ve-original-copy-instructions.png" "$evidence/copied-instructions.png" >/dev/null
docker cp "$name:/tmp/ve-original-copy-commands.png" "$evidence/copied-commands.png" >/dev/null
docker exec --env VE_CONTEXT_SMOKE=1 "$name" node scripts/context-menu-smoke.mjs | tee "$evidence/context-menu.log"
docker exec --env VE_DELETE_SMOKE=1 "$name" node scripts/delete-smoke.mjs | tee "$evidence/delete.log"
docker restart "$name" >/dev/null
wait_ready
docker exec --env VE_DELETE_SMOKE=1 --env VE_DELETE_PHASE=persistence "$name" node scripts/delete-smoke.mjs | tee "$evidence/persistence.log"
printf 'Original API evidence: %s\n' "$evidence"
