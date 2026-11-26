// Diagram deletion regression: disposable localhost fixture ONLY, including real Chromium menus.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

assert.equal(process.env.VE_DELETE_SMOKE, '1', 'Never run against a real library');
const base = new URL(process.env.PUBLIC_URL);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const dir = process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data';
const token = (await readFile(process.env.TOKEN_FILE ?? '/run/secrets/api_token', 'utf8')).trim();
const checkpoint = join(dir, '.delete-checkpoint.json');
const git = (...args) => execFileSync('git', [`--git-dir=${join(dir, '.git')}`, ...args], { encoding: 'utf8' }).trimEnd();
const route = name => '/api/pages/' + encodeURIComponent(name);
const fileRoute = (id, path) => `/api/entities/${id}/files/` + path.split('/').map(encodeURIComponent).join('/');
const html = title => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>\n`;
async function request(path, { method = 'GET', body, status = 200, auth = token, cookie, origin } = {}) {
  const response = await fetch(new URL(path, base), { method, headers: {
    ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(cookie ? { Cookie: cookie } : {}),
    ...(origin ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
  return response;
}
const api = async (path, options) => (await request(path, options)).json();
const exists = async name => !!await lstat(join(dir, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const bytes = name => readFile(join(dir, name), 'utf8');
const remove = async (name, status = 204, options = {}) => request(route(name), { method: 'DELETE', status, ...options });

if (process.env.VE_DELETE_PHASE === 'persistence') {
  const saved = JSON.parse(await bytes('.delete-checkpoint.json'));
  for (const item of saved.deleted) {
    await request(route(item.filename), { status: 404 });
    assert.equal((await fetch(item.url)).status, 404);
    assert.equal((await fetch(item.versionUrl)).status, 200, 'Historical signed URLs survive deletion and restart');
    assert.equal(await exists(item.filename), false);
  }
  assert.equal(await bytes(saved.keep.filename), saved.keep.rendered);
  assert.equal(await bytes(saved.keep.source), saved.keep.sourceBytes);
  assert.equal(await bytes('.tokens.json'), saved.tokens);
  const tree = await api('/api/tree');
  assert.ok(tree.folders.some(item => item.entityId === 'delete-child' && item.path === 'nested/empty'));
  assert.ok(tree.entities.some(item => item.id === 'delete-child' && item.parent.entityId === 'delete-parent'));
  assert.equal(git('show', `${saved.initialRevision}:${saved.initialPath}`), saved.initialSource.trimEnd());
  console.log('PASS deletion restart: removed current identities/URLs stay 404; signed versions, exact old Git source, other page/source/folders/anchor/credentials persist');
  process.exit(0);
}

for (const id of ['delete-parent', 'delete-child']) await api('/api/entities', { method: 'POST', body: { id, name: id }, status: 201 });
await api('/api/entities/delete-child/folders', { method: 'POST', body: { path: 'nested/empty' }, status: 201 });
await api('/api/moves', { method: 'POST', body: { source: { kind: 'folder', entityId: 'delete-child', path: '' }, destination: { entityId: 'delete-parent', path: '' } } });
const keep = await api(route('delete-keep.html'), { method: 'PUT', body: { html: html('保留的图解') }, status: 201 });
const root = await api(route('delete-root.html'), { method: 'PUT', body: { html: html('待删除根图解') }, status: 201 });
const nested = await api(route('delete-nested.html'), { method: 'PUT', body: { html: html('待删除嵌套图解'), entityId: 'delete-child' }, status: 201 });
await api(route(nested.page.filename), { method: 'PATCH', body: { entityId: 'delete-child', path: 'nested/目标图解.html' } });
const key = await api('/api/entities/delete-child/tokens', { method: 'POST', body: { name: 'disposable deletion test' }, status: 201 });
const tokenBytes = await bytes('.tokens.json');
const keepSource = await bytes('delete-keep.src.html');
const keepRendered = await bytes('delete-keep.html');
const versions = async page => (await api(route(page.filename) + '/versions')).versions;
const nestedVersion = (await versions(nested.page))[0];
const rootVersion = (await versions(root.page))[0];

// Deny global deletion to viewers/scoped credentials, with exact origin checks unchanged.
const expires = Math.floor(Date.now() / 1000) + 3600;
const cookie = kind => `ve_${kind === 'admin' ? 'admin' : 'reader'}=${expires}.` + createHmac('sha256', token).update(`${kind === 'admin' ? 'admin' : 'reader'}-session:${expires}`).digest('hex');
await remove(root.page.filename, 401, { auth: null });
await remove(root.page.filename, 401, { auth: null, cookie: cookie('viewer'), origin: base.origin });
await remove(root.page.filename, 403, { auth: key.secret });
await request(fileRoute('delete-child', 'nested/目标图解.html'), { method: 'DELETE', auth: key.secret, status: 403 });
await remove(root.page.filename, 403, { origin: 'https://foreign.invalid' });
await remove(root.page.filename, 403, { auth: null, cookie: cookie('admin') });
await remove(root.page.filename, 403, { auth: null, cookie: cookie('admin'), origin: 'https://foreign.invalid' });
for (const [path, status] of [[route('missing-delete.html'), 404], [route('delete-root.src.html'), 400], ['/api/pages/delete-root.html/extra', 404], ['/api/pages/%2e%2e%2fdelete-root.html', 400]]) {
  await request(path, { method: 'DELETE', status });
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base.href);
  await page.locator('#key').fill(token);
  await page.locator('#login-submit').click();
  await page.locator('#login').waitFor({ state: 'hidden' });
  const settled = () => page.waitForFunction(() => !pageRequest && document.documentElement.dataset.sync === 'ready');
  await settled();
  const row = name => page.locator(`.report[data-filename="${name}"]`);
  await row(keep.page.filename).click();
  await page.frameLocator('#preview').getByRole('heading', { name: '保留的图解', exact: true }).waitFor();
  const before = { head: git('rev-parse', 'main'), catalog: await bytes('.entities.json'), names: await readdir(dir), html: await bytes(nested.page.filename) };
  let deletes = 0;
  page.on('request', request => { if (request.method() === 'DELETE') deletes++; });
  async function deletionMenu(name) {
    await row(name).click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem').last().innerText(), 'Delete diagram');
    assert.equal(await page.getByRole('menuitem').last().evaluate(node => node.classList.contains('danger')), true);
    await page.getByRole('menuitem', { name: 'Delete diagram', exact: true }).click();
  }
  await deletionMenu(nested.page.filename);
  assert.equal(await page.evaluate(() => selected.filename), keep.page.filename, 'Right-click never retargets selected preview');
  const detail = await page.locator('#confirm-detail').innerText();
  assert.ok(detail.includes('待删除嵌套图解') && detail.includes('delete-parent / delete-child / nested/目标图解'));
  await page.screenshot({ path: '/tmp/ve-delete-confirm-fixture.png' });
  await page.locator('#confirm-dialog .dialog-actions [data-close]').click();
  assert.equal(deletes, 0);
  assert.equal(git('rev-parse', 'main'), before.head);
  assert.equal(await bytes('.entities.json'), before.catalog);
  assert.deepEqual(await readdir(dir), before.names);
  assert.equal(await bytes(nested.page.filename), before.html);

  // Hold an old refresh response while the clicked (non-selected) diagram is deleted.
  let release, ready;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { ready = resolve; });
  await page.route('**/api/tree', async route => {
    const response = await route.fetch();
    ready();
    await held;
    await route.fulfill({ response }).catch(() => {}); // The deletion intentionally aborts this stale refresh.
  }, { times: 1 });
  await page.evaluate(() => { void loadPages(true); });
  await started;
  await deletionMenu(nested.page.filename);
  await page.locator('#confirm-submit').click();
  release();
  await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
  await settled();
  assert.equal(await row(nested.page.filename).count(), 0);
  assert.equal(await page.evaluate(() => selected.filename), keep.page.filename);
  assert.equal(await page.evaluate(() => decodeURIComponent(location.hash.slice(1))), keep.page.filename);
  await request(fileRoute('delete-parent', 'delete-child/nested/目标图解.html'), { status: 404 });
  await request(fileRoute('delete-child', 'nested/目标图解.html'), { status: 404 });

  // Deleting a selected historical preview replaces its frame/hash/open-link with a surviving diagram.
  await row(root.page.filename).click();
  await row(root.page.filename).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Version history', exact: true }).click();
  await page.locator('.version-row').first().getByRole('button', { name: 'Preview', exact: true }).click();
  await page.locator('#history-banner').waitFor({ state: 'visible' });
  await deletionMenu(root.page.filename);
  await page.locator('#confirm-submit').click();
  await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
  await settled();
  assert.equal(await page.locator('#history-banner').isVisible(), false);
  assert.notEqual(await page.evaluate(() => selected?.filename), root.page.filename);
  assert.notEqual(await page.evaluate(() => decodeURIComponent(location.hash.slice(1))), root.page.filename);
  assert.ok(!(await page.locator('#preview').getAttribute('src') ?? '').includes(root.page.filename));
  assert.notEqual(await page.locator('#open').getAttribute('href'), root.page.url);
  await page.goto(base.href + '#' + root.page.filename);
  await settled();
  assert.notEqual(await page.evaluate(() => decodeURIComponent(location.hash.slice(1))), root.page.filename);
  assert.equal(await row(root.page.filename).count(), 0);
  const viewer = await browser.newContext();
  await viewer.addCookies([{ name: 've_reader', value: cookie('viewer').split('=')[1], url: base.origin }]);
  const reader = await viewer.newPage();
  await reader.goto(base.href);
  await reader.waitForFunction(() => document.documentElement.dataset.sync === 'ready');
  await reader.locator(`.report[data-filename="${keep.page.filename}"]`).click({ button: 'right' });
  assert.equal(await reader.getByRole('menuitem', { name: 'Delete diagram', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await viewer.close();
  await context.close();
} finally { await browser.close(); }

// Legacy source pairing, owned renderer sheets, and unrelated assets.
for (const [name, content] of [
  ['delete-legacy.HTM', html('legacy')], ['delete-legacy.src.HTML', '<!-- alternate source -->\n'], ['delete-legacy.src.htm', '<!-- primary source -->\n'],
  ['delete-legacy.sheet.png', 'owned sheet'], ['delete-legacy.sheet-2.png', 'owned sheet two'], ['delete-legacy.png', 'shared asset'], ['delete-legacy.sheet-backup.png', 'unrelated image'],
  ['delete-pair.html', html('pair html')], ['delete-pair.htm', html('pair htm')], ['delete-pair.src.html', 'html source'], ['delete-pair.src.htm', 'htm source'], ['delete-pair.sheet.png', 'ambiguous sheet'],
  ['delete-[1]+.HTM', html('regex stem')], ['delete-[1]+.sheet.png', 'exact regex sheet'], ['delete-1.sheet.png', 'not owned'],
]) await writeFile(join(dir, name), content);
await api(route('delete-legacy.HTM'), { method: 'PATCH', body: { entityId: 'delete-child', path: 'nested/legacy.htm' } });
const legacyVersion = (await versions({ filename: 'delete-legacy.HTM' }))[0];
assert.equal(await (await request(route('delete-legacy.HTM') + '/versions/' + legacyVersion.revision)).json().then(data => data.html), '<!-- primary source -->\n');
await remove('delete-legacy.HTM');
for (const name of ['delete-legacy.HTM', 'delete-legacy.src.HTML', 'delete-legacy.src.htm', 'delete-legacy.sheet.png', 'delete-legacy.sheet-2.png']) assert.equal(await exists(name), false);
assert.equal(await bytes('delete-legacy.png'), 'shared asset');
assert.equal(await bytes('delete-legacy.sheet-backup.png'), 'unrelated image');
await remove('delete-pair.html', 409);
assert.equal(await exists('delete-pair.src.html'), true);
await rm(join(dir, 'delete-pair.sheet.png'));
await remove('delete-pair.html');
assert.equal(await exists('delete-pair.src.html'), false);
assert.equal(await bytes('delete-pair.htm'), html('pair htm'));
assert.equal(await bytes('delete-pair.src.htm'), 'htm source');
await remove('delete-[1]+.HTM');
assert.equal(await exists('delete-[1]+.sheet.png'), false);
assert.equal(await bytes('delete-1.sheet.png'), 'not owned');

// Symlinks/directories are rejected without removing targets, companions or the page.
await symlink(join(dir, keep.page.filename), join(dir, 'delete-link.html'));
await remove('delete-link.html', 409);
for (const name of ['delete-unsafe.src.HTML', 'delete-unsafe.sheet.png']) {
  await writeFile(join(dir, 'delete-unsafe.HTM'), html('unsafe companion'));
  await symlink(join(dir, keep.page.filename), join(dir, name));
  await remove('delete-unsafe.HTM', 409);
  assert.equal(await bytes('delete-unsafe.HTM'), html('unsafe companion'));
  await rm(join(dir, name));
}
await mkdir(join(dir, 'delete-directory.html'));
await remove('delete-directory.html', 409);
assert.equal(await bytes(keep.page.filename), keepRendered);

// Inject a catalog rename failure after staging: all page/source files must roll back.
const rollback = await api(route('delete-rollback.html'), { method: 'PUT', body: { html: html('rollback') }, status: 201 });
const rollbackSource = await bytes('delete-rollback.src.html');
const rollbackRendered = await bytes('delete-rollback.html');
await rename(join(dir, '.entities.json'), join(dir, '.delete-catalog-backup'));
await mkdir(join(dir, '.entities.json'));
try {
  const failure = await remove(rollback.page.filename, 500);
  assert.match((await failure.json()).error, /original page files were restored/);
  assert.equal(await bytes('delete-rollback.html'), rollbackRendered);
  assert.equal(await bytes('delete-rollback.src.html'), rollbackSource);
} finally {
  await rm(join(dir, '.entities.json'), { recursive: true });
  await rename(join(dir, '.delete-catalog-backup'), join(dir, '.entities.json'));
}
assert.ok(!(await readdir(dir)).some(name => name.startsWith('.delete-') && name !== '.delete-checkpoint.json'));
await remove(rollback.page.filename);

// Existing local-first contract: failed deletion push returns 503, preserving its local commit.
const remote = process.env.GIT_HISTORY_REMOTE;
if (remote?.startsWith('/')) {
  const failure = await api(route('delete-history-failure.html'), { method: 'PUT', body: { html: html('history failure') }, status: 201 });
  const updateHook = join(remote, 'hooks/update');
  assert.equal(!!await lstat(updateHook).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), false, 'Disposable remote must have no existing update hook');
  await writeFile(updateHook, '#!/bin/sh\ncase "$(git show -s --format=%s "$3")" in "Delete page delete-history-failure.html") exit 1;; esac\n', { mode: 0o755 });
  try {
    const failed = await remove(failure.page.filename, 503);
    assert.match((await failed.json()).error, /Diagram deleted, but Git history synchronization failed/);
    assert.equal(git('show', '-s', '--format=%s', 'main'), 'Delete page delete-history-failure.html');
    await request(route(failure.page.filename), { status: 404 });
    assert.equal(git('show', `${failure.revision}:_unassigned/delete-history-failure.src.html`), html('history failure').trimEnd());
  } finally { await rm(updateHook); }
  await api('/api/entities/delete-child/folders', { method: 'POST', body: { path: 'after-failed-push' }, status: 201 });
  assert.equal(execFileSync('git', [`--git-dir=${remote}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), git('rev-parse', 'main'));
}
const deleted = [
  { ...nested.page, versionUrl: nestedVersion.url }, { ...root.page, versionUrl: rootVersion.url },
  { filename: 'delete-legacy.HTM', url: new URL(`/pages/${createHmac('sha256', token).update('page:delete-legacy.HTM').digest('hex')}/delete-legacy.HTM`, base).href, versionUrl: legacyVersion.url },
];
for (const item of deleted) {
  await request(route(item.filename), { status: 404 });
  await request(route(item.filename) + '/versions', { status: 404 });
  assert.equal((await fetch(item.url)).status, 404);
  assert.equal((await fetch(item.url, { method: 'HEAD' })).status, 404);
  assert.equal((await fetch(item.versionUrl)).status, 200);
}
assert.equal(await bytes('.tokens.json'), tokenBytes);
assert.equal(await bytes(keep.page.filename), keepRendered);
assert.equal(await bytes('delete-keep.src.html'), keepSource);
assert.equal((await api('/api/entities/delete-child/tree', { auth: key.secret })).folders.some(item => item.path === 'nested/empty'), true);
assert.equal(git('show', `${nested.revision}:delete-child/delete-nested.src.html`), html('待删除嵌套图解').trimEnd());
assert.equal(git('merge-base', '--is-ancestor', nested.revision, 'main'), '');
await writeFile(checkpoint, JSON.stringify({ deleted, tokens: tokenBytes, keep: { filename: keep.page.filename, rendered: keepRendered, source: 'delete-keep.src.html', sourceBytes: keepSource }, initialRevision: nested.revision, initialPath: 'delete-child/delete-nested.src.html', initialSource: html('待删除嵌套图解') }));
console.log('PASS deletion: real Chromium right-click cancel/no mutation, exact nonselected target and selected historical-preview/hash cleanup; stale refresh abort; root/nested-anchor/legacy companion ownership; owned sheets vs shared assets; symlink/collision/invalid/404/auth/Origin denials; catalog-failure rollback; history push failure surfaced with local commit and subsequent recovery; old bytes and signed historical URLs retained');
