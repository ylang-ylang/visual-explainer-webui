// Focused context-tree regression. Run only in a disposable source-mounted container.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

assert.equal(process.env.VE_CONTEXT_SMOKE, '1', 'Use a disposable local fixture, never the live library');
const base = new URL(process.env.PUBLIC_URL);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const token = (await readFile(process.env.TOKEN_FILE ?? '/run/secrets/api_token', 'utf8')).trim();
const dir = process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data';
const a = 'context-design', b = 'context-publish', c = 'context-example';
const folderRoute = id => '/api/entities/' + id;
const fileRoute = (id, path) => folderRoute(id) + '/files/' + path.split('/').map(encodeURIComponent).join('/');
async function api(path, { method = 'GET', body, raw, headers = {}, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), { method, headers: {
    Authorization: 'Bearer ' + token,
    ...(raw !== undefined ? { 'Content-Type': 'text/html; charset=utf-8' } : body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...headers,
  }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(180000) });
  assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
  return status === 204 ? null : response.json();
}
const html = title => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f6f8f6;color:#263b34;font:16px system-ui,sans-serif}main{max-width:880px;margin:auto;padding:64px 40px}small{color:#488371;letter-spacing:2px}h1{font-size:34px;margin:16px 0}p{color:#718279;line-height:1.8}.flow{display:flex;gap:16px;margin-top:36px}.card{flex:1;background:white;border:1px solid #dbe6dd;border-radius:12px;padding:24px}.card b{display:block;font-size:28px;color:#4b806d;margin-bottom:14px}@media(max-width:600px){main{padding:32px 20px}.flow{flex-direction:column}}</style></head><body><main><small>VISUAL EXPLAINER / DESIGN NOTES</small><h1>${title}</h1><p>从问题到机制，再到清晰可读的图解。</p><div class="flow"><section class="card"><b>01</b>理解问题<p>整理背景与关键约束</p></section><section class="card"><b>02</b>建立结构<p>连接概念与因果关系</p></section><section class="card"><b>03</b>分享图解<p>让信息自然呈现</p></section></div></main></body></html>`;
for (const [id, name] of [[a, '研究项目'], [b, '发布与分享'], [c, '交互示例']]) {
  await api('/api/entities', { method: 'POST', body: { id, name }, status: 201 });
}
for (const [id, path] of [[a, '方案/深入理解'], [a, '草稿'], [b, '参考']]) {
  await api(folderRoute(id) + '/folders', { method: 'POST', body: { path }, status: 201 });
}
const first = await api(fileRoute(a, '方案/架构总览.html'), { method: 'PUT', raw: html('架构总览'), status: 201 });
await api(fileRoute(a, '方案/架构总览.html'), { method: 'PUT', raw: html('架构总览 · 修订') });
const second = await api(fileRoute(a, '方案/流程说明.html'), { method: 'PUT', raw: html('流程说明'), status: 201 });
const legacy = await api('/api/pages/12345678-abcd-1234-abcd-123456789abc.html', {
  method: 'PUT', body: { html: html('已有图解的可读标题') }, status: 201,
});
await api(fileRoute(c, '实验演示.html'), { method: 'PUT', raw: html('实验演示'), status: 201 });
await api('/api/moves', { method: 'POST', body: {
  source: { kind: 'folder', entityId: c, path: '' }, destination: { entityId: a, path: '方案' },
} });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  let loggedIn = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (loggedIn && message.type() === 'error') errors.push(message.text()); });
  await page.goto(base.href);
  await page.locator('#key').fill(token);
  await page.locator('#login-submit').click();
  await page.locator('#login').waitFor({ state: 'hidden' });
  const settled = () => page.waitForFunction(() => !pageRequest && document.documentElement.dataset.sync === 'ready');
  await settled();
  loggedIn = true;
  const folder = (id, path = '', p = page) => p.locator(`.folder[data-entity-id="${id}"][data-path="${path}"] > summary`);
  const report = (item, p = page) => p.locator(`.report[data-filename="${item.page.filename}"]`);
  const menu = page.locator('#context-menu');
  async function action(row, name, p = page) {
    await row.click({ button: 'right' });
    await p.getByRole('menuitem', { name, exact: true }).click();
  }
  async function save() {
    await page.locator('#edit-submit').click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
    await settled();
  }
  async function blankMenu() {
    const box = await page.locator('#list').boundingBox();
    await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6, { button: 'right' });
    assert.equal(await menu.locator('.context-label').innerText(), 'Root');
  }
  assert.equal(await page.locator('#folder-create, #folder-api, #page-edit, #page-versions, .folder-action, .page-tools, .library-tools').count(), 0);
  assert.equal(await page.locator('.report-date, .report-file').count(), 0);
  assert.equal(await report(first).locator('.report-title').innerText(), '架构总览');
  assert.equal(await report(legacy).locator('.report-title').innerText(), '已有图解的可读标题', 'Opaque legacy filenames use the meaningful document title');
  assert.ok((await report(first).getAttribute('title')).includes('架构总览 · 修订'));
  assert.equal(await folder(c).locator('.folder-icon').count(), 1);
  assert.equal(await report(first).locator('.file').count(), 1);
  await report(first).click();
  await page.waitForFunction(() => !document.querySelector('#preview').hidden);
  const selection = first.page.filename;
  // Blank space is Root, even with a selected nested diagram/folder.
  await blankMenu();
  assert.equal(await page.evaluate(() => selected.filename), selection);
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
  await page.locator('#edit-name').fill('右键新建');
  await save();
  const created = (await api('/api/tree')).entities.find(item => item.name === '右键新建');
  assert.ok(created && created.parent === null);
  // Context-clicking a collapsed folder neither expands it nor changes the reader.
  await folder(a, '方案').click();
  const details = folder(a, '方案').locator('..');
  assert.equal(await details.evaluate(node => node.open), false);
  await folder(a, '方案').click({ button: 'right' });
  assert.equal(await details.evaluate(node => node.open), false);
  assert.equal(await page.evaluate(() => selected.filename), selection);
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
  await page.locator('#edit-name').fill('评审资料');
  await save();
  assert.ok((await api('/api/tree')).folders.some(item => item.entityId === a && item.path === '方案/评审资料'));
  // Invalid names stay in the existing dialog; no hidden path/ID fields are required.
  await action(folder(a), 'New folder');
  await page.locator('#edit-name').fill('not/a/name');
  await page.locator('#edit-submit').click();
  await page.locator('#edit-error').filter({ hasText: 'Enter a valid name' }).waitFor();
  await page.locator('[data-close="edit-dialog"]').click();
  // Separate rename/move menu actions cover ordinary, root and nested API folders.
  await action(folder(a, '草稿'), 'Rename');
  assert.equal(await page.locator('#edit-path').isVisible(), false);
  await page.locator('#edit-name').fill('修订草稿');
  await save();
  await action(folder(a, '修订草稿'), 'Move to…');
  await page.locator('#edit-entity').selectOption(b);
  await page.locator('#edit-path').fill('参考/待审');
  await save();
  assert.ok((await api('/api/tree')).folders.some(item => item.entityId === b && item.path === '参考/待审'));
  await action(folder(created.id), 'Rename');
  await page.locator('#edit-name').fill('设计归档');
  await save();
  await action(folder(created.id), 'Move to…');
  await page.locator('#edit-entity').selectOption(a);
  await page.locator('#edit-path').fill('方案');
  await save();
  assert.deepEqual((await api('/api/tree')).entities.find(item => item.id === created.id).parent, { entityId: a, path: '方案' });
  await action(folder(created.id), 'Rename');
  await page.locator('#edit-name').fill('归档材料');
  await save();
  await action(folder(created.id), 'Move to…');
  await page.locator('#edit-entity').selectOption('');
  await page.locator('#edit-path').fill('');
  await save();
  assert.equal((await api('/api/tree')).entities.find(item => item.id === created.id).parent, null);
  // Delete is a direct, confirmed empty-folder action, not another toolbar/dialog.
  await action(folder(created.id), 'Delete empty folder');
  await page.locator('#confirm-submit').click();
  await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
  await settled();
  assert.ok(!(await api('/api/tree')).entities.some(item => item.id === created.id));
  // A non-selected file's menu must address that file for rename, move, versions/open/API.
  await report(first).click();
  await action(report(second), 'Rename');
  assert.equal(await page.locator('#edit-name').inputValue(), '流程说明');
  assert.equal(await page.evaluate(() => selected.filename), selection);
  await page.locator('#edit-name').fill('操作流程');
  await save();
  assert.equal((await api('/api/pages/' + second.page.filename)).page.path, '方案/操作流程.html');
  assert.equal((await api('/api/pages/' + first.page.filename)).page.path, '方案/架构总览.html');
  await action(report(second), 'Move to…');
  await page.locator('#edit-entity').selectOption('');
  await page.locator('#edit-path').fill('操作流程');
  await save();
  assert.equal((await api('/api/pages/' + second.page.filename)).page.entityId, null);
  await report(first).click();
  await action(report(second), 'Version history');
  assert.equal(await page.evaluate(() => selected.filename), selection);
  await page.locator('.version-row').first().waitFor();
  assert.equal(await page.locator('#versions-path').innerText(), '操作流程');
  await page.locator('[data-close="versions-dialog"]').click();
  // Root file API explains moving to a folder without exposing admin keys.
  await action(report(second), 'File API');
  assert.equal(await page.locator('#api-admin').isVisible(), false);
  assert.equal(await page.locator('#api-title').innerText(), '操作流程 · API');
  assert.ok((await page.locator('#api-scope').innerText()).includes('Move this diagram into a folder'));
  await page.locator('[data-close="api-dialog"]').click();
  // Folder-scoped file API targets that exact file and shares the folder's key.
  await action(report(first), 'File API');
  await page.waitForFunction(() => !document.querySelector('#copy-api').disabled);
  assert.equal(await page.locator('#api-title').innerText(), '研究项目 / 方案/架构总览 · API');
  assert.ok((await page.locator('#api-base').innerText()).includes('/files/' + encodeURIComponent('方案') + '/' + encodeURIComponent('架构总览.html')));
  const fileSecret = await page.locator('#api-secret').inputValue();
  const filePayload = await page.locator('#api-payload').inputValue();
  assert.ok(filePayload.includes(first.page.filename) && filePayload.includes(encodeURIComponent('方案/架构总览.html')));
  await page.locator('[data-close="api-dialog"]').click();
  await action(folder(a), 'Folder API');
  await page.waitForFunction(() => !document.querySelector('#copy-api').disabled);
  assert.equal(await page.locator('#api-secret').inputValue(), fileSecret, 'File API and Folder API must reuse the same scoped key');
  await page.locator('[data-close="api-dialog"]').click();
  const popupPromise = page.waitForEvent('popup');
  await action(report(second), 'Open in new tab');
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(), second.page.url);
  await popup.close();
  await action(report(first), 'Version history');
  await page.locator(`.version-row[data-revision="${first.revision}"]`).getByRole('button', { name: 'Preview', exact: true }).click();
  await page.frameLocator('#preview').getByRole('heading', { name: '架构总览', exact: true }).waitFor();
  await page.locator('#history-current').click();
  await page.frameLocator('#preview').getByRole('heading', { name: '架构总览 · 修订', exact: true }).waitFor();
  // API retains the simplified key/validity/single-copy flow, including nested anchors.
  await action(folder(c), 'Folder API');
  await page.waitForFunction(() => !document.querySelector('#copy-api').disabled);
  assert.ok((await page.locator('#api-base').innerText()).endsWith(folderRoute(c)));
  assert.equal(await page.locator('#api-dialog button:visible').count(), 2);
  assert.equal(await page.locator('#api-validity').inputValue(), '604800');
  const secret = await page.locator('#api-secret').inputValue();
  await page.locator('#api-validity').selectOption('86400');
  await page.waitForFunction(() => !document.querySelector('#copy-api').disabled);
  assert.equal(await page.locator('#api-secret').inputValue(), secret);
  await page.locator('[data-close="api-dialog"]').click();
  await action(folder(c), 'Folder API');
  await page.waitForFunction(() => !document.querySelector('#copy-api').disabled);
  assert.equal(await page.locator('#api-secret').inputValue(), secret);
  assert.equal((await api(folderRoute(c) + '/tokens')).tokens.length, 1);
  await page.locator('[data-close="api-dialog"]').click();
  // Keyboard invocation, menu traversal, activation and Escape preserve row focus.
  await folder(c).focus();
  await page.keyboard.press('Shift+F10');
  assert.equal(await menu.isVisible(), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'New folder');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Rename');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#edit-title').innerText(), 'Rename folder');
  await page.keyboard.press('Escape');
  await folder(c).focus();
  await page.keyboard.press('ContextMenu');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Delete empty folder');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'New page');
  await page.keyboard.press('Escape');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await folder(c).evaluate(node => node === document.activeElement), true);
  // New page creates a starter page inside a folder, rejects duplicates, and supports pasted HTML at Root.
  await action(folder(c), 'New page');
  await page.locator('#new-page-name').fill('空白草稿');
  await page.locator('#new-page-submit').click();
  await page.locator('#new-page-dialog').waitFor({ state: 'hidden' });
  await settled();
  await page.frameLocator('#preview').getByRole('heading', { name: '空白草稿', exact: true }).waitFor();
  assert.equal(await page.locator('#page-title').innerText(), '空白草稿');
  await page.locator('#viewer-api').click();
  await page.waitForFunction(() => !document.querySelector('#copy-api').disabled);
  assert.ok((await page.locator('#api-payload').inputValue()).includes(encodeURIComponent('空白草稿.html')));
  await page.locator('[data-close="api-dialog"]').click();
  await action(folder(c), 'New page');
  await page.locator('#new-page-name').fill('空白草稿');
  await page.locator('#new-page-submit').click();
  await page.locator('#new-page-error').filter({ hasText: 'already exists' }).waitFor();
  await page.locator('[data-close="new-page-dialog"]').first().click();
  await blankMenu();
  await page.getByRole('menuitem', { name: 'New page', exact: true }).click();
  await page.locator('#new-page-name').fill('自定义根页');
  await page.locator('#new-page-html').fill(html('自定义根页内容'));
  await page.locator('#new-page-submit').click();
  await page.locator('#new-page-dialog').waitFor({ state: 'hidden' });
  await settled();
  await page.frameLocator('#preview').getByRole('heading', { name: '自定义根页内容', exact: true }).waitFor();
  await blankMenu();
  await page.getByRole('menuitem', { name: 'New page', exact: true }).click();
  await page.locator('#new-page-name').fill('自定义根页');
  await page.locator('#new-page-submit').click();
  await page.locator('#new-page-error').filter({ hasText: 'already exists' }).waitFor();
  await page.locator('[data-close="new-page-dialog"]').first().click();
  // Verify server-side If-None-Match: * race guards directly via Node fetch (no browser console 409).
  const folderConflict = await api(fileRoute(c, '空白草稿.html'), {
    method: 'PUT', raw: html('不应覆盖'), headers: { 'If-None-Match': '*' }, status: 409,
  });
  assert.ok(folderConflict.error.includes('already exists'));
  const rootConflict = await api('/api/pages/' + encodeURIComponent('自定义根页.html'), {
    method: 'PUT', body: { html: html('不应覆盖'), entityId: null }, headers: { 'If-None-Match': '*' }, status: 409,
  });
  assert.ok(rootConflict.error.includes('already exists'));
  await folder(c).click({ button: 'right' });
  await page.locator('.brand').click();
  assert.equal(await menu.isVisible(), false);
  // Real Chromium pointer dragging, not synthetic DataTransfer/drop events.
  await page.evaluate(() => { window.nativeStarts = 0; document.addEventListener('dragstart', () => window.nativeStarts++); });
  async function drag(source, target) {
    await source.scrollIntoViewIfNeeded();
    const from = await source.boundingBox();
    await page.mouse.move(from.x + 35, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 45, from.y + from.height / 2, { steps: 5 });
    await target.scrollIntoViewIfNeeded();
    const to = await target.boundingBox();
    await page.mouse.move(to.x + 35, to.y + to.height / 2, { steps: 15 });
    await page.mouse.move(to.x + 36, to.y + to.height / 2);
    assert.equal(await target.evaluate(node => node.classList.contains('drop-target')), true);
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/moves' && value.request().method() === 'POST');
    await page.mouse.up();
    assert.equal((await response).status(), 200);
    await settled();
  }
  await drag(report(second), folder(b, '参考'));
  assert.equal((await api('/api/pages/' + second.page.filename)).page.path, '参考/操作流程.html');
  await drag(folder(c), page.locator('#folder-root'));
  assert.equal((await api('/api/tree')).entities.find(item => item.id === c).parent, null);
  assert.equal(await page.evaluate(() => window.nativeStarts), 2);
  await report(first).click();
  await page.waitForFunction(() => !document.querySelector('#preview').hidden);
  await folder(a, '方案').click({ button: 'right' });
  await page.screenshot({ path: '/tmp/ve-context-desktop.png' });
  await page.keyboard.press('Escape');
  // Native menus outside the tree/reader header (especially opaque preview) remain native.
  await page.evaluate(() => document.addEventListener('contextmenu', event => { window.outerPrevented = event.defaultPrevented; }));
  await page.locator('.brand').click({ button: 'right' });
  assert.equal(await page.evaluate(() => window.outerPrevented), false);
  const frame = page.frames().find(value => value.url().includes('/pages/'));
  await frame.evaluate(() => document.addEventListener('contextmenu', event => { window.innerPrevented = event.defaultPrevented; }));
  await page.frameLocator('#preview').getByRole('heading').click({ button: 'right' });
  assert.equal(await frame.evaluate(() => window.innerPrevented), false);
  assert.equal(await menu.isVisible(), false);
  // Overflow fixtures belong only to this disposable library.
  for (let index = 0; index < 16; index++) await api(folderRoute(b) + '/folders', {
    method: 'POST', body: { path: '资料目录 ' + String(index + 1).padStart(2, '0') }, status: 201,
  });
  await page.evaluate(() => loadPages(true));
  await settled();
  async function lowerEdgeMenu(row) {
    await row.evaluate(node => {
      const list = document.getElementById('list');
      list.scrollTop += node.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom + 4;
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const edge = await row.boundingBox();
    const point = { x: edge.x + edge.width - 6, y: edge.y + edge.height - 4 };
    await page.mouse.click(point.x, point.y, { button: 'right' });
    return point;
  }
  let point = await lowerEdgeMenu(folder(b, '资料目录 16'));
  let bounds = await menu.boundingBox();
  assert.ok(bounds.y < point.y && bounds.y + bounds.height <= 952 && bounds.y >= 8, 'Bottom-edge menu must shift upward, not clip');
  const list = await page.locator('#list').boundingBox();
  await page.mouse.move(list.x + 3, list.y + 60);
  await page.mouse.wheel(0, -300);
  await menu.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#nav-toggle').click();
  point = await lowerEdgeMenu(folder(b, '资料目录 16'));
  bounds = await menu.boundingBox();
  assert.ok(bounds.x < point.x && bounds.y < point.y, 'A real bottom/right click must shift the menu on both axes');
  assert.ok(bounds.x >= 8 && bounds.x + bounds.width <= 382 && bounds.y >= 8 && bounds.y + bounds.height <= 836);
  assert.equal(await menu.evaluate(node => node.parentElement.id), 'library');
  assert.ok(await page.locator('#library').evaluate(node => node.scrollWidth <= node.clientWidth));
  await page.screenshot({ path: '/tmp/ve-context-narrow-edge.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#library').isVisible(), true, 'Escape closes only the menu, not the compact drawer');
  await page.locator('#close-library').click();
  assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  // A fresh read-only viewer never requests tokens or receives management entries.
  const viewer = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const readOnly = await viewer.newPage();
  const access = createHmac('sha256', token).update('viewer-access').digest('hex');
  await readOnly.goto(new URL('/?access=' + access, base).href);
  await readOnly.waitForFunction(() => document.documentElement.dataset.sync === 'ready');
  const requests = [];
  readOnly.on('request', request => { if (new URL(request.url()).pathname.includes('/tokens')) requests.push(request); });
  const before = await readFile(join(dir, '.tokens.json'), 'utf8');
  await folder(c, '', readOnly).click({ button: 'right' });
  assert.equal(await readOnly.locator('#context-menu').isVisible(), true, 'A queued scroll-into-view event must not dismiss a newly opened menu');
  assert.deepEqual(await readOnly.getByRole('menuitem').allTextContents(), ['Folder API']);
  await readOnly.getByRole('menuitem', { name: 'Folder API', exact: true }).click();
  assert.equal(await readOnly.locator('#api-admin').isVisible(), false);
  assert.equal(await readOnly.locator('#api-secret').inputValue(), '');
  assert.equal(await readOnly.locator('#api-payload').inputValue(), '');
  assert.equal(await readOnly.locator('#login[open]').count(), 0);
  await readOnly.locator('[data-close="api-dialog"]').click();
  await report(first, readOnly).click({ button: 'right' });
  assert.deepEqual(await readOnly.getByRole('menuitem').allTextContents(), ['Open', 'Open in new tab', 'Version history', 'File API']);
  await readOnly.keyboard.press('Escape');
  await readOnly.locator('#folder-root').click({ button: 'right' });
  assert.equal(await readOnly.getByRole('menuitem', { name: 'Read-only', exact: true }).isDisabled(), true);
  await readOnly.keyboard.press('Escape');
  assert.equal(await readOnly.locator('#list [draggable="true"]').count(), 0);
  const denial = await readOnly.evaluate(async () => (await fetch('/api/entities', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'forbidden' }),
  })).status);
  assert.equal(denial, 401);
  assert.equal(requests.length, 0);
  assert.equal(await readFile(join(dir, '.tokens.json'), 'utf8'), before);
  assert.deepEqual(errors, []);
  console.log('PASS context tree: native right-click root/child creation; ordinary/root/nested-anchor rename/move; explicit diagram target/versions/open; API key reuse/validity; confirmed deletion; keyboard/Escape/outside/scroll; viewport edges; native drag; narrow layout; viewer denial; no permanent management buttons or browser errors');
  await viewer.close();
  await context.close();
} catch (error) {
  console.error(String(error.stack ?? error).replaceAll(token, '[redacted]').replace(/ve_[A-Za-z0-9_-]{43}/g, '[redacted]'));
  process.exitCode = 1;
} finally { await browser.close(); }
