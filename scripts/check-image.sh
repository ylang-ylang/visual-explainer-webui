#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
node --test scripts/catalog-test.mjs
fixture=$(mktemp -d)
name="ve-wrapper-check-$(node -e 'console.log(require("node:crypto").randomBytes(6).toString("hex"))')"
image="${VE_CHECK_IMAGE:-${name}:local}"
port="${VE_CHECK_PORT:-8080}"
base_url="http://127.0.0.1:${port}"
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then docker logs "$name" 2>/dev/null || true; fi
  docker rm --force "$name" >/dev/null 2>&1 || true
  if docker image inspect "$image" >/dev/null 2>&1; then
    # Container-created Git metadata belongs to UID 1000, not necessarily the runner.
    docker run --rm --user 0 --mount "type=bind,src=$fixture,dst=/fixture" \
      "$image" chown -hR "$(id -u):$(id -g)" /fixture || status=1
  fi
  if [[ -z "${VE_CHECK_IMAGE:-}" ]]; then docker image rm "$image" >/dev/null 2>&1 || true; fi
  rm -rf "$fixture"
  exit "$status"
}
trap cleanup EXIT

mkdir "$fixture/data" "$fixture/remote"
chmod 0777 "$fixture"
chmod 0777 "$fixture/data" "$fixture/remote"
printf '%s\n' '<!doctype html><html><head><title>Legacy smoke fixture</title></head><body>Legacy smoke fixture</body></html>' > "$fixture/data/legacy.html"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$fixture/token"
chmod 0444 "$fixture/token"
# Canary files and a symlink must never enter the content repository.
cp "$fixture/token" "$fixture/data/token-canary.txt"
printf '%s\n' 'HISTORY_SCREENSHOT_CANARY' > "$fixture/data/screenshot-canary.png"
printf '%s\n' 'HISTORY_PRIVATE_KEY_CANARY' > "$fixture/data/private-key-canary"
printf '%s\n' '<!-- HISTORY_SOURCE_CANARY -->' > "$fixture/data/LEGACY.src.HTM"
printf '%s\n' 'HISTORY_INPUT_GITKEEP_CANARY' > "$fixture/data/.gitkeep"
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
docker run --rm --user 0 \
  --mount "type=bind,src=$fixture/data,dst=/data" \
  --mount "type=bind,src=$fixture/remote,dst=/history-remote" \
  "$image" chown -hR 1000:1000 /data /history-remote
# Seed the real normal repository and its unrelated staged index as image UID 1000.
docker run --rm --env VE_HISTORY_FIXTURE=/fixture \
  --mount "type=bind,src=$fixture,dst=/fixture" \
  --mount "type=bind,src=$(pwd)/scripts/seed-history.mjs,dst=/seed-history.mjs,readonly" \
  "$image" node /seed-history.mjs
docker run --detach --name "$name" --publish "127.0.0.1:${port}:${port}" --env "PORT=$port" \
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
    const response = await fetch(new URL('/health', process.env.VE_BASE_URL), { signal: AbortSignal.timeout(1000) });
    if (response.status === 200 && await response.text() === 'ok') process.exit(0);
    await response.body?.cancel();
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
node scripts/scoped-smoke.mjs
docker restart "$name" >/dev/null
wait_ready
node scripts/scoped-smoke.mjs --persistence
docker exec --interactive --env VE_TOKEN_EXPIRY_SMOKE=1 --workdir /opt/bridge \
  "$name" node --input-type=module < scripts/token-expiry-smoke.mjs
node scripts/folders-check.mjs
node scripts/organize-check.mjs

# A second real service starts with no pages or catalog at all.
docker rm --force "$name" >/dev/null
mkdir -p "$fixture/empty/data" "$fixture/empty/remote"
chmod 0777 "$fixture/empty/data" "$fixture/empty/remote"
docker run --rm --mount "type=bind,src=$fixture/empty/remote,dst=/history-remote" \
  "$image" git init --bare --initial-branch=main /history-remote/repo.git >/dev/null
docker run --detach --name "$name" --publish "127.0.0.1:${port}:${port}" --env "PORT=$port" \
  --env "PUBLIC_URL=$base_url" \
  --env VISUAL_EXPLAINER_OUTPUT_DIR=/data \
  --env TOKEN_FILE=/run/secrets/api_token \
  --env GIT_HISTORY_REMOTE=/history-remote/repo.git \
  --mount "type=bind,src=$fixture/empty/data,dst=/data" \
  --mount "type=bind,src=$fixture/empty/remote,dst=/history-remote" \
  --mount "type=bind,src=$fixture/token,dst=/run/secrets/api_token,readonly" \
  "$image" >/dev/null
wait_ready
VE_HISTORY_FIXTURE="$fixture/empty" node scripts/history-smoke.mjs --empty-library

# Existing bare, already-projected v1 history is a distinct migration path.
docker rm --force "$name" >/dev/null
mkdir -p "$fixture/projected/data" "$fixture/projected/remote"
chmod 0777 "$fixture/projected" "$fixture/projected/data" "$fixture/projected/remote"
cp "$fixture/data/legacy.html" "$fixture/projected/data/legacy.html"
docker run --rm --user 0 \
  --mount "type=bind,src=$fixture/projected/data,dst=/data" \
  --mount "type=bind,src=$fixture/projected/remote,dst=/history-remote" \
  "$image" chown -hR 1000:1000 /data /history-remote
docker run --rm --env VE_HISTORY_FIXTURE=/fixture \
  --mount "type=bind,src=$fixture/projected,dst=/fixture" \
  --mount "type=bind,src=$(pwd)/scripts/seed-history.mjs,dst=/seed-history.mjs,readonly" \
  "$image" node /seed-history.mjs --projected
docker run --detach --name "$name" --publish "127.0.0.1:${port}:${port}" --env "PORT=$port" \
  --env "PUBLIC_URL=$base_url" \
  --env VISUAL_EXPLAINER_OUTPUT_DIR=/data \
  --env TOKEN_FILE=/run/secrets/api_token \
  --env GIT_HISTORY_REMOTE=/history-remote/repo.git \
  --mount "type=bind,src=$fixture/projected/data,dst=/data" \
  --mount "type=bind,src=$fixture/projected/remote,dst=/history-remote" \
  --mount "type=bind,src=$fixture/token,dst=/run/secrets/api_token,readonly" \
  "$image" >/dev/null
wait_ready
VE_HISTORY_FIXTURE="$fixture/projected" node scripts/scoped-smoke.mjs --projected
