#!/usr/bin/env node
// Host half of folders-smoke: keep copied credentials in pipes/memory, never logs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.ok(process.env.VE_HISTORY_FIXTURE && process.env.VE_HISTORY_CONTAINER, 'Use scripts/check-image.sh');
const base = new URL(process.env.VE_BASE_URL);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const admin = process.env.VE_TOKEN;
const secrets = [admin];
let directory;
const redact = text => secrets.reduce((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text,
  text.replace(/ve_[A-Za-z0-9_-]{43}/g, '[redacted]'));
try {
  const browser = spawnSync('docker', ['exec', '--interactive', '--env', 'VE_FOLDER_SMOKE=1', '--workdir', '/opt/bridge',
    process.env.VE_HISTORY_CONTAINER, 'node', '--input-type=module'], {
    input: await readFile(new URL('./folders-smoke.mjs', import.meta.url), 'utf8'), encoding: 'utf8', timeout: 240000,
  });
  assert.equal(browser.status, 0, redact(browser.stderr || browser.error?.message || 'Browser regression failed'));
  const { copyPayload, entityId, tokenId, path, legacyTokens } = JSON.parse(browser.stdout);
  const key = copyPayload.match(/Authorization: Bearer (ve_[A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(key, 'Copied command must contain the actual usable key');
  secrets.push(key);
  const url = new URL(`/api/entities/${entityId}/files/${path.split('/').map(encodeURIComponent).join('/')}`, base);
  assert.ok(copyPayload.includes(url.href), 'Copied upload target must match the selected nested folder');
  const syntax = spawnSync('bash', ['--noprofile', '--norc', '-n'], { input: copyPayload, encoding: 'utf8' });
  assert.equal(syntax.status, 0, 'Combined clipboard payload must be valid shell syntax');
  directory = await mkdtemp(join(tmpdir(), 've-copied-curl-'));
  const source = '<!doctype html>\n<html><head><meta charset="utf-8"><title>Clipboard curl</title></head>\n<body><h1>EXACT_CLIPBOARD_CURL</h1><p>精确源码 — café</p></body></html>\n';
  await writeFile(join(directory, 'diagram.html'), source);
  const published = spawnSync('bash', ['--noprofile', '--norc', '-e'], {
    input: copyPayload, encoding: 'utf8', cwd: directory, timeout: 180000, env: { ...process.env, BASH_ENV: '/dev/null' },
  });
  assert.equal(published.status, 0, redact(published.stderr || 'Copied curl failed'));
  const result = JSON.parse(published.stdout);
  assert.equal(result.page.entityId, entityId);
  assert.equal(result.page.path, path);
  const raw = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(raw.status, 200, 'Key remains usable after the browser/panel closes');
  assert.equal(await raw.text(), source, 'The real copied curl must publish exact temporary source bytes');
  const denied = await fetch(new URL('/api/tree', base), { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(denied.status, 403, 'Copied key is scoped, not an administrator credential');
  const route = `/api/entities/${entityId}/tokens`;
  const revoke = await fetch(new URL(`${route}/${tokenId}`, base), { method: 'DELETE', headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(revoke.status, 204, 'Existing explicit revoke endpoint remains usable');
  const revoked = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(revoked.status, 401, 'Explicit revocation denies the copied key');
  const listed = await fetch(new URL(route, base), { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).tokens, legacyTokens, 'Revocation leaves legacy credentials unchanged');
  console.log('PASS real browser auto-key + single clipboard action, shell syntax and exact copied curl publication; same-key validity edits, in-flight/open/close/library-refresh reuse, legacy credentials, revoke, viewer isolation, folder tree/versions/mobile');
} catch (error) {
  console.error(redact(error.stack ?? String(error)));
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
