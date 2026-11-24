// Run inside the disposable image; no live server, credential migration or sleeps.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.equal(process.env.VE_TOKEN_EXPIRY_SMOKE, '1', 'Use scripts/check-image.sh');
const { createCatalog } = await import('./catalog.mjs');
const directory = await mkdtemp(join(tmpdir(), 've-expiry-'));
const clockPath = join(directory, 'clock');
const registryPath = join(directory, '.tokens.json');
const admin = (await readFile(process.env.TOKEN_FILE, 'utf8')).trim();
const secrets = [admin];
const now = Date.now();
let server, output = '';
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const base = new URL(`http://127.0.0.1:${port}`);
const route = '/api/entities/expiry-legacy/tokens';
const tree = '/api/entities/expiry-legacy/tree';
const redact = text => secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text);
async function start() {
  // Only this test process overrides the clock, so expiry is checked over real
  // HTTP at the exact boundary without wall-clock waiting or production knobs.
  const program = `import { readFileSync } from 'node:fs';
    Date.now = () => Number(readFileSync(process.env.VE_TEST_CLOCK, 'utf8'));
    await import('./server.mjs');`;
  const env = { ...process.env, PORT: String(port), PUBLIC_URL: base.origin,
    VISUAL_EXPLAINER_OUTPUT_DIR: directory, VE_TEST_CLOCK: clockPath };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_HISTORY_')) delete env[name];
  server = spawn(process.execPath, ['--input-type=module', '-e', program], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Expiry test server did not become ready')), 30000);
    const failed = () => { clearTimeout(timeout); reject(new Error('Expiry test server exited before readiness')); };
    server.once('exit', failed);
    server.once('error', reject);
    server.stderr.on('data', chunk => { output += chunk; });
    server.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('Visual Explainer ready:')) {
        clearTimeout(timeout);
        server.off('exit', failed);
        resolve();
      }
    });
  });
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const stopped = once(server, 'exit');
  server.kill('SIGTERM');
  await stopped;
  server = null;
  output = '';
}
async function request(path, { method = 'GET', auth = admin, body, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), { method, headers: {
    Authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, status, `${method} ${path}: unexpected status`);
  return status === 204 ? null : response.json();
}
async function issue(body) {
  const data = await request(route, { method: 'POST', body, status: 201 });
  secrets.push(data.secret);
  return data;
}
try {
  const catalog = await createCatalog(directory);
  await catalog.create('expiry-legacy', 'Expiry legacy');
  await catalog.create('expiry-other', 'Other scope');
  const old = ['Existing named agent', 'API 12345678'].map(name => {
    const secret = `ve_${randomBytes(32).toString('base64url')}`;
    secrets.push(secret);
    return { secret, entry: { id: randomUUID(), entityId: 'expiry-legacy', name,
      createdAt: new Date(now - 864000000).toISOString(), hash: createHash('sha256').update(secret).digest('hex') } };
  });
  const legacyBytes = JSON.stringify({ version: 1, tokens: old.map(value => value.entry) }) + '\n';
  await writeFile(registryPath, legacyBytes, { mode: 0o600 });
  await writeFile(clockPath, String(now));
  await start();
  assert.equal(await readFile(registryPath, 'utf8'), legacyBytes, 'Startup does not rewrite legacy records');
  for (const value of old) await request(tree, { auth: value.secret });
  const finite = await issue({ expiresIn: 1 });
  assert.equal(finite.token.expiresAt, new Date(now + 1000).toISOString());
  await request(tree, { auth: finite.secret });
  await request('/api/entities/expiry-other/tree', { auth: finite.secret, status: 403 });
  await request(`${route}/${finite.token.id}`, { method: 'PATCH', auth: finite.secret, body: { expiresIn: 7 }, status: 403 });
  for (const expiresIn of [0, -1, 1.5, '86400', true, 2592001]) {
    await request(route, { method: 'POST', body: { expiresIn }, status: 400 });
    await request(`${route}/${finite.token.id}`, { method: 'PATCH', body: { expiresIn }, status: 400 });
  }
  await request(`${route}/${finite.token.id}`, { method: 'PATCH', body: {}, status: 400 });
  const editable = await issue({ expiresIn: 604800 });
  const beforeEdit = JSON.parse(await readFile(registryPath, 'utf8'));
  const edited = await request(`${route}/${editable.token.id}`, { method: 'PATCH', body: { expiresIn: 2592000 } });
  assert.deepEqual(Object.keys(edited), ['token'], 'Expiry edits never recover the secret');
  assert.equal(edited.token.id, editable.token.id);
  assert.equal(edited.token.expiresAt, new Date(now + 2592000000).toISOString());
  const afterEdit = JSON.parse(await readFile(registryPath, 'utf8'));
  assert.equal(afterEdit.tokens.length, beforeEdit.tokens.length, 'Expiry edit must not accumulate keys');
  const { expiresAt: beforeExpiry, ...beforeIdentity } = beforeEdit.tokens.find(entry => entry.id === editable.token.id);
  const { expiresAt: afterExpiry, ...afterIdentity } = afterEdit.tokens.find(entry => entry.id === editable.token.id);
  assert.deepEqual(afterIdentity, beforeIdentity, 'Expiry changes preserve the key hash, ID, name and creation time');
  await request(`${route}/${editable.token.id}`, { method: 'PATCH', body: { expiresIn: null } });
  const defaults = await issue({});
  const named = await issue({ name: 'Legacy API name' });
  for (const value of [defaults, named]) assert.equal(Object.hasOwn(value.token, 'expiresAt'), false);
  const bytesBeforeRestart = await readFile(registryPath, 'utf8');
  assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
  for (const secret of secrets) assert.ok(!bytesBeforeRestart.includes(secret), 'Registry contains only hashes, never raw keys');
  await writeFile(clockPath, String(now + 999));
  await request(tree, { auth: finite.secret });
  await writeFile(clockPath, String(now + 1000));
  await request(tree, { auth: finite.secret, status: 401 });
  await request('/mcp', { method: 'POST', auth: finite.secret, body: {}, status: 401 });
  await request(`${route}/${finite.token.id}`, { method: 'PATCH', body: { expiresIn: 86400 }, status: 409 });
  await stop();
  await start();
  assert.equal(await readFile(registryPath, 'utf8'), bytesBeforeRestart, 'Restart preserves the optional-expiry registry without migration');
  await request(tree, { auth: finite.secret, status: 401 });
  await writeFile(clockPath, String(now + 366 * 86400000));
  for (const value of [...old, defaults, named, editable]) await request(tree, { auth: value.secret });
  const persisted = JSON.parse(await readFile(registryPath, 'utf8'));
  for (const value of old) assert.deepEqual(persisted.tokens.find(entry => entry.id === value.entry.id), value.entry);
  const listed = (await request(route)).tokens;
  assert.ok(listed.every(value => !('secret' in value) && !('hash' in value)), 'Lists remain metadata-only');
  await request(`${route}/${defaults.token.id}`, { method: 'DELETE', status: 204 });
  await request(tree, { auth: defaults.secret, status: 401 });
  for (const value of old) await request(tree, { auth: value.secret });
  console.log('PASS real HTTP expiry at 999/1000ms and after restart, unchanged legacy no-expiry keys, same-hash expiry edits, defaults, validation, scope denial and explicit revoke');
} catch (error) {
  console.error(redact((error.stack ?? String(error)) + '\n' + output));
  process.exitCode = 1;
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
