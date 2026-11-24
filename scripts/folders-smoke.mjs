// Browser half of folders-check.mjs. Its stdout contains a private clipboard
// payload: only run through that host runner, never log this pipe or use a real library.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

assert.equal(process.env.VE_FOLDER_SMOKE, '1', 'Use scripts/check-image.sh');
const base = new URL(process.env.PUBLIC_URL);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const token = (await readFile(process.env.TOKEN_FILE ?? '/run/secrets/api_token', 'utf8')).trim();
const catalogPath = join(process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data', '.entities.json');
const originalCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));

async function api(path, { method = 'GET', body, raw, auth = token, status = 200 } = {}) {
  const target = new URL(path, base);
  assert.equal(target.origin, base.origin, 'Never contact a deployed server');
  const response = await fetch(target, {
    method, headers: { Authorization: `Bearer ${auth}`, ...(raw !== undefined
      ? { 'Content-Type': 'text/html; charset=utf-8' } : body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
  if (status === 204) return null;
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response.text();
}
const initial = await api('/api/tree');
const legacy = await api('/api/entities');
assert.deepEqual(initial.entities, legacy.entities);
assert.deepEqual(initial.pages, (await api('/api/pages')).pages);
assert.equal(initial.totalCount, legacy.totalCount);
for (const entity of initial.entities) {
  const tree = await api(`/api/entities/${entity.id}/tree`);
  assert.deepEqual(initial.folders.filter(folder => folder.entityId === entity.id).map(({ path }) => ({ path })), tree.folders);
}
for (const body of [{}, { id: null, name: 'Invalid' }, { id: 'INVALID ID', name: 'Invalid' }]) {
  await api('/api/entities', { method: 'POST', body, status: 400 });
}
const explicit = (await api('/api/entities', {
  method: 'POST', body: { id: 'folder-smoke-legacy', name: 'Legacy ID still supported' }, status: 201,
})).entity;
assert.equal(explicit.id, 'folder-smoke-legacy');
await api(`/api/entities/${explicit.id}`, { method: 'DELETE', status: 204 });

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => {
    errors.push(`Unexpected browser ${dialog.type()}`);
    await dialog.dismiss();
  });
  await page.goto(base.href);
  await page.locator('#login[open]').waitFor();
  await page.locator('#key').fill(token);
  await page.locator('#login-submit').click();
  await page.locator('#login').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#sync').textContent.startsWith('已同步'));
  assert.equal(await page.locator('#space-create, #entity-filter').count(), 0, 'There must be no separate space flow');
  assert.equal(await page.getByRole('button', { name: '＋ 新建文件夹', exact: true }).count(), 1);
  assert.ok(!(await page.locator('body').innerText()).includes('空间'), 'The library must present folders, not spaces');
  for (const entity of initial.entities) {
    assert.equal(await page.locator(`.folder[data-entity-id="${entity.id}"][data-path=""]`).count(), 1, 'Existing groups appear in the same tree');
  }
  for (const item of initial.pages.filter(item => item.entityId === null)) {
    assert.equal(await page.locator(`#list > .report[data-filename="${item.filename}"]`).count(), 1, 'Unassigned pages appear at the root');
  }

  async function newFolder(name, route, body) {
    await page.locator('#folder-create').click();
    assert.equal(await page.locator('#edit-title').innerText(), '新建文件夹');
    assert.equal(await page.locator('#edit-dialog input:visible').count(), 1, 'Creation asks only for a name, never an ID or path');
    assert.equal(await page.locator('#edit-name').isVisible(), true);
    assert.equal(await page.locator('#edit-entity').isVisible(), false);
    await page.locator('#edit-name').fill(name);
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === route && response.request().method() === 'POST');
    await page.locator('#edit-submit').click();
    const response = await pending;
    assert.equal(response.status(), 201, await response.text());
    assert.deepEqual(response.request().postDataJSON(), body);
    const data = await response.json();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#refresh').getAttribute('aria-busy') === 'false');
    return data;
  }
  await page.locator('#folder-root').click();
  const created = (await newFolder('  文件夹回归  ', '/api/entities', { name: '文件夹回归' })).entity;
  assert.match(created.id, /^[a-z0-9][a-z0-9_-]{0,63}$/);
  assert.equal(created.name, '文件夹回归');
  assert.ok(!initial.entities.some(entity => entity.id === created.id));
  assert.equal(await page.locator('#folder-location').innerText(), '文件夹回归');
  await newFolder('子文件夹', `/api/entities/${created.id}/folders`, { path: '子文件夹' });
  await newFolder('更深层', `/api/entities/${created.id}/folders`, { path: '子文件夹/更深层' });
  assert.equal(await page.locator('#folder-location').innerText(), '文件夹回归 / 子文件夹/更深层');
  const root = page.locator(`.folder[data-entity-id="${created.id}"][data-path=""]`);
  assert.equal(await root.locator('.folder').count(), 2, 'Children are nested under the same top-level folder');

  await page.locator('#folder-create').click();
  await page.locator('#edit-name').fill('not/a/name');
  await page.locator('#edit-submit').click();
  await page.locator('#edit-error').filter({ hasText: '请输入文件夹名称' }).waitFor();
  assert.equal(await page.locator('#edit-dialog').isVisible(), true);
  await page.locator('[data-close="edit-dialog"]').click();

  await page.locator('#folder-root').click();
  const sibling = (await newFolder('另一个文件夹', '/api/entities', { name: '另一个文件夹' })).entity;
  assert.notEqual(sibling.id, created.id);
  await page.getByRole('button', { name: '管理文件夹 另一个文件夹', exact: true }).click();
  await page.locator('#folder-delete').click();
  await page.locator('#confirm-submit').click();
  await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
  await page.locator(`.folder[data-entity-id="${sibling.id}"]`).waitFor({ state: 'detached' });
  assert.equal(await page.locator('#folder-root').getAttribute('aria-current'), 'location');

  // Root folders have the same management entry, without requiring an identifier.
  await page.getByRole('button', { name: '管理文件夹 文件夹回归', exact: true }).click();
  await page.locator('#edit-name').fill('改名后的文件夹');
  await page.locator('#edit-submit').click();
  await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '管理文件夹 改名后的文件夹', exact: true }).waitFor();
  assert.equal((await api('/api/entities')).entities.find(entity => entity.id === created.id).name, '改名后的文件夹');

  const named = await api(`/api/entities/${created.id}/tokens`, {
    method: 'POST', body: { name: 'existing-named-agent' }, status: 201,
  });
  const unnamed = await api(`/api/entities/${created.id}/tokens`, { method: 'POST', body: {}, status: 201 });
  for (const existing of [named, unnamed]) {
    assert.equal(Object.hasOwn(existing.token, 'expiresAt'), false, 'Legacy create defaults to no expiry');
    await api(`/api/entities/${created.id}/tree`, { auth: existing.secret });
  }
  const registryPath = join(process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data', '.tokens.json');
  const originalRegistry = JSON.parse(await readFile(registryPath, 'utf8'));
  const child = page.locator(`.folder[data-entity-id="${created.id}"][data-path="子文件夹/更深层"]`);
  await child.locator(':scope > summary > .folder-name').click();
  const issued = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === `/api/entities/${created.id}/tokens` && request.method() === 'POST') issued.push(request);
  });
  const creation = () => page.waitForResponse(response => new URL(response.url()).pathname === `/api/entities/${created.id}/tokens` && response.request().method() === 'POST');
  const readyKey = () => page.waitForFunction(() => !document.querySelector('#copy-api').disabled);
  async function closeApi() {
    await page.locator('[data-close="api-dialog"]').click();
    await page.waitForFunction(() => ['api-secret', 'api-payload'].every(id => document.getElementById(id).value === ''));
  }
  // Hold the first issuance in flight, then close/reopen: both views must share it.
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { entered = resolve; });
  await page.route('**/tokens', async route => {
    if (route.request().method() === 'POST') { entered(); await gate; }
    await route.continue();
  });
  const generated = creation();
  await page.locator('#folder-api').click();
  await intercepted;
  assert.equal(await page.locator('#copy-api').isDisabled(), true);
  await closeApi();
  await page.locator('#folder-api').click();
  release();
  const response = await generated;
  assert.equal(response.status(), 201);
  assert.deepEqual(response.request().postDataJSON(), { expiresIn: 604800 }, 'Opening API issues a finite key without a Generate action');
  const credential = await response.json();
  await readyKey();
  await page.unroute('**/tokens');
  assert.equal(issued.length, 1, 'Reopening during issuance must not create a second key');
  assert.ok((await page.locator('#api-scope').innerText()).includes('改名后的文件夹'));
  assert.ok((await page.locator('#api-scope').innerText()).includes('不限当前子文件夹'), 'Nested-folder API must accurately disclose its top-level scope');
  assert.equal(await page.locator('#token-name, #token-form, #token-create, #api-tokens, #copy-secret, #copy-command, #copy-agent').count(), 0);
  assert.equal(await page.locator('#api-dialog button:visible').count(), 2, 'Only close and the combined copy action remain');
  assert.equal(await page.locator('#api-dialog input:visible').count(), 1, 'Only the read-only Key, no naming or generation inputs');
  assert.equal(await page.locator('#api-secret').getAttribute('readonly'), '');
  const agent = await page.locator('#api-secret').inputValue();
  assert.equal(agent, credential.secret);
  assert.match(agent, /^ve_[A-Za-z0-9_-]{43}$/);
  assert.ok(Math.abs(Date.parse(credential.token.expiresAt) - Date.parse(credential.token.createdAt) - 604800000) < 1000);
  assert.ok((await page.locator('#api-expiry').innerText()).includes('到期：'));
  let currentToken = credential.token;
  for (const value of ['86400', '2592000', 'none', '604800']) {
    const updated = page.waitForResponse(response => new URL(response.url()).pathname === `/api/entities/${created.id}/tokens/${credential.token.id}` && response.request().method() === 'PATCH');
    await page.locator('#api-validity').selectOption(value);
    const edit = await updated;
    assert.equal(edit.status(), 200);
    assert.deepEqual(edit.request().postDataJSON(), { expiresIn: value === 'none' ? null : Number(value) });
    const result = await edit.json();
    assert.deepEqual(Object.keys(result), ['token'], 'Expiry edits return no recoverable secret');
    currentToken = result.token;
    assert.equal(currentToken.id, credential.token.id);
    assert.equal(currentToken.createdAt, credential.token.createdAt);
    assert.equal(Object.hasOwn(currentToken, 'expiresAt'), value !== 'none');
    await readyKey();
    assert.equal(await page.locator('#api-secret').inputValue(), agent, 'Validity changes preserve copied keys');
    await api(`/api/entities/${created.id}/tree`, { auth: agent });
  }
  assert.equal(issued.length, 1, 'Validity edits must not accumulate credentials');
  await closeApi();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#refresh').getAttribute('aria-busy') === 'false');
  await root.locator(':scope > summary > .folder-name').click();
  await page.locator('#folder-api').click();
  await readyKey();
  assert.equal(await page.locator('#api-secret').inputValue(), agent, 'Root and descendants reuse the same scoped credential');
  assert.ok(!(await page.locator('#api-payload').inputValue()).includes(encodeURIComponent('更深层')));
  await closeApi();
  if (!(await root.evaluate(element => element.open))) await root.locator(':scope > summary').click();
  await child.locator(':scope > summary > .folder-name').click();
  await page.locator('#folder-api').click();
  await readyKey();
  assert.equal(await page.locator('#api-secret').inputValue(), agent, 'Panel and library refresh reuse only the in-memory secret');
  const listed = (await api(`/api/entities/${created.id}/tokens`)).tokens;
  assert.deepEqual(listed, [named.token, unnamed.token, currentToken], 'Lists expose metadata, not secrets');
  assert.equal(issued.length, 1);
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  assert.ok(!storage.includes(agent) && !storage.includes(token), 'No credential may enter browser storage');
  await closeApi();
  await api('/api/tree', { auth: agent, status: 403 });
  await api('/api/entities', { method: 'POST', body: { name: 'Forbidden' }, auth: agent, status: 403 });
  if (initial.entities.length) await api(`/api/entities/${initial.entities[0].id}/tree`, { auth: agent, status: 403 });

  const filePath = '子文件夹/更深层/diagram.html';
  const fileRoute = `/api/entities/${created.id}/files/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const source = marker => `<!doctype html><html><head><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;
  const first = await api(fileRoute, { method: 'PUT', raw: source('FOLDER_UI_V1'), auth: agent, status: 201 });
  const second = await api(fileRoute, { method: 'PUT', raw: source('FOLDER_UI_V2'), auth: agent });
  assert.equal(second.page.filename, first.page.filename);
  assert.equal(second.page.url, first.page.url);
  assert.equal(await api(fileRoute, { auth: agent }), source('FOLDER_UI_V2'));
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#refresh').getAttribute('aria-busy') === 'false');
  // Search reveals a diagram even when its parent folder was collapsed.
  await page.locator('#search').fill('FOLDER_UI_V2');
  await page.locator(`.report[data-filename="${first.page.filename}"]`).click();
  await page.locator('#search').fill('');
  assert.equal(await page.locator('#folder-location').innerText(), '改名后的文件夹 / 子文件夹/更深层');
  await page.locator('#page-versions').click();
  const oldVersion = page.locator(`.version-row[data-revision="${first.revision}"]`);
  await oldVersion.getByRole('button', { name: '预览', exact: true }).click();
  await page.locator('#history-banner').waitFor({ state: 'visible' });
  await page.frameLocator('#preview').getByRole('heading', { name: 'FOLDER_UI_V1', exact: true }).waitFor();
  await page.locator('#history-restore').click();
  await page.locator('#confirm-submit').click();
  await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
  assert.equal(await api(fileRoute, { auth: agent }), source('FOLDER_UI_V1'), 'UI restore republishes the saved source');
  assert.ok((await api(first.page.url)).includes('FOLDER_UI_V1'), 'Existing signed URL survives restore');

  const current = await api('/api/tree');
  for (const entity of initial.entities) assert.deepEqual(current.entities.find(item => item.id === entity.id), entity);
  for (const item of initial.pages) assert.deepEqual(current.pages.find(value => value.filename === item.filename), item, 'Folder operations preserve every existing record and signed URL');
  for (const folder of initial.folders) assert.ok(current.folders.some(value => value.entityId === folder.entityId && value.path === folder.path));
  const saved = JSON.parse(await readFile(catalogPath, 'utf8'));
  for (const [filename, location] of Object.entries(originalCatalog.pages)) assert.deepEqual(saved.pages[filename], location);
  for (const entity of originalCatalog.entities) assert.deepEqual(saved.entities.find(item => item.id === entity.id), entity);

  await api(`/api/entities/${created.id}/tokens/${credential.token.id}`, { method: 'DELETE', status: 204 });
  await api(`/api/entities/${created.id}/tree`, { auth: agent, status: 401 });
  const replacement = creation();
  await page.locator('#folder-api').click();
  const fresh = await (await replacement).json();
  await readyKey();
  assert.equal(issued.length, 2, 'Only explicit revocation requires a replacement key');
  assert.notEqual(fresh.token.id, credential.token.id);
  await page.getByRole('button', { name: '复制提示词与命令', exact: true }).click();
  await page.locator('#api-status').filter({ hasText: '已复制' }).waitFor();
  const copyPayload = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copyPayload, await page.locator('#api-payload').inputValue(), 'Read the real browser clipboard, not a stub');
  assert.ok(copyPayload.includes(fresh.secret) && copyPayload.includes(encodeURIComponent('更深层')));
  const lines = copyPayload.split('\n');
  const commandLine = lines.findIndex(line => line.startsWith('curl '));
  assert.ok(commandLine > 5 && lines.slice(0, commandLine).every(line => line.startsWith('# ')), 'Every prose line must be a shell comment');
  assert.ok(!copyPayload.includes('```') && !copyPayload.includes('YOUR_FOLDER_TOKEN'));
  assert.equal(await page.locator('#api-payload').isVisible(), false);
  await closeApi();
  await api(`/api/entities/${created.id}/tree`, { auth: fresh.secret });
  for (const existing of [named, unnamed]) await api(`/api/entities/${created.id}/tree`, { auth: existing.secret });
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  assert.equal(registry.version, 1);
  assert.deepEqual(registry.tokens.filter(entry => entry.id !== fresh.token.id), originalRegistry.tokens,
    'Existing named/unnamed records and hashes remain byte-for-byte equivalent, without migration');
  for (const secret of [token, agent, fresh.secret, named.secret, unnamed.secret]) assert.ok(!JSON.stringify(registry).includes(secret));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#nav-toggle').click();
  await page.locator('#folder-api').click();
  await readyKey();
  assert.equal(await page.locator('#api-secret').inputValue(), fresh.secret);
  assert.ok(await page.locator('#api-dialog').evaluate(element => element.getBoundingClientRect().width <= innerWidth), 'Compact API panel fits the mobile viewport');
  assert.equal(issued.length, 2, 'Mobile rendering must reuse the existing key');
  await closeApi();
  await page.locator('#folder-root').click();
  assert.equal(await page.locator('#folder-create').isVisible(), true);
  assert.ok(await page.locator('#library').evaluate(element => element.scrollWidth <= element.clientWidth), 'Folder controls fit the mobile drawer');
  await page.locator('#folder-create').click();
  assert.equal(await page.locator('#edit-dialog input:visible').count(), 1);
  await page.locator('[data-close="edit-dialog"]').click();
  await page.reload();
  await page.locator('#nav-toggle').click();
  await page.locator(`.folder[data-entity-id="${created.id}"][data-path="子文件夹/更深层"]`).waitFor();

  const viewer = await browser.newContext();
  const readOnly = await viewer.newPage();
  const viewerKey = createHmac('sha256', token).update('viewer-access').digest('hex');
  await readOnly.goto(new URL('/?access=' + viewerKey, base).href);
  await readOnly.waitForFunction(() => document.querySelector('#sync').textContent.startsWith('已同步'));
  const viewerTokenRequests = [];
  readOnly.on('request', request => { if (new URL(request.url()).pathname.includes('/tokens')) viewerTokenRequests.push(request); });
  await readOnly.locator(`.folder[data-entity-id="${created.id}"][data-path=""] > summary > .folder-name`).click();
  const beforeViewer = await readFile(registryPath, 'utf8');
  await readOnly.locator('#folder-api').click();
  assert.equal(await readOnly.locator('#api-admin').isVisible(), false);
  assert.equal(await readOnly.locator('#api-secret').inputValue(), '');
  assert.equal(await readOnly.locator('#api-payload').inputValue(), '');
  assert.equal(await readOnly.locator('#login').isVisible(), false, 'Opening read-only API must not promote or prompt the viewer');
  assert.equal(viewerTokenRequests.length, 0, 'Viewer API must not even request token metadata');
  assert.equal(await readFile(registryPath, 'utf8'), beforeViewer);
  const forbidden = await readOnly.evaluate(async route => {
    const response = await fetch(route, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: null }) });
    return { status: response.status, body: await response.json() };
  }, `/api/entities/${created.id}/tokens/${fresh.token.id}`);
  assert.equal(forbidden.status, 401, 'Viewers cannot change validity either');
  assert.deepEqual(Object.keys(forbidden.body), ['error']);
  await readOnly.locator('[data-close="api-dialog"]').click();
  await readOnly.locator('#folder-create').click();
  await readOnly.locator('#login[open]').waitFor();
  assert.equal(await readOnly.locator('#edit-dialog').isVisible(), false, 'Read-only viewers must log in before creation');
  await readOnly.locator('#login-cancel').click();
  await viewer.close();
  assert.deepEqual(errors, [], 'The folder UI must not emit browser errors');
  // The host runner captures this pipe privately, executes the exact copied curl,
  // and revokes the key afterward. Never print this JSON to a terminal or log.
  process.stdout.write(JSON.stringify({ copyPayload, entityId: created.id, tokenId: fresh.token.id,
    path: '子文件夹/更深层/guides/example.html', legacyTokens: [named.token, unnamed.token] }));
} finally {
  await browser.close();
}
