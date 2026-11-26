// Real-pointer browser + API regression. Only the disposable check-image container.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

assert.equal(process.env.VE_ORGANIZE_SMOKE, '1', 'Use scripts/organize-check.mjs');
const base = new URL(process.env.PUBLIC_URL);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const dir = process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data';
const token = (await readFile(process.env.TOKEN_FILE ?? '/run/secrets/api_token', 'utf8')).trim();
const checkpoint = join(dir, '.drag-checkpoint.json');
const a = 'drag-smoke-a', b = 'drag-smoke-b', c = 'drag-smoke-c';
const entity = id => `/api/entities/${id}`;
const file = (id, path) => `${entity(id)}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
const pageRoute = page => `/api/pages/${encodeURIComponent(page.filename)}`;
const head = () => execFileSync('git', [`--git-dir=${join(dir, '.git')}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
async function api(path, { method = 'GET', body, raw, auth = token, status = 200 } = {}) {
  const target = new URL(path, base);
  assert.equal(target.origin, base.origin);
  const response = await fetch(target, { method, headers: {
    ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    ...(raw !== undefined ? { 'Content-Type': 'text/html; charset=utf-8' } : body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(180000) });
  assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
  if (status === 204) return null;
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response.text();
}
const html = title => `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0}main{width:100%;background:#eff6f2;padding:24px;box-sizing:border-box}@media(max-width:600px){h1{font-size:20px}}</style></head><body><main><h1>${title}</h1><p>Exact source — 拖动整理</p></main></body></html>\n`;
const put = async (id, path, title) => (await api(file(id, path), { method: 'PUT', raw: html(title), status: 201 })).page;
const moveBody = (entityId, path, destinationId, destinationPath) => ({
  source: { kind: 'folder', entityId, path }, destination: { entityId: destinationId, path: destinationPath },
});
async function unchanged(action) {
  const before = await readFile(join(dir, '.entities.json'), 'utf8'), revision = head();
  const registry = await readFile(join(dir, '.tokens.json'), 'utf8');
  await action();
  assert.equal(await readFile(join(dir, '.entities.json'), 'utf8'), before, 'Rejected/no-op gesture must leave exact catalog bytes unchanged');
  assert.equal(head(), revision, 'Rejected/no-op gesture must not add a Git version');
  assert.equal(await readFile(join(dir, '.tokens.json'), 'utf8'), registry, 'Moving must not rotate, create or remove Keys');
}
async function currentDenial(id, key, page, revision) {
  await api(`${pageRoute(page)}/versions`, { auth: key, status: 403 });
  await api(`${pageRoute(page)}/versions/${revision}`, { auth: key, status: 403 });
  await api(`${pageRoute(page)}/restore`, { method: 'POST', body: { revision }, auth: key, status: 403 });
  assert.ok(!(await api(`${entity(id)}/tree`, { auth: key })).pages.some(value => value.filename === page.filename));
}
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  if (process.env.VE_ORGANIZE_PHASE === 'persistence') {
    const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
    assert.equal(head(), saved.head, 'Restart must not manufacture a new version');
    assert.deepEqual(await api('/api/tree'), saved.tree, 'Full hierarchy and stable page identities persist across restart');
    assert.equal(JSON.parse(await readFile(join(dir, '.entities.json'))).version, 3);
    for (const item of saved.pages) {
      if (item.id !== null) assert.equal(await api(file(item.id, item.path), { auth: saved.keys[item.id] }), html(item.title));
      else {
        const root = (await api(pageRoute(item.page))).page;
        assert.equal(root.entityId, null);
        assert.equal(root.path, item.path);
        assert.equal(await readFile(join(dir, item.page.filename.replace(/(\.html?)$/i, '.src$1')), 'utf8'), html(item.title));
      }
      assert.equal(await api(item.page.url, { auth: null }), item.compiled);
      const current = (await api(`${pageRoute(item.page)}/versions`, { auth: item.id === null ? token : saved.keys[item.id] })).versions;
      assert.ok(current.length > 0);
    }
    assert.equal(await api(saved.version.url, { auth: null }), saved.versionBytes);
    await currentDenial(a, saved.keys[a], saved.anchoredPage, saved.oldParentVersion.revision);
    await api(file(c, 'anchored.html'), { auth: saved.keys[c] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const access = createHmac('sha256', token).update('viewer-access').digest('hex');
    await page.goto(new URL('/?access=' + access, base).href);
    await page.waitForFunction(() => document.documentElement.dataset.sync === 'ready');
    assert.equal(await page.locator('#list [draggable="true"]').count(), 0, 'Viewer rows must not advertise or fire drag gestures');
    assert.equal(await page.locator('#login[open]').count(), 0);
    const result = await page.evaluate(async body => {
      const response = await fetch('/api/moves', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return response.status;
    }, moveBody(c, '', a, ''));
    assert.equal(result, 401, 'Viewer cookie cannot mutate even with a forged drop request');
    await page.evaluate(() => { window.viewerDragStarts = 0; document.addEventListener('dragstart', () => { window.viewerDragStarts++; }); });
    await page.locator(`.report[data-filename="${saved.anchoredPage.filename}"]`).dragTo(page.locator('#folder-root'));
    assert.equal(await page.evaluate(() => window.viewerDragStarts), 0, 'Viewer pointer attempt must not fire a native source gesture');
    assert.equal(await page.locator('#login[open]').count(), 0, 'Read-only drag must not introduce credential prompts');
    assert.deepEqual(await api('/api/tree'), saved.tree);
    await context.close();
    await rm(checkpoint);
    console.log('PASS drag restart: exact hierarchy/bytes/URLs/Keys/history retained; former parent denied; viewer cannot drag or mutate');
  } else {
    for (const [id, name] of [[a, '拖动 A'], [b, '拖动 B'], [c, '锚定 C']]) await api('/api/entities', { method: 'POST', body: { id, name }, status: 201 });
    for (const [id, path] of [[a, 'src/nested'], [a, 'same'], [b, 'dest/same']]) await api(`${entity(id)}/folders`, { method: 'POST', body: { path }, status: 201 });
    const diagram = await put(a, 'diagram.html', '拖动图解');
    const plain = await put(a, 'src/nested/plain.html', '普通子树图解');
    const anchored = await put(c, 'anchored.html', '锚定子树图解');
    const own = await put(a, 'own.html', '原文件夹图解');
    const originalVersion = (await api(`${pageRoute(diagram)}/versions`)).versions[0];
    const anchoredInitialVersion = (await api(`${pageRoute(anchored)}/versions`)).versions[0];
    const versionBytes = await api(originalVersion.url, { auth: null });
    const compiled = await api(diagram.url, { auth: null });
    const originalSource = await readFile(join(dir, diagram.filename.replace(/(\.html?)$/i, '.src$1')));
    const keys = {};
    for (const id of [a, b, c]) keys[id] = (await api(`${entity(id)}/tokens`, { method: 'POST', body: {}, status: 201 })).secret;
    const registry = await readFile(join(dir, '.tokens.json'), 'utf8');
    const late = await put(a, 'late-arrival.html', '待移入根目录');
    await writeFile(join(dir, 'late-arrival.html'), html('外部新增根文件'));
    await unchanged(() => api('/api/moves', { method: 'POST', body: {
      source: { kind: 'page', filename: late.filename }, destination: { entityId: null, path: '' },
    }, status: 409 }));
    for (const source of [{ kind: 'folder', entityId: a, path: 42 }, { kind: 'unknown', entityId: a, path: '' }]) {
      await unchanged(() => api('/api/moves', { method: 'POST', body: { source, destination: { entityId: null, path: '' } }, status: 400 }));
    }
    const context = await browser.newContext({ viewport: { width: 1360, height: 960 } });
    const page = await context.newPage();
    const errors = [], moves = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/moves') moves.push(request); });
    await page.goto(base.href);
    await page.locator('#login[open]').waitFor();
    await page.locator('#key').fill(token);
    await page.locator('#login-submit').click();
    await page.locator('#login').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.documentElement.dataset.sync === 'ready');
    await page.evaluate(() => {
      window.gestures = { starts: 0, drops: 0, ends: 0 };
      for (const [event, key] of [['dragstart', 'starts'], ['drop', 'drops'], ['dragend', 'ends']]) {
        document.addEventListener(event, () => { window.gestures[key]++; });
      }
    });
    const folder = (id, path = '') => page.locator(`.folder[data-entity-id="${id}"][data-path="${path}"] > summary`).first();
    const report = item => page.locator(`.report[data-filename="${item.filename}"]`);
    async function contextAction(row, name) {
      await row.click({ button: 'right' });
      await page.getByRole('menuitem', { name, exact: true }).click();
    }
    async function refresh() {
      await page.evaluate(() => loadPages(true));
      await page.waitForFunction(() => !pageRequest && document.documentElement.dataset.sync === 'ready');
    }
    async function pointerStart(source, target) {
      await source.scrollIntoViewIfNeeded();
      const from = await source.boundingBox();
      await page.mouse.move(from.x + 30, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 39, from.y + from.height / 2, { steps: 5 });
      await target.scrollIntoViewIfNeeded();
      const to = await target.boundingBox();
      await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 14 });
      await page.mouse.move(to.x + 31, to.y + to.height / 2);
    }
    async function pointerMove(source, target, status = 200) {
      const count = moves.length;
      const before = await page.evaluate(() => window.gestures.starts);
      await pointerStart(source, target);
      assert.equal(await target.evaluate(element => element.classList.contains('drop-target')), true, 'Native dragover must mark the actual destination');
      if (count === 0) await page.screenshot({ path: '/tmp/ve-drag-target.png' });
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/moves' && response.request().method() === 'POST');
      await page.mouse.up();
      const result = await response;
      assert.equal(result.status(), status, await result.text());
      await page.waitForFunction(() => !movePending && !pageRequest && document.documentElement.dataset.sync === 'ready');
      assert.equal(moves.length, count + 1, 'Exactly one mutation must originate from the pointer gesture');
      assert.equal(await page.evaluate(() => window.gestures.starts), before + 1, 'Native browser dragstart must actually fire');
      return result.json();
    }
    await pointerMove(report(diagram), folder(a, 'src/nested'));
    assert.equal((await api('/api/tree')).pages.find(value => value.filename === diagram.filename).path, 'src/nested/diagram.html');
    await pointerMove(report(diagram), folder(b, 'dest'));
    assert.equal((await api('/api/tree')).pages.find(value => value.filename === diagram.filename).entityId, b);
    await pointerMove(report(diagram), page.locator('#folder-root'));
    assert.deepEqual((await api('/api/tree')).pages.find(value => value.filename === diagram.filename).path, 'diagram.html');
    assert.equal(await report(diagram).evaluate(element => element.parentElement.id), 'list');
    assert.equal(await api(diagram.url, { auth: null }), compiled);
    assert.deepEqual(await readFile(join(dir, diagram.filename.replace(/(\.html?)$/i, '.src$1'))), originalSource);
    assert.equal(await api(originalVersion.url, { auth: null }), versionBytes);
    const collision = await put(b, 'dest/diagram.html', '名称冲突图解');
    await refresh();
    await unchanged(() => pointerMove(report(diagram), folder(b, 'dest'), 409));
    assert.ok((await page.locator('#notice').innerText()).startsWith('Not moved: '));
    assert.equal(await api(collision.url, { auth: null }).then(text => text.includes('名称冲突图解')), true);
    await unchanged(() => pointerMove(folder(a, 'same'), folder(b, 'dest'), 409));
    await unchanged(() => pointerMove(report(diagram), page.locator('#folder-root')));
    // Context-menu move reuses the existing destination dialog, including Root.
    await report(diagram).click();
    await contextAction(report(diagram), 'Move to…');
    await page.locator('#edit-entity').selectOption(a);
    await page.locator('#edit-path').fill('src/nested/fallback.html');
    await page.locator('#edit-submit').click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !pageRequest);
    assert.equal((await api(pageRoute(diagram))).page.path, 'src/nested/fallback.html');
    await contextAction(report(diagram), 'Move to…');
    await page.locator('#edit-entity').selectOption('');
    await page.locator('#edit-path').fill('diagram.html');
    await page.locator('#edit-submit').click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !pageRequest);
    assert.equal((await api(pageRoute(diagram))).page.entityId, null);
    for (const target of [folder(a, 'src'), folder(a, 'src/nested')]) await unchanged(async () => {
      const count = moves.length;
      await pointerStart(folder(a, 'src'), target);
      assert.equal(await target.evaluate(element => element.classList.contains('drop-invalid')), true);
      await page.screenshot({ path: '/tmp/ve-drag-rejected.png' });
      await page.mouse.up();
      await page.waitForFunction(() => !dragging && !pageRequest);
      assert.equal(moves.length, count, 'Self/descendant target must not submit a move');
    });
    await unchanged(async () => {
      const count = moves.length;
      await pointerStart(report(diagram), report(own));
      assert.equal(await page.locator('.drop-target').count(), 0);
      await page.mouse.up();
      await page.waitForFunction(() => !dragging && !pageRequest);
      assert.equal(moves.length, count, 'Dropping on a file row must not claim or persist a reorder');
    });
    await unchanged(async () => {
      const count = moves.length;
      await pointerStart(report(diagram), folder(a, 'src/nested'));
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.waitForFunction(() => !dragging && !pageRequest);
      assert.equal(moves.length, count, 'Escape cancels the native gesture without mutation');
    });
    for (const body of [moveBody(a, '', a, ''), moveBody(a, 'src', a, 'src/nested'), moveBody(a, '', a, 'src')]) {
      await unchanged(() => api('/api/moves', { method: 'POST', body, status: 409 }));
    }
    // An in-flight library refresh must not detach the native source row.
    let entered, release, trees = 0;
    const intercepted = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/tree', async route => { trees++; entered(); await gate; await route.continue(); });
    await page.evaluate(() => { void loadPages(true); });
    await intercepted;
    const sourceNode = await report(diagram).elementHandle();
    await pointerStart(report(diagram), folder(a, 'src/nested'));
    release();
    await page.waitForFunction(() => pageRequest === null);
    assert.equal(await sourceNode.evaluate(element => element.isConnected), true, 'In-flight refresh must not replace an active native drag source');
    assert.equal(await page.evaluate(() => dragging?.filename), diagram.filename);
    await page.waitForTimeout(15500); // The real 15-second timer runs while held.
    assert.equal(trees, 1, 'The periodic library refresh must defer while a native drag is active');
    assert.equal(await sourceNode.evaluate(element => element.isConnected), true);
    assert.equal(await page.evaluate(() => dragging?.filename), diagram.filename);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.unroute('**/api/tree');
    await page.waitForFunction(() => !dragging && !pageRequest);
    // Anchor into an ordinary folder, then carry it in an ordinary subtree.
    await pointerMove(folder(c), folder(a, 'src/nested'));
    assert.equal(await api(file(c, 'anchored.html'), { auth: keys[c] }), html('锚定子树图解'));
    assert.equal(await api(file(a, 'src/nested/锚定 C/anchored.html'), { auth: keys[a] }), html('锚定子树图解'));
    await contextAction(folder(a, 'same'), 'Move to…');
    await page.locator('#edit-path').fill('src/nested/锚定 C/fallback');
    await page.locator('#edit-submit').click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !pageRequest);
    assert.deepEqual(await page.evaluate(() => currentFolder), { entityId: c, path: 'fallback' }, 'Dialog follows canonical identity across an anchored API path');
    await contextAction(folder(c, 'fallback'), 'Move to…');
    await page.locator('#edit-entity').selectOption(a);
    await page.locator('#edit-path').fill('same');
    await page.locator('#edit-submit').click();
    await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !pageRequest);
    assert.deepEqual(await page.evaluate(() => currentFolder), { entityId: a, path: 'same' });
    const oldParentVersion = (await api(`${pageRoute(anchored)}/versions`, { auth: keys[a] })).versions[0];
    await pointerMove(folder(a, 'src'), folder(b, 'dest'));
    assert.equal(await report(plain).evaluate(element => element.closest('.folder').dataset.path), 'dest/src/nested');
    const nestedC = (await api('/api/tree')).entities.find(value => value.id === c);
    assert.deepEqual(nestedC.parent, { entityId: b, path: 'dest/src/nested' });
    assert.equal(await api(file(b, 'dest/src/nested/锚定 C/anchored.html'), { auth: keys[b] }), html('锚定子树图解'));
    await currentDenial(a, keys[a], anchored, oldParentVersion.revision);
    await api(`${pageRoute(anchored)}/versions/${oldParentVersion.revision}`, { auth: keys[b], status: 403 });
    assert.equal((await api(`${pageRoute(anchored)}/versions/${anchoredInitialVersion.revision}`, { auth: keys[c] })).html, html('锚定子树图解'));
    const parentPath = 'dest/src/nested/锚定 C/parent-upload.html';
    const parentPublished = await api(file(b, parentPath), { method: 'PUT', raw: html('父级发布图解'), auth: keys[b], status: 201 });
    assert.equal(parentPublished.page.entityId, b);
    assert.equal(parentPublished.page.path, parentPath);
    assert.equal(await api(file(c, 'parent-upload.html'), { auth: keys[c] }), html('父级发布图解'));
    await api(file(b, parentPath), { method: 'PATCH', body: { path: 'dest/src/nested/锚定 C/parent-renamed.html' }, auth: keys[b] });
    assert.equal(await api(file(c, 'parent-renamed.html'), { auth: keys[c] }), html('父级发布图解'));
    const unassigned = (await api(pageRoute(parentPublished.page), { method: 'PUT', body: { html: html('父级发布图解'), entityId: null } })).page;
    assert.equal(unassigned.entityId, null, 'Legacy explicit-null publication still unassigns a nested page');
    assert.equal(unassigned.path, parentPublished.page.filename);
    assert.equal(unassigned.url, parentPublished.page.url);
    await api(`${entity(b)}/folders`, { method: 'POST', body: { path: 'dest/src/nested/锚定 C/parent-created' }, auth: keys[b], status: 201 });
    assert.ok((await api(`${entity(c)}/tree`, { auth: keys[c] })).folders.some(value => value.path === 'parent-created'));
    await api(`${entity(b)}/folders?path=${encodeURIComponent('dest/src/nested/锚定 C/parent-created')}`, { method: 'DELETE', auth: keys[b], status: 204 });
    // Root scope folder A can nest under B and return to root with the SAME Key.
    await pointerMove(folder(a), folder(b, 'dest'));
    assert.equal(await folder(a).evaluate(element => element.parentElement.parentElement.closest('.folder').dataset.entityId), b);
    assert.equal(await api(file(a, 'own.html'), { auth: keys[a] }), html('原文件夹图解'));
    assert.equal(await api(file(b, 'dest/拖动 A/own.html'), { auth: keys[b] }), html('原文件夹图解'));
    const bVersion = (await api(`${pageRoute(own)}/versions`, { auth: keys[b] })).versions[0];
    await pointerMove(folder(a), page.locator('#folder-root'));
    assert.equal((await api('/api/tree')).entities.find(value => value.id === a).parent, null);
    await currentDenial(b, keys[b], own, bVersion.revision);
    // Promote ordinary subtree to root; the anchored C descendant keeps its ID.
    const promoted = (await pointerMove(folder(b, 'dest/src'), page.locator('#folder-root'))).move.entityId;
    assert.equal((await api('/api/tree')).entities.find(value => value.id === promoted).name, 'src');
    assert.equal((await api('/api/tree')).entities.find(value => value.id === c).parent.entityId, promoted);
    assert.equal(await api(file(c, 'anchored.html'), { auth: keys[c] }), html('锚定子树图解'));
    await pointerMove(folder(promoted), folder(b, 'dest'));
    assert.equal(await api(file(b, 'dest/src/nested/plain.html'), { auth: keys[b] }), html('普通子树图解'));
    assert.equal(await api(file(b, 'dest/src/nested/锚定 C/anchored.html'), { auth: keys[b] }), html('锚定子树图解'));
    await refresh();
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.sync === 'ready');
    await report(plain).click();
    await page.waitForFunction(() => !document.querySelector('#preview').hidden);
    assert.ok((await page.locator('#page-meta').innerText()).includes('拖动 B / dest / src / nested/plain'), 'Breadcrumb composes anchored parent edges');
    assert.equal(await page.locator('#desktop, #mobile, .sizes').count(), 0);
    assert.equal(await page.locator('#stage').getAttribute('data-size'), null);
    async function fits() {
      const sizes = await page.evaluate(() => ({ stage: document.querySelector('#stage').clientWidth,
        frame: document.querySelector('#preview').getBoundingClientRect().width, body: document.body.scrollWidth, window: innerWidth }));
      assert.ok(Math.abs(sizes.stage - sizes.frame) <= 1, 'Preview must fill actual reader width, not a simulated viewport');
      assert.ok(sizes.body <= sizes.window, 'Responsive layout must not overflow the window');
      const preview = page.frames().find(frame => frame.url().includes('/pages/'));
      assert.ok(preview);
      assert.ok(Math.abs(await preview.evaluate(() => innerWidth) - sizes.frame) <= 1, 'Actual embedded site viewport must follow the reader');
    }
    await fits();
    const open = await page.locator('#open').getAttribute('href');
    assert.equal(open, plain.url);
    const opened = page.waitForEvent('popup');
    await page.locator('#open').click();
    const popup = await opened;
    await popup.waitForLoadState();
    assert.equal(popup.url(), plain.url);
    assert.ok((await popup.locator('body').innerText()).includes('普通子树图解'));
    await popup.close();
    await page.locator('#fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'stage');
    await fits();
    await page.locator('#exit-fullscreen').click();
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.screenshot({ path: '/tmp/ve-drag-desktop.png' });
    await page.setViewportSize({ width: 430, height: 860 });
    await fits();
    await page.locator('#nav-toggle').click();
    assert.equal(await page.locator('#library').getAttribute('aria-modal'), 'true');
    await folder(c).locator('.folder-name').click();
    await contextAction(folder(c), 'Folder API');
    await page.waitForFunction(() => !document.querySelector('#copy-api').disabled);
    assert.ok(!(await page.locator('#api-scope').innerText()).includes('top-level'), 'Nested anchor scope must not be described as top-level');
    assert.ok((await page.locator('#api-base').innerText()).endsWith(entity(c)));
    await page.locator('[data-close="api-dialog"]').click();
    await page.locator('#close-library').click();
    await page.screenshot({ path: '/tmp/ve-drag-narrow.png' });
    assert.equal(await api(originalVersion.url, { auth: null }), versionBytes);
    // The only new Key here was the explicit API-panel action, not any drag.
    const finalRegistry = JSON.parse(await readFile(join(dir, '.tokens.json'), 'utf8'));
    for (const previous of JSON.parse(registry).tokens) assert.deepEqual(finalRegistry.tokens.find(value => value.id === previous.id), previous);
    assert.deepEqual(errors, []);
    const finalTree = await api('/api/tree');
    await writeFile(checkpoint, JSON.stringify({ head: head(), tree: finalTree, keys,
      anchoredPage: anchored, oldParentVersion, version: originalVersion, versionBytes,
      pages: [
        { id: null, path: 'diagram.html', title: '拖动图解', page: diagram, compiled },
        { id: a, path: 'own.html', title: '原文件夹图解', page: own, compiled: await api(own.url, { auth: null }) },
        { id: b, path: 'dest/src/nested/plain.html', title: '普通子树图解', page: plain, compiled: await api(plain.url, { auth: null }) },
        { id: c, path: 'anchored.html', title: '锚定子树图解', page: anchored, compiled: await api(anchored.url, { auth: null }) },
      ] }), { mode: 0o600 });
    await context.close();
    console.log('PASS actual-pointer diagram cross-folder/cross-root/root, anchor nesting+unnesting, mixed subtree+promotion, collision/self/descendant/cancel/no-op, refresh race, stable Keys/URLs/history, current-scope denials, responsive preview/fullscreen/API');
  }
} catch (error) {
  console.error(String(error.stack ?? error).replaceAll(token, '[redacted]').replace(/ve_[A-Za-z0-9_-]{43}/g, '[redacted]'));
  process.exitCode = 1;
} finally { await browser.close(); }
