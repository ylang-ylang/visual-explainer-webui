#!/usr/bin/env node
// Only check-image.sh's disposable localhost container and real Git remote.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const mode = process.argv[2] ?? '--mutations';
assert.ok(['--mutations', '--persistence', '--projected'].includes(mode) && process.argv.length <= 3);
assert.ok(process.env.VE_HISTORY_FIXTURE && process.env.VE_HISTORY_CONTAINER, 'Use scripts/check-image.sh');
const fixture = resolve(process.env.VE_HISTORY_FIXTURE);
const dataDir = join(fixture, 'data');
const checkpoint = join(fixture, 'scoped-checkpoint.json');
const token = process.env.VE_TOKEN?.trim();
assert.ok(token?.length >= 32);
const secrets = [token];
const base = new URL(process.env.VE_BASE_URL);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && base.protocol === 'http:' &&
  !base.username && !base.password && !base.search && !base.hash && base.pathname === '/',
'VE_BASE_URL must be an isolated HTTP localhost origin');
const a = 'scoped-smoke-a';
const b = 'scoped-smoke-b';
const originalPath = '研究/attention/demo.html';
const movedPath = 'archive/attention/renamed.htm';
const entity = id => `/api/entities/${encodeURIComponent(id)}`;
const file = (id, path) => `${entity(id)}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
const pageRoute = page => `/api/pages/${encodeURIComponent(page.filename)}`;
const sourcePath = path => path.replace(/(\.html?)$/i, '.src$1');
function git(...args) {
  const repository = join(dataDir, '.git');
  return execFileSync('git', ['-c', `safe.directory=${repository}`, `--git-dir=${repository}`, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();
}
const head = () => git('rev-parse', 'refs/heads/main');
const treePaths = revision => git('ls-tree', '-r', '--name-only', '-z', revision).split('\0').filter(Boolean).sort();
function blob(revision, path) {
  const repository = join(dataDir, '.git');
  return execFileSync('git', ['-c', `safe.directory=${repository}`, `--git-dir=${repository}`, 'show', `${revision}:${path}`], {
    timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  });
}
function container(...args) {
  return execFileSync('docker', ['exec', process.env.VE_HISTORY_CONTAINER, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();
}
function synced() {
  const remote = join(fixture, 'remote', 'repo.git');
  const remoteHead = execFileSync('git', ['-c', `safe.directory=${remote}`, `--git-dir=${remote}`, 'rev-parse', 'main'], {
    encoding: 'utf8', timeout: 30000,
  }).trim();
  assert.equal(remoteHead, head(), 'A successful mutation must publish the real local commit');
}
// Pass raw request paths to node:http: fetch/URL would normalize ../ before the
// server sees it, accidentally turning traversal assertions into ordinary reads.
async function request(path, { method = 'GET', auth = token, cookie, body, raw, headers = {}, status = 200 } = {}) {
  if (/^https?:/.test(path)) {
    const target = new URL(path);
    assert.equal(target.origin, base.origin, 'Never contact a deployed server');
    path = target.pathname + target.search;
  }
  assert.ok(path.startsWith('/') && !path.startsWith('//'));
  const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
  const response = await new Promise((resolveResponse, reject) => {
    const req = httpRequest({
      hostname: base.hostname, port: base.port, path, method,
      headers: {
        Accept: 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload === undefined ? {} : { 'Content-Type': raw === undefined ? 'application/json' : 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload) }),
        ...headers,
      },
      signal: AbortSignal.timeout(180000),
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
  const text = response.bytes.toString('utf8');
  assert.ok([status].flat().includes(response.status), `${method} ${path}: expected ${status}, got ${response.status}: ${text.slice(0, 500)}`);
  const data = response.headers['content-type']?.includes('application/json') && text ? JSON.parse(text) : undefined;
  if (response.status >= 400 && (path.startsWith('/api/') || path === '/mcp')) {
    assert.ok(typeof data?.error === 'string' && data.error.length > 0, 'API failures must return JSON errors');
  }
  return { ...response, text, data };
}
const api = async (path, options) => (await request(path, options)).data;
const tree = async (id, auth = token) => (await api(`${entity(id)}/tree`, { auth }));
function document(marker, kit = false) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${marker}</title>${kit ? '<link rel="stylesheet" href="kit.css" data-ve-kit>' : ''}</head>\n<body><main><h1>${marker}</h1><p>精确源码 — café</p></main><!-- exact source: ${marker} -->\n</body></html>\n`;
}
async function put(id, path, html, auth, status = 201) {
  const result = await api(file(id, path), { method: 'PUT', raw: html, auth, status });
  assert.equal(result.page.path, path);
  assert.equal(result.page.entityId, id);
  assert.match(result.revision, /^[0-9a-f]{40}$/);
  assert.equal(result.revision, head());
  assert.equal((await request(file(id, path), { auth })).text, html, 'Raw GET must return exact source, including final newline');
  assert.deepEqual(blob(head(), `${id}/${sourcePath(path)}`), Buffer.from(html), 'Source and compiled bytes must share a real Git snapshot');
  assert.deepEqual(blob(head(), `${id}/${path}`), await readFile(join(dataDir, result.page.filename)));
  synced();
  return result;
}
async function createToken(id, name) {
  const result = await api(`${entity(id)}/tokens`, { method: 'POST', status: 201, body: { name } });
  assert.equal(result.token.name, name ?? `API ${result.token.id.slice(0, 8)}`);
  assert.ok(typeof result.token.id === 'string' && result.token.id.length > 0);
  assert.equal(new Date(result.token.createdAt).toISOString(), result.token.createdAt);
  assert.ok(typeof result.secret === 'string' && result.secret.length >= 32, 'Agent secrets must have high entropy');
  assert.ok(!secrets.includes(result.secret), 'Independently issued secrets must differ');
  secrets.push(result.secret);
  assert.deepEqual((await api('/api/session', { auth: result.secret })), { role: 'agent', entityId: id });
  return result;
}
function checkTree(value) {
  const folders = value.folders.map(folder => folder.path);
  assert.equal(new Set(folders).size, folders.length);
  assert.ok(value.pages.every(page => typeof page.path === 'string'));
  return folders;
}
async function unchanged(label, action, rendered = false) {
  const before = head();
  const beforeTree = await tree(a);
  await action();
  assert.equal(head(), before, `${label} must not create a commit`);
  const afterTree = await tree(a);
  // The official renderer rewrites equal output; only moves promise stable mtimes.
  if (rendered) for (const value of [beforeTree, afterTree]) for (const page of value.pages) delete page.modified;
  assert.deepEqual(afterTree, beforeTree, `${label} must not partially change logical locations`);
}
async function authChecks() {
  await request('/api/session', { auth: null, status: 401 });
  assert.deepEqual(await api('/api/session'), { role: 'admin' });
  const login = await request('/api/login', {
    method: 'POST', auth: null, raw: new URLSearchParams({ key: token }).toString(),
    headers: { Origin: base.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const cookies = login.headers['set-cookie'] ?? [];
  const admin = cookies.find(value => value.startsWith('ve_admin='));
  assert.ok(admin, 'Service login must set an admin cookie');
  assert.match(admin, /HttpOnly/i);
  assert.match(admin, /SameSite=Strict/i);
  const cookie = admin.split(';')[0];
  assert.deepEqual(await api('/api/session', { auth: null, cookie }), { role: 'admin' });
  const path = `${entity(a)}/folders`;
  await request(path, { method: 'POST', auth: null, cookie, body: { path: 'cookie-no-origin' }, status: 403 });
  await request(path, { method: 'POST', auth: null, cookie, headers: { Origin: 'https://invalid.example' }, body: { path: 'cookie-cross-origin' }, status: 403 });
  await request(path, { method: 'POST', headers: { Origin: 'https://invalid.example' }, body: { path: 'bearer-cross-origin' }, status: 403 });
  await request(path, { method: 'POST', auth: null, cookie, headers: { Origin: base.origin }, body: { path: 'cookie-created' }, status: 201 });
  await request(path + '?path=cookie-created', { method: 'DELETE', auth: null, cookie, headers: { Origin: base.origin }, status: 204 });
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const legacySignature = createHmac('sha256', token).update(`viewer-session:${expires}`).digest('hex');
  const legacyCookie = `ve_viewer=${expires}.${legacySignature}`;
  const migrated = await request('/api/session', { auth: null, cookie: legacyCookie });
  assert.deepEqual(migrated.data, { role: 'admin' });
  assert.ok(migrated.headers['set-cookie'].some(value => value.startsWith('ve_admin=') && !value.includes('Max-Age=0')));
  assert.ok(migrated.headers['set-cookie'].some(value => value.startsWith('ve_viewer=') && value.includes('Max-Age=0')));
  await request(path, { method: 'POST', auth: null, cookie: legacyCookie, body: { path: 'legacy-no-origin' }, status: 403 });
  await request(path, { method: 'POST', auth: null, cookie: legacyCookie, headers: { Origin: base.origin }, body: { path: 'legacy-session-write' }, status: 201 });
  await request(path + '?path=legacy-session-write', { method: 'DELETE', auth: null, cookie: legacyCookie, headers: { Origin: base.origin }, status: 204 });
  const viewerKey = createHmac('sha256', token).update('viewer-access').digest('hex');
  secrets.push(viewerKey);
  const viewerAccess = await request(`/?access=${viewerKey}`, { auth: null, status: 303 });
  const viewerCookie = viewerAccess.headers['set-cookie'].find(value => value.startsWith('ve_reader=')).split(';')[0];
  assert.deepEqual(await api('/api/session', { auth: null, cookie: viewerCookie }), { role: 'viewer' });
  await request('/api/session', { auth: null, cookie: viewerCookie.replace('ve_reader=', 've_viewer='), status: 401 });
  const ownerAccess = await request(`/?access=${viewerKey}`, { auth: null, cookie, status: 303 });
  const ownerCookie = ownerAccess.headers['set-cookie'].find(value => value.startsWith('ve_admin=')).split(';')[0];
  assert.deepEqual(await api('/api/session', { auth: null, cookie: ownerCookie }), { role: 'admin' }, 'Opening a share link must not downgrade a logged-in owner');
  const loggedOut = await request('/api/logout', { method: 'POST', auth: null, cookie: `${cookie}; ${viewerCookie}`, headers: { Origin: base.origin } });
  for (const name of ['ve_admin', 've_reader', 've_viewer']) assert.ok(loggedOut.headers['set-cookie'].some(value => value.startsWith(`${name}=`) && /Max-Age=0/i.test(value)), 'Logout must expire current and legacy cookies');
  return { cookie, viewerCookie };
}
async function denials(agent, foreign, foreignPage) {
  for (const [path, method, body, raw] of [
    ['/api/pages', 'GET'], ['/api/entities', 'GET'],
    ['/api/entities', 'POST', { id: 'forbidden-space', name: 'Forbidden' }],
    [entity(a), 'PATCH', { name: 'Forbidden' }], [entity(a), 'DELETE'],
    [`${entity(a)}/tokens`, 'GET'], [`${entity(a)}/tokens`, 'POST', { name: 'Forbidden' }],
    [`${entity(a)}/tokens/${agent.token.id}`, 'DELETE'],
    ['/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    [`${entity(b)}/tree`, 'GET'],
    [`${entity(b)}/folders`, 'POST', { path: 'forbidden' }],
    [`${entity(b)}/folders`, 'PATCH', { path: '研究', newPath: 'stolen' }],
    [`${entity(b)}/folders?path=${encodeURIComponent('研究')}`, 'DELETE'],
    [file(b, originalPath), 'GET'], [file(b, originalPath), 'PUT', undefined, document('FORBIDDEN')],
    [file(b, originalPath), 'PATCH', { path: 'stolen.html' }],
    [pageRoute(foreignPage), 'GET'],
    [pageRoute(foreignPage), 'PATCH', { entityId: a }],
    [pageRoute(foreignPage), 'PUT', { html: document('FORBIDDEN') }],
    [`${pageRoute(foreignPage)}/versions`, 'GET'],
    [`${pageRoute(foreignPage)}/versions/${head()}`, 'GET'],
    [`${pageRoute(foreignPage)}/restore`, 'POST', { revision: head() }],
  ]) {
    await request(path, { method, body, raw, auth: agent.secret, status: [403, 404] });
  }
  assert.equal((await api('/api/session', { auth: foreign.secret })).entityId, b);
}
async function versions(page, auth = token) {
  const result = await api(`${pageRoute(page)}/versions`, { auth });
  assert.ok(Array.isArray(result.versions) && result.versions.length > 0);
  let previous = Infinity;
  for (const version of result.versions) {
    assert.match(version.revision, /^[0-9a-f]{40}$/);
    assert.ok(Number.isFinite(Date.parse(version.createdAt)));
    assert.ok(Date.parse(version.createdAt) <= previous, 'Newest revisions must be first');
    previous = Date.parse(version.createdAt);
    assert.equal(typeof version.message, 'string');
    assert.equal(typeof version.path, 'string');
    assert.equal(typeof version.sourceAvailable, 'boolean');
    git('merge-base', '--is-ancestor', version.revision, head());
  }
  return result.versions;
}
async function versionPreview(page, version, expectedSource, marker, auth = token) {
  const result = await api(`${pageRoute(page)}/versions/${version.revision}`, { auth });
  assert.deepEqual(result.version, version);
  assert.equal(result.html, expectedSource, 'Historical editor reads exact source, not the compiled projection');
  assert.equal(version.sourceAvailable, true);
  const preview = await request(version.url, { auth: null });
  assert.match(preview.headers['content-type'], /^text\/html/);
  assert.match(preview.headers['content-security-policy'], /sandbox allow-scripts/);
  assert.ok(!preview.headers['content-security-policy'].includes('allow-same-origin'), 'Historical iframe must remain opaque');
  assert.ok(preview.text.includes(marker));
  assert.notEqual(version.url, page.url, 'Historical URLs must be independent revision capabilities');
  return preview.text;
}
async function secretAudit(issued) {
  const registry = container('cat', '/data/.tokens.json');
  assert.doesNotThrow(() => JSON.parse(registry));
  assert.equal(container('stat', '-c', '%a', '/data/.tokens.json'), '600', 'Hash registry must be private');
  for (const secret of issued) assert.ok(!registry.includes(secret), 'Registry must contain hashes, never raw agent secrets');
  const publicValues = [await api('/api/pages'), await api('/api/entities')];
  for (const id of [a, b]) publicValues.push(await tree(id), await api(`${entity(id)}/tokens`));
  const encoded = JSON.stringify(publicValues);
  for (const secret of issued) assert.ok(!encoded.includes(secret), 'List/tree/meta endpoints must not disclose secrets');
  const logs = spawnSync('docker', ['logs', process.env.VE_HISTORY_CONTAINER], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(logs.status, 0, 'Container logs must be readable for the secret audit');
  for (const secret of issued) assert.ok(!(logs.stdout + logs.stderr).includes(secret), 'Service logs must not expose agent secrets');
  const objects = new Set();
  for (const revision of git('rev-list', 'main').split('\n')) {
    for (const entry of git('ls-tree', '-r', '-z', revision).split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/.exec(entry);
      assert.ok(match, 'Git must never capture symlinks');
      const [, , oid, path] = match;
      assert.ok(!/(?:^|\/)(?:\.tokens\.json|scoped-checkpoint\.json|token-canary\.txt|private-key-canary|screenshot-canary\.png|staged-canary\.txt)$/.test(path), 'Private fixture files must never enter Git');
      if (objects.has(oid)) continue;
      objects.add(oid);
      const contents = git('cat-file', 'blob', oid);
      for (const secret of [token, ...issued]) assert.ok(!contents.includes(secret), 'Git blobs must never contain API secrets');
    }
  }
}
async function pathIsolation(agent, stable) {
  for (const path of ['../escape.html', 'a//b.html', '/absolute.html', 'a/./b.html', 'a\\b.html',
    '.git/config.html', '.hidden/a.html', ' leading/a.html', 'trailing /a.html', 'a.src.html', 'a/\u0001.html']) {
    await unchanged(`Invalid logical path ${JSON.stringify(path)}`, () => request(`${entity(a)}/folders`, {
      method: 'POST', body: { path }, auth: agent.secret, status: 400,
    }));
  }
  for (const suffix of ['../escape.html', '%2e%2e/escape.html', 'x%2fy.html', 'x%2Fy.html', 'x%5cy.html', '.git/config.html', 'a//b.html']) {
    await unchanged(`Raw encoded path ${suffix}`, () => request(`${entity(a)}/files/${suffix}`, {
      method: 'PUT', raw: document('TRAVERSAL_FORBIDDEN'), auth: agent.secret,
      status: suffix.startsWith('../') || suffix.startsWith('%2e') ? [400, 404] : 400,
    }));
  }
  await request(file(a, 'wrong-type.html'), { method: 'PUT', raw: document('WRONG_TYPE'), auth: agent.secret,
    headers: { 'Content-Type': 'application/json' }, status: 415 });
  // The shell seeded secret.html as a symlink to the real service credential.
  await request('/api/pages/secret.html', { status: [400, 404] });
  const signature = createHmac('sha256', token).update('page:secret.html').digest('hex');
  await request(`/pages/${signature}/secret.html`, { auth: null, status: [400, 404] });
  // Exercise source-companion and compiled-file symlinks on a real owned page.
  const saved = await readFile(join(dataDir, stable.filename));
  const companion = sourcePath(stable.filename);
  const savedSource = await readFile(join(dataDir, companion));
  for (const target of [companion, stable.filename]) {
    container('mv', `/data/${target}`, `/data/${target}.fixture-backup`);
    container('ln', '-s', '/run/secrets/api_token', `/data/${target}`);
    try {
      const read = await request(file(a, stable.path), { auth: agent.secret,
        status: target === companion ? [200, 400, 404, 409] : [400, 404, 409] });
      assert.ok(!read.text.includes(token), 'Symlink sources must never disclose their target');
      await request(file(a, stable.path), { method: 'PUT', raw: document('SYMLINK_FORBIDDEN'), auth: agent.secret, status: [400, 404, 409] });
      assert.equal(container('cat', '/run/secrets/api_token'), token, 'A symlink must never overwrite the service secret');
      await request(stable.url, { auth: null, status: target === stable.filename ? [400, 404] : 200 });
    } finally {
      container('rm', `/data/${target}`);
      container('mv', `/data/${target}.fixture-backup`, `/data/${target}`);
    }
  }
  assert.deepEqual(await readFile(join(dataDir, stable.filename)), saved);
  assert.deepEqual(await readFile(join(dataDir, companion)), savedSource);
}
async function mutations() {
  for (const id of [a, b]) await api('/api/entities', { method: 'POST', status: 201, body: { id, name: id } });
  const { cookie, viewerCookie } = await authChecks();
  const agent = await createToken(a);
  const foreign = await createToken(b, 'Scoped editor B');
  const revoked = await createToken(a, 'Revoked editor');
  const beforeTokens = head();
  const listed = (await api(`${entity(a)}/tokens`)).tokens;
  assert.deepEqual([...listed].sort((left, right) => left.id.localeCompare(right.id)),
    [agent.token, revoked.token].sort((left, right) => left.id.localeCompare(right.id)));
  assert.ok(listed.every(value => !('secret' in value) && !('hash' in value)), 'Lists expose metadata only');
  assert.equal(head(), beforeTokens, 'Token listing must not create history');
  await request(`${entity(a)}/tokens/${revoked.token.id}`, { method: 'DELETE', status: 204 });
  await request('/api/session', { auth: revoked.secret, status: 401 });
  const removedId = 'scoped-deleted-space';
  await api('/api/entities', { method: 'POST', status: 201, body: { id: removedId, name: 'Deleted key owner' } });
  const removed = await createToken(removedId, 'Deleted with owner');
  await request(entity(removedId), { method: 'DELETE', status: 204 });
  await request('/api/session', { auth: removed.secret, status: 401 });

  const v1 = document('SCOPED_A_V1', true);
  const v2 = document('SCOPED_A_V2', true);
  const otherSource = document('SCOPED_B_INDEPENDENT');
  const first = await put(a, originalPath, v1, agent.secret);
  const other = await put(b, originalPath, otherSource, foreign.secret);
  assert.notEqual(first.page.filename, other.page.filename, 'Same logical paths in separate spaces need distinct immutable identities');
  assert.notEqual(first.page.url, other.page.url);
  const compiledV1 = (await request(first.page.url, { auth: null })).text;
  assert.ok(compiledV1.includes('SCOPED_A_V1'));
  assert.notEqual(compiledV1, v1, 'Entity PUT must use the official compiler rather than publish the source directly');
  const folders = checkTree(await tree(a, agent.secret));
  assert.ok(folders.includes('研究') && folders.includes('研究/attention'), 'PUT creates every implicit parent');
  assert.deepEqual(await tree(a, agent.secret), await tree(a, agent.secret), 'Tree reads are deterministic');
  const raw = await request(file(a, originalPath), { auth: agent.secret });
  assert.match(raw.headers['content-type'], /^text\/(?:html|plain)/);
  assert.ok(raw.headers['content-disposition']?.startsWith('attachment') ||
    (raw.headers['content-security-policy']?.includes('sandbox') && !raw.headers['content-security-policy'].includes('allow-scripts')),
  'Source GET must be inert/download-only');
  await denials(agent, foreign, other.page);
  await unchanged('Cross-space assignment collision', () => api(pageRoute(other.page), {
    method: 'PATCH', body: { entityId: a }, status: 409,
  }));
  await put(a, 'collision.html', document('SCOPED_COLLISION'), agent.secret);
  await unchanged('File move collision', () => api(file(a, originalPath), {
    method: 'PATCH', body: { path: 'collision.html' }, status: 409, auth: agent.secret,
  }));
  await request(`${pageRoute(first.page)}/restore`, { method: 'POST', auth: null, cookie: viewerCookie,
    headers: { Origin: base.origin }, body: { revision: first.revision }, status: 401 });
  assert.deepEqual((await api(`${pageRoute(first.page)}/versions`, { auth: null, cookie: viewerCookie })).versions,
    await versions(first.page), 'Viewer can inspect real versions');

  await request(`${entity(a)}/folders`, { method: 'POST', status: 201, auth: agent.secret, body: { path: 'draft/empty/deep' } });
  assert.equal(blob(head(), `${a}/draft/empty/deep/.gitkeep`).length, 0, 'Empty nested folders must materialize in Git');
  await unchanged('Duplicate folder', () => request(`${entity(a)}/folders`, { method: 'POST', status: 409, auth: agent.secret, body: { path: 'draft/empty/deep' } }));
  await request(`${entity(a)}/folders?path=draft`, { method: 'DELETE', auth: agent.secret, status: 409 });
  await request(`${entity(a)}/folders?path=${encodeURIComponent('draft/empty/deep')}`, { method: 'DELETE', auth: agent.secret, status: 204 });
  assert.ok((await tree(a)).folders.some(folder => folder.path === 'draft/empty'), 'Deleting an empty child preserves its parent');
  assert.equal(blob(head(), `${a}/draft/empty/.gitkeep`).length, 0);
  await request(`${entity(a)}/folders`, { method: 'POST', status: 201, body: { path: 'destination' } });
  await unchanged('Folder collision', () => request(`${entity(a)}/folders`, { method: 'PATCH', status: 409, body: { path: '研究', newPath: 'destination' } }));
  await unchanged('Descendant folder move', () => request(`${entity(a)}/folders`, { method: 'PATCH', status: [400, 409], body: { path: '研究', newPath: '研究/attention/child' } }));
  await unchanged('File cannot be parent', () => request(file(a, originalPath + '/child.html'), { method: 'PUT', raw: document('COLLISION'), status: 409 }));
  await unchanged('File cannot be folder', () => request(`${entity(a)}/folders`, { method: 'POST', body: { path: originalPath }, status: 409 }));
  await request(`${entity(a)}/folders`, { method: 'POST', status: 201, auth: agent.secret,
    body: { path: '研究/empty/deep' } });

  const beforeMove = await stat(join(dataDir, first.page.filename), { bigint: true });
  const moveHead = head();
  await api(`${entity(a)}/folders`, { method: 'PATCH', auth: agent.secret, body: { path: '研究', newPath: 'archive' } });
  const afterFolder = (await tree(a)).pages.find(page => page.filename === first.page.filename);
  assert.equal(afterFolder.path, 'archive/attention/demo.html');
  assert.equal(afterFolder.url, first.page.url);
  assert.equal(afterFolder.modified, first.page.modified);
  assert.equal((await stat(join(dataDir, first.page.filename), { bigint: true })).mtimeNs, beforeMove.mtimeNs);
  assert.equal((await request(first.page.url, { auth: null })).text, compiledV1, 'Folder move never changes legacy signed content');
  assert.deepEqual(blob(head(), `${a}/archive/attention/demo.html`), blob(moveHead, `${a}/${originalPath}`));
  assert.deepEqual(blob(head(), `${a}/archive/attention/demo.src.html`), Buffer.from(v1));
  const movedFolders = (await tree(a)).folders.map(folder => folder.path);
  assert.ok(movedFolders.includes('archive/empty/deep') && !movedFolders.some(path => path === '研究' || path.startsWith('研究/')),
    'Recursive folder move includes explicit empty descendants');
  assert.equal(blob(head(), `${a}/archive/empty/deep/.gitkeep`).length, 0);
  const afterFile = (await api(file(a, afterFolder.path), { method: 'PATCH', auth: agent.secret, body: { path: movedPath } })).page;
  assert.equal(afterFile.filename, first.page.filename);
  assert.equal(afterFile.url, first.page.url);
  assert.equal(afterFile.modified, first.page.modified);
  await unchanged('Exact file move no-op', () => api(file(a, movedPath), { method: 'PATCH', auth: agent.secret, body: { path: movedPath } }));
  await unchanged('Exact folder move no-op', () => api(`${entity(a)}/folders`, { method: 'PATCH', auth: agent.secret, body: { path: 'archive', newPath: 'archive' } }));
  await request(file(a, originalPath), { auth: agent.secret, status: 404 });
  assert.equal((await request(file(b, originalPath), { auth: foreign.secret })).text, otherSource);
  await unchanged('Legacy PUT preserves moved logical path', async () => {
    const result = await api(pageRoute(first.page), { method: 'PUT', body: { html: v1 } });
    assert.equal(result.page.path, movedPath);
    assert.equal(result.page.entityId, a);
    assert.equal(result.page.url, first.page.url);
  }, true);
  await unchanged('Legacy MCP preserves moved logical path', async () => {
    const result = await api('/mcp', { method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
      body: { jsonrpc: '2.0', id: 41, method: 'tools/call', params: {
        name: 'visual_explainer_render_html', arguments: { filename: first.page.filename, html: v1 },
      } },
    });
    assert.equal(result.error, undefined);
    assert.ok(!result.result.isError);
    assert.equal((await api(pageRoute(first.page))).page.path, movedPath);
  }, true);

  const beforeUpdate = await versions(first.page, agent.secret);
  assert.ok(beforeUpdate.every(version => version.entityId === a && version.revision !== other.revision),
    'Same logical names in another space must never become this page history');
  const originalVersion = beforeUpdate.find(version => version.revision === first.revision);
  assert.ok(originalVersion, 'The upload version remains accessible after both folder and file moves');
  assert.equal(originalVersion.path, originalPath);
  assert.equal(originalVersion.entityId, a);
  assert.equal(await versionPreview(first.page, originalVersion, v1, 'SCOPED_A_V1', agent.secret), compiledV1);
  const second = await put(a, movedPath, v2, agent.secret, 200);
  assert.equal(second.page.filename, first.page.filename);
  assert.equal(second.page.url, first.page.url);
  const currentV2 = (await request(first.page.url, { auth: null })).text;
  assert.ok(currentV2.includes('SCOPED_A_V2'));
  assert.equal((await request(originalVersion.url, { auth: null })).text, compiledV1, 'Revision iframe URL must not follow current content');
  const tampered = new URL(originalVersion.url);
  tampered.pathname = tampered.pathname.replace(first.revision, second.revision);
  assert.notEqual(tampered.pathname, new URL(originalVersion.url).pathname, 'Version URLs must identify their revision');
  await request(tampered.href, { auth: null, status: [403, 404] });
  for (const revision of ['HEAD', first.revision.slice(0, 8), '0'.repeat(40), `${first.revision}~1`]) {
    await request(`${pageRoute(first.page)}/versions/${encodeURIComponent(revision)}`, { auth: agent.secret, status: [400, 404] });
  }
  const unrelated = await api('/api/entities', { method: 'POST', status: 201, body: { id: 'scoped-unrelated', name: 'Unrelated revision' } });
  assert.ok(unrelated.entity);
  await request(`${pageRoute(first.page)}/versions/${head()}`, { auth: agent.secret, status: 404 });
  const historyBeforeRestore = git('rev-list', 'main').split('\n');
  const restored = await api(`${pageRoute(first.page)}/restore`, { method: 'POST', auth: null, cookie,
    headers: { Origin: base.origin }, body: { revision: first.revision } });
  assert.equal(restored.page.filename, first.page.filename);
  assert.equal(restored.page.path, movedPath);
  assert.equal(restored.page.entityId, a);
  assert.equal(restored.page.url, first.page.url);
  assert.equal(restored.revision, head());
  assert.notEqual(restored.revision, second.revision);
  assert.deepEqual(git('rev-list', 'main').split('\n').slice(1), historyBeforeRestore, 'Restore appends one real commit, never rewrites prior history');
  assert.equal((await request(file(a, movedPath), { auth: agent.secret })).text, v1);
  assert.ok((await request(first.page.url, { auth: null })).text.includes('SCOPED_A_V1'));
  const v2Version = (await versions(first.page, agent.secret)).find(version => version.revision === second.revision);
  assert.ok(v2Version);
  await versionPreview(first.page, v2Version, v2, 'SCOPED_A_V2', agent.secret);
  await unchanged('Identical scoped source', () => put(a, movedPath, v1, agent.secret, 200), true);
  await unchanged('Identical restore', () => api(`${pageRoute(first.page)}/restore`, { method: 'POST', auth: agent.secret, body: { revision: first.revision } }), true);

  // Ownership must be checked at both ends of a version lookup, not just now.
  await api(pageRoute(first.page), { method: 'PATCH', body: { entityId: b } });
  await request(`${pageRoute(first.page)}/versions/${first.revision}`, { auth: agent.secret, status: [403, 404] });
  await request(`${pageRoute(first.page)}/versions/${first.revision}`, { auth: foreign.secret, status: [403, 404] });
  await request(`${pageRoute(first.page)}/restore`, { method: 'POST', auth: foreign.secret, body: { revision: first.revision }, status: [403, 404] });
  assert.ok((await versions(first.page, foreign.secret)).every(version => version.entityId === b), 'Agent lists must not reveal another space history');
  await api(pageRoute(first.page), { method: 'PATCH', body: { entityId: a } });
  const finalPage = (await api(pageRoute(first.page))).page;
  await pathIsolation(agent, finalPage);
  const issued = [agent.secret, foreign.secret, revoked.secret, removed.secret];
  await secretAudit(issued);
  synced();
  await writeFile(checkpoint, JSON.stringify({
    head: head(), agent, foreign, revoked, removed, issued, page: finalPage,
    source: v1, other: other.page, otherSource, originalVersion,
    versions: await versions(first.page),
  }), { mode: 0o600 });
  console.log('PASS scoped trees, exact source/compiler, stable IDs, folders/moves/collisions, admin Origin, token isolation, versions/restore and path/symlink isolation');
}
async function persistence() {
  assert.equal((await stat(checkpoint)).mode & 0o777, 0o600, 'Fixture secrets remain private outside the Git data directory');
  const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
  secrets.push(...saved.issued);
  assert.equal(head(), saved.head, 'Restart must not add unchanged history');
  assert.deepEqual(await api('/api/session', { auth: saved.agent.secret }), { role: 'agent', entityId: a });
  assert.deepEqual(await api('/api/session', { auth: saved.foreign.secret }), { role: 'agent', entityId: b });
  for (const secret of [saved.revoked.secret, saved.removed.secret]) await request('/api/session', { auth: secret, status: 401 });
  assert.deepEqual((await api(`${entity(a)}/tokens`)).tokens, [saved.agent.token]);
  assert.equal((await request(file(a, saved.page.path), { auth: saved.agent.secret })).text, saved.source);
  assert.equal((await request(file(b, originalPath), { auth: saved.foreign.secret })).text, saved.otherSource);
  assert.deepEqual((await api(pageRoute(saved.page))).page, saved.page);
  assert.deepEqual(await versions(saved.page), saved.versions);
  assert.ok((await request(saved.originalVersion.url, { auth: null })).text.includes('SCOPED_A_V1'));
  await secretAudit(saved.issued);
  synced();
  console.log('PASS restart preserves scoped paths, exact sources, token hashes/revocations, signed revision URLs and real history');
}
async function projectedMigration() {
  const { legacy } = JSON.parse(await readFile(join(fixture, 'legacy-checkpoint.json'), 'utf8'));
  const catalog = JSON.parse(container('cat', '/data/.entities.json'));
  assert.equal(catalog.version, 2);
  git('merge-base', '--is-ancestor', legacy, head());
  assert.equal(git('rev-parse', '--is-bare-repository'), 'true');
  const value = await tree('migration-space');
  assert.equal(value.pages.length, 1);
  const page = value.pages[0];
  assert.equal(page.filename, 'legacy.html');
  assert.equal(page.path, 'legacy.html');
  assert.equal(page.entityId, 'migration-space');
  const signature = createHmac('sha256', token).update('page:legacy.html').digest('hex');
  assert.equal(page.url, new URL(`/pages/${signature}/legacy.html`, base).href);
  const original = await readFile(join(dataDir, 'legacy.html'));
  assert.deepEqual((await request(page.url, { auth: null })).bytes, original, 'Existing signed current URL must preserve original bytes');
  assert.deepEqual(blob(head(), 'migration-space/legacy.html'), blob(legacy, 'migration-space/legacy.html'));
  const old = (await versions(page)).find(version => version.revision === legacy);
  assert.ok(old, 'Existing v1 projected history remains browseable');
  assert.equal((await api(`${pageRoute(page)}/versions/${legacy}`)).html, original.toString('utf8'));
  const before = head();
  await api(`${entity('migration-space')}/folders`, { method: 'POST', status: 201, body: { path: 'migrated/empty' } });
  assert.equal(git('rev-parse', `${head()}^`), before);
  assert.equal(blob(head(), 'migration-space/migrated/empty/.gitkeep').length, 0);
  assert.deepEqual((await request(page.url, { auth: null })).bytes, original);
  synced();
  console.log('PASS existing projected bare Git v1 migration, reachable old version, empty nested directory and unchanged old signed URL');
}
try {
  if (mode === '--persistence') await persistence();
  else if (mode === '--projected') await projectedMigration();
  else await mutations();
} catch (error) {
  let message = error?.stack ?? String(error);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}
