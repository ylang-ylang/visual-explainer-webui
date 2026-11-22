#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
fixture=$(mktemp -d)
name="ve-wrapper-check-$(node -e 'console.log(require("node:crypto").randomBytes(6).toString("hex"))')"
image="${name}:local"
port="${VE_CHECK_PORT:-8080}"
base_url="http://127.0.0.1:${port}"
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then docker logs "$name" 2>/dev/null || true; fi
  docker rm --force "$name" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$fixture"
  exit "$status"
}
trap cleanup EXIT

mkdir "$fixture/data" "$fixture/remote"
chmod 0777 "$fixture/data" "$fixture/remote"
printf '%s\n' '<!doctype html><html><head><title>Legacy smoke fixture</title></head><body>Legacy smoke fixture</body></html>' > "$fixture/data/legacy.html"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$fixture/token"
chmod 0444 "$fixture/token"
# Canary files and a symlink must never enter the content repository.
cp "$fixture/token" "$fixture/data/token-canary.txt"
printf '%s\n' 'HISTORY_SCREENSHOT_CANARY' > "$fixture/data/screenshot-canary.png"
printf '%s\n' 'HISTORY_PRIVATE_KEY_CANARY' > "$fixture/data/private-key-canary"
printf '%s\n' '<!-- HISTORY_SOURCE_CANARY -->' > "$fixture/data/LEGACY.src.HTM"
mkdir "$fixture/data/nested"
printf '%s\n' '<html>HISTORY_NESTED_CANARY</html>' > "$fixture/data/nested/private.html"
ln -s /run/secrets/api_token "$fixture/data/secret.html"
export VE_HISTORY_FIXTURE="$fixture"
export VE_HISTORY_CONTAINER="$name"
export VE_BASE_URL="$base_url"
VE_TOKEN=$(cat "$fixture/token")
export VE_TOKEN

docker build --build-arg "SOURCE_REVISION=${GITHUB_SHA:-local}" --tag "$image" .
# Match the documented UID 1000 data ownership, including on UID 1001 CI runners.
docker run --rm --user 0 --mount "type=bind,src=$fixture/data,dst=/data" \
  "$image" chown 1000:1000 /data
docker run --rm --mount "type=bind,src=$fixture/remote,dst=/history-remote" \
  "$image" git init --bare --initial-branch=main /history-remote/repo.git >/dev/null
docker run --detach --name "$name" --publish "127.0.0.1:${port}:8080" \
  --env "PUBLIC_URL=$base_url" \
  --env VISUAL_EXPLAINER_OUTPUT_DIR=/data \
  --env TOKEN_FILE=/run/secrets/api_token \
  --env GIT_HISTORY_REMOTE=/history-remote/repo.git \
  --mount "type=bind,src=$fixture/data,dst=/data" \
  --mount "type=bind,src=$fixture/remote,dst=/history-remote" \
  --mount "type=bind,src=$fixture/token,dst=/run/secrets/api_token,readonly" \
  "$image" >/dev/null

wait_ready() {
  node --input-type=module <<'NODE'
import { setTimeout } from 'node:timers/promises';
for (let attempt = 0; attempt < 90; attempt++) {
  try {
    const response = await fetch(process.env.VE_BASE_URL, { signal: AbortSignal.timeout(1000) });
    await response.body?.cancel();
    if (response.status === 200 || response.status === 401) process.exit(0);
  } catch {}
  await setTimeout(1000);
}
throw new Error('Isolated wrapper did not become ready');
NODE
}

wait_ready
node scripts/history-smoke.mjs --initial
node scripts/smoke.mjs
docker restart "$name" >/dev/null
wait_ready
node scripts/smoke.mjs --persistence
node scripts/history-smoke.mjs
docker restart "$name" >/dev/null
wait_ready
node scripts/history-smoke.mjs --persistence
