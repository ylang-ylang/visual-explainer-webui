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

mkdir "$fixture/data"
chmod 0777 "$fixture/data"
printf '%s\n' '<!doctype html><html><head><title>Legacy smoke fixture</title></head><body>Legacy smoke fixture</body></html>' > "$fixture/data/legacy.html"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$fixture/token"
chmod 0444 "$fixture/token"
export VE_BASE_URL="$base_url"
VE_TOKEN=$(cat "$fixture/token")
export VE_TOKEN

docker build --build-arg "SOURCE_REVISION=${GITHUB_SHA:-local}" --tag "$image" .
docker run --detach --name "$name" --publish "127.0.0.1:${port}:8080" \
  --env "PUBLIC_URL=$base_url" \
  --env VISUAL_EXPLAINER_OUTPUT_DIR=/data \
  --env TOKEN_FILE=/run/secrets/api_token \
  --mount "type=bind,src=$fixture/data,dst=/data" \
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
node scripts/smoke.mjs
docker restart "$name" >/dev/null
wait_ready
node scripts/smoke.mjs --persistence
