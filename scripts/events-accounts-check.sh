#!/usr/bin/env bash
# Focused events, accounts, and guest share links E2E check on a disposable container.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fixture=$(mktemp -d /tmp/ve-events-accounts-fixture.XXXXXX)
name="ve-events-accounts-check-$(basename "$fixture" | tr '[:upper:]' '[:lower:]')"
image="${VE_EVENTS_ACCOUNTS_IMAGE:-visual-explainer-webui:local-debug}"
mkdir -p "$fixture/data" "$fixture/remote"
chmod 0777 "$fixture" "$fixture/data" "$fixture/remote"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$fixture/token"
chmod 0444 "$fixture/token"
port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
base="http://127.0.0.1:$port"
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then docker logs "$name" 2>&1 | tail -n 80 || true; fi
  docker rm --force "$name" >/dev/null 2>&1 || true
  docker run --rm --user 0 --mount "type=bind,src=$fixture,dst=/fixture" "$image" chown -hR "$(id -u):$(id -g)" /fixture >/dev/null
  /bin/rm -rf -- "$fixture"
  exit "$status"
}
trap cleanup EXIT

docker run --rm --mount "type=bind,src=$fixture/remote,dst=/history-remote" "$image" git init --bare --initial-branch=main /history-remote/repo.git >/dev/null
mounts=()
for file in server.mjs catalog.mjs anchors.mjs comments.mjs events.mjs accounts.mjs history.mjs skills.mjs tokens.mjs index.html; do
  mounts+=(--mount "type=bind,src=$(pwd)/remote-app/$file,dst=/opt/bridge/$file,readonly")
done
mounts+=(--mount "type=bind,src=$(pwd)/remote-app/builtin-skills,dst=/opt/bridge/builtin-skills,readonly")
mounts+=(--mount "type=bind,src=$(pwd)/remote-app/static,dst=/opt/bridge/static,readonly")
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
    throw new Error("Disposable events/accounts fixture did not become healthy");'
}
wait_ready
docker exec --env VE_EVENTS_ACCOUNTS_SMOKE=1 "$name" node scripts/events-accounts-smoke.mjs
docker restart "$name" >/dev/null
wait_ready
docker exec --env VE_EVENTS_ACCOUNTS_SMOKE=1 --env VE_EVENTS_ACCOUNTS_PHASE=persistence "$name" node scripts/events-accounts-smoke.mjs
