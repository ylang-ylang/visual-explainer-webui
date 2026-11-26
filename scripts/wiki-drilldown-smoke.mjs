// Focused Wave 2 Wiki drill-down, page-as-parent tree, summary & thumbnail E2E check.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

assert.equal(process.env.VE_WIKI_SMOKE, '1', 'Use scripts/wiki-drilldown-check.sh');
const base = new URL(process.env.PUBLIC_URL);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const dir = process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data';
const token = (await readFile(process.env.TOKEN_FILE ?? '/run/secrets/api_token', 'utf8')).trim();
const checkpoint = join(dir, '.wiki-checkpoint.json');
const archId = 'wiki-arch';
const otherId = 'wiki-other';
const fileRoute = (id, path) => `/api/entities/${id}/files/${path.split('/').map(encodeURIComponent).join('/')}`;

async function api(path, { method = 'GET', body, raw, auth = token, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(raw !== undefined ? { 'Content-Type': 'text/html; charset=utf-8' } : body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
  if (status === 204) return null;
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) return response.json();
  if (ct.includes('image/png')) return Buffer.from(await response.arrayBuffer());
  return response.text();
}

const systemHtml = `<!doctype html>
<html lang="en" data-register="blueprint">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="End-to-end ingress, transactional ordering, and durable storage topology across edge and core VPC.">
  <title>System Architecture</title>
  <link rel="stylesheet" href="kit.css" data-ve-kit>
  <style>
    .ve-stage-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin: 18px 0 20px; }
    .ve-stage-wrap svg { width: 100%; height: auto; display: block; overflow: visible; }
    .n-box { fill: var(--node-top, var(--surface)); stroke: var(--border-bright, var(--border)); stroke-width: 1.4; }
    .n-title { font: 600 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: var(--text); text-anchor: start; }
    .n-sub { font: 400 11.5px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: var(--text-dim); text-anchor: start; }
    .n-kicker { font: 600 10px/1.2 ui-monospace, monospace; fill: var(--text-dim); letter-spacing: .05em; text-transform: uppercase; text-anchor: start; }
    .n-edge { fill: none; stroke: var(--border-bright, #7c879b); stroke-width: 1.5; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Overview · Production Request Path</p>
      <h1>System Architecture</h1>
      <p class="lead">High-level request lifecycle from edge clients through ingress controls, transactional ordering, and durable storage.</p>
    </header>
    <figure>
      <div class="ve-stage-wrap">
        <svg viewBox="0 0 840 190" role="img" aria-label="System Architecture">
          <g id="node-edge">
            <rect class="n-box" x="14" y="42" width="160" height="98" rx="8"/>
            <text class="n-kicker" x="28" y="64">CLIENT</text>
            <text class="n-title" x="28" y="88">Edge Clients</text>
            <text class="n-sub" x="28" y="110">Web, SDK &amp; Mobile</text>
          </g>
          <path class="n-edge" d="M174 91 H224"/>
          <g id="node-gateway" class="ve-n" data-ve-child="api-gateway">
            <rect class="n-box" x="224" y="42" width="194" height="98" rx="8"/>
            <text class="n-kicker" x="238" y="64">INGRESS</text>
            <text class="n-title" x="238" y="88">API Gateway</text>
            <text class="n-sub" x="238" y="110">TLS, JWT &amp; Rate Limits</text>
          </g>
          <path class="n-edge" d="M418 91 H468"/>
          <g id="node-orders" class="ve-n" data-ve-child="order-engine">
            <rect class="n-box" x="468" y="42" width="194" height="98" rx="8"/>
            <text class="n-kicker" x="482" y="64">CORE</text>
            <text class="n-title" x="482" y="88">Order Engine</text>
            <text class="n-sub" x="482" y="110">Idempotent Saga State</text>
          </g>
          <path class="n-edge" d="M662 91 H706"/>
          <g id="node-wal">
            <rect class="n-box" x="706" y="42" width="120" height="98" rx="8"/>
            <text class="n-kicker" x="720" y="64">STORAGE</text>
            <text class="n-title" x="720" y="88">WAL Log</text>
            <text class="n-sub" x="720" y="110">Raft Quorum</text>
          </g>
        </svg>
      </div>
      <figcaption>Click stacked nodes or inline diagram portals to drill down into subsystem internals.</figcaption>
    </figure>
    <p>All external traffic enters through <span id="chip-gateway" data-ve-child="api-gateway">API Gateway</span> before reaching <span id="chip-orders" data-ve-child="order-engine">Order Engine</span> for transactional settlement.</p>
  </main>
</body>
</html>`;

const gatewayHtml = `<!doctype html>
<html lang="en" data-register="blueprint">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Edge ingress pipeline enforcing TLS termination, JWT verification, and per-tenant token-bucket quotas.">
  <title>API Gateway</title>
  <link rel="stylesheet" href="kit.css" data-ve-kit>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Ingress · Edge Controls</p>
      <h1>API Gateway</h1>
      <p class="lead">Edge ingress pipeline handling TLS termination, JWT validation, and tenant quotas.</p>
    </header>
    <figure>
      <ve-flow label="Ingress flow from TLS termination through JWT check and Redis rate limiting.">
        <ve-node id="tls" at="1 1" key>TLS Edge</ve-node>
        <ve-node id="jwt" at="2 1">JWT Verifier</ve-node>
        <ve-node id="quota" at="3 1">Token Bucket</ve-node>
        <ve-edge from="tls" to="jwt" label="mTLS"/>
        <ve-edge from="jwt" to="quota" label="claims" hot/>
      </ve-flow>
      <figcaption>Every request passes JWT verification before hitting the atomic Redis token-bucket limiter.</figcaption>
    </figure>
    <p>Quota accounting is detailed in <span id="chip-bucket" data-ve-child="token-bucket">Token Bucket</span>.</p>
  </main>
</body>
</html>`;

const bucketHtml = `<!doctype html>
<html lang="en" data-register="blueprint">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Atomic Redis Lua token-bucket limiter with burst capacity and smooth refill window.">
  <title>Token Bucket</title>
  <link rel="stylesheet" href="kit.css" data-ve-kit>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Rate Limiting · Redis Lua</p>
      <h1>Token Bucket</h1>
      <p class="lead">Atomic Redis Lua script enforcing per-tenant burst and sustained QPS.</p>
    </header>
    <figure>
      <ve-flow label="Atomic Redis Lua check and decrement.">
        <ve-node id="req" at="1 1" key>Request</ve-node>
        <ve-node id="lua" at="2 1">EVALSHA Lua</ve-node>
        <ve-edge from="req" to="lua" label="key + cost" hot/>
      </ve-flow>
      <figcaption>Single round-trip atomic token deduction in Redis.</figcaption>
    </figure>
  </main>
</body>
</html>`;

const ordersHtml = `<!doctype html>
<html lang="en" data-register="blueprint">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Transactional order state machine with idempotency keys and outbox dispatch.">
  <title>Order Engine</title>
  <link rel="stylesheet" href="kit.css" data-ve-kit>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Core · Saga Execution</p>
      <h1>Order Engine</h1>
      <p class="lead">Idempotent order state machine coordinating inventory and payment steps.</p>
    </header>
    <figure>
      <ve-flow label="Order saga state transitions.">
        <ve-node id="create" at="1 1" key>Create Order</ve-node>
        <ve-node id="outbox" at="2 1">Outbox Relay</ve-node>
        <ve-edge from="create" to="outbox" label="tx commit" hot/>
      </ve-flow>
      <figcaption>Outbox events are persisted in the same transaction as order state changes.</figcaption>
    </figure>
  </main>
</body>
</html>`;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  if (process.env.VE_WIKI_PHASE === 'persistence') {
    const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
    const tree = await api('/api/tree');
    const gw = tree.pages.find(p => p.filename === saved.gatewayFilename);
    assert.ok(gw, 'Gateway page must persist across restart');
    assert.ok(gw.summary.includes('TLS termination'), 'Summary must persist across restart');
    assert.ok(gw.thumbUrl && gw.thumbUrl.includes('/thumb?v='), 'Thumbnail URL must persist across restart');
    const png = await api(gw.thumbUrl);
    assert.equal(png.subarray(0, 4).toString('hex'), '89504e47', 'Light thumbnail must remain valid PNG after restart');
    const darkPng = await api(`${gw.thumbUrl}&theme=dark`);
    assert.equal(darkPng.subarray(0, 4).toString('hex'), '89504e47', 'Dark thumbnail must remain valid PNG after restart');
    assert.equal(Buffer.compare(png, darkPng) !== 0, true, 'Dark thumbnail must remain distinct from Light thumbnail after restart');
    await api(`/api/pages/${encodeURIComponent(saved.deletedFilename)}/thumb`, { status: 404 });
    await api(`/api/pages/${encodeURIComponent(saved.deletedFilename)}/thumb?theme=dark`, { status: 404 });
    await rm(checkpoint);
    console.log('PASS wiki drill-down persistence: summary, light/dark thumbnails, and deletion cleanup survived restart');
  } else {
    await api('/api/entities', { method: 'POST', body: { id: archId, name: 'Architecture' }, status: 201 });
    await api('/api/entities', { method: 'POST', body: { id: otherId, name: 'Other' }, status: 201 });
    const archKey = (await api(`/api/entities/${archId}/tokens`, { method: 'POST', body: {}, status: 201 })).secret;
    const otherKey = (await api(`/api/entities/${otherId}/tokens`, { method: 'POST', body: {}, status: 201 })).secret;

    const sys = await api(fileRoute(archId, 'system.html'), { method: 'PUT', raw: systemHtml, status: 201 });
    const gw = await api(fileRoute(archId, 'system/api-gateway.html'), { method: 'PUT', raw: gatewayHtml, status: 201 });
    const bucket = await api(fileRoute(archId, 'system/api-gateway/token-bucket.html'), { method: 'PUT', raw: bucketHtml, status: 201 });
    const orders = await api(fileRoute(archId, 'system/order-engine.html'), { method: 'PUT', raw: ordersHtml, status: 201 });

    // 1. Verify summary extraction & single-viewport Light/Dark PNG thumbnails + RBAC + Git hygiene.
    assert.equal(sys.page.summary, 'End-to-end ingress, transactional ordering, and durable storage topology across edge and core VPC.');
    assert.equal(gw.page.summary, 'Edge ingress pipeline enforcing TLS termination, JWT verification, and per-tenant token-bucket quotas.');
    assert.ok(gw.page.thumbUrl && gw.page.thumbUrl.startsWith(`/api/pages/${encodeURIComponent(gw.page.filename)}/thumb?v=`), `Expected thumbUrl on kit page, got: ${JSON.stringify(gw.page)}`);
    const thumbBytes = await api(gw.page.thumbUrl);
    assert.equal(thumbBytes.subarray(0, 4).toString('hex'), '89504e47', 'Light thumbnail must be a valid PNG');
    const darkThumbBytes = await api(`${gw.page.thumbUrl}&theme=dark`);
    assert.equal(darkThumbBytes.subarray(0, 4).toString('hex'), '89504e47', 'Dark thumbnail must be a valid PNG');
    assert.equal(Buffer.compare(thumbBytes, darkThumbBytes) !== 0, true, 'Dual-theme kit page must produce distinct Light and Dark thumbnails');
    const scopedThumb = await api(gw.page.thumbUrl, { auth: archKey });
    assert.equal(scopedThumb.subarray(0, 4).toString('hex'), '89504e47', 'Scoped folder agent can read own thumbnail');
    const scopedDarkThumb = await api(`${gw.page.thumbUrl}&theme=dark`, { auth: archKey });
    assert.equal(scopedDarkThumb.subarray(0, 4).toString('hex'), '89504e47', 'Scoped folder agent can read own dark thumbnail');
    await api(gw.page.thumbUrl, { auth: otherKey, status: 403 });
    await api(`${gw.page.thumbUrl}&theme=dark`, { auth: otherKey, status: 403 });
    await api(gw.page.thumbUrl, { auth: null, status: 401 });
    await api(`${gw.page.thumbUrl}&theme=dark`, { auth: null, status: 401 });
    const gitFiles = execFileSync('git', [`--git-dir=${join(dir, '.git')}`, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.ok(!gitFiles.includes('.thumb.png') && !gitFiles.includes('.thumb-dark.png'), 'Thumbnails must never enter Git history');

    // 2. Verify browser UI: Feishu-Wiki page-as-parent tree, New child page, hover popover, click drill-down, breadcrumb & Esc.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    let loggedIn = false;
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => { if (loggedIn && msg.type() === 'error') errors.push(msg.text()); });

    await page.goto(base.href);
    await page.locator('#key').fill(token);
    await page.locator('#login-submit').click();
    await page.locator('#login').waitFor({ state: 'hidden' });
    const settled = () => page.waitForFunction(() => !pageRequest && document.documentElement.dataset.sync === 'ready');
    await settled();
    loggedIn = true;

    // Sidebar merges system.html + system/ into a .wiki-branch!
    const sysBranch = page.locator(`.wiki-branch[data-entity-id="${archId}"][data-path="system"]`);
    assert.equal(await sysBranch.count(), 1, 'system.html + system/ must merge into one Wiki parent branch');
    assert.equal(await page.locator(`.folder[data-entity-id="${archId}"][data-path="system"]`).count(), 0, 'Merged folder must not render twice');
    assert.equal(await sysBranch.locator(`> .wiki-parent-row > .report[data-filename="${sys.page.filename}"]`).count(), 1);
    assert.equal(await sysBranch.locator(`> .wiki-parent-row > .report .wiki-count`).innerText(), '3');
    // Nested Wiki parent: api-gateway + api-gateway/
    const gwBranch = sysBranch.locator(`.wiki-branch[data-entity-id="${archId}"][data-path="system/api-gateway"]`);
    assert.equal(await gwBranch.count(), 1, 'api-gateway.html + api-gateway/ must merge recursively');
    assert.equal(await gwBranch.locator(`.report[data-filename="${bucket.page.filename}"]`).count(), 1);

    // Chevron collapses/expands children without changing selection.
    await page.locator(`.report[data-filename="${sys.page.filename}"]`).click();
    await page.waitForFunction(() => !document.querySelector('#preview').hidden);
    await sysBranch.locator('> .wiki-parent-row > .wiki-chevron').click();
    assert.equal(await sysBranch.getAttribute('data-open'), 'false');
    assert.equal(await sysBranch.locator('> .wiki-children').isVisible(), false);
    await sysBranch.locator('> .wiki-parent-row > .wiki-chevron').click();
    assert.equal(await sysBranch.getAttribute('data-open'), 'true');
    assert.equal(await sysBranch.locator('> .wiki-children').isVisible(), true);

    // Right-click a page -> New child page creates a nested child under <stem>/.
    await page.locator(`.report[data-filename="${orders.page.filename}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New child page', exact: true }).click();
    assert.equal(await page.locator('#new-page-title').innerText(), 'New child page');
    assert.ok((await page.locator('#new-page-location').innerText()).includes('system/order-engine'));
    await page.locator('#new-page-name').fill('saga-log');
    await page.locator('#new-page-submit').click();
    await page.locator('#new-page-dialog').waitFor({ state: 'hidden' });
    await settled();
    const sagaPage = (await api('/api/tree')).pages.find(p => p.path === 'system/order-engine/saga-log.html');
    assert.ok(sagaPage, 'New child page must create page under <stem>/');
    assert.ok(sagaPage.thumbUrl, 'Plain HTML starter page must also generate single-viewport thumbnails');
    assert.equal(await page.locator(`.wiki-branch[data-entity-id="${archId}"][data-path="system/order-engine"]`).count(), 1);

    // Republish saga-log as a kit page, then verify Light/Dark thumbnails + delete cleanup.
    const sagaKit = await api(fileRoute(archId, 'system/order-engine/saga-log.html'), { method: 'PUT', raw: bucketHtml.replace('Token Bucket', 'Saga Log') });
    assert.ok(sagaKit.page.thumbUrl, 'Kit republish must generate thumbnail');
    const sagaThumbUrl = `/api/pages/${encodeURIComponent(sagaPage.filename)}/thumb`;
    const sagaThumbBefore = await api(sagaThumbUrl);
    assert.equal(sagaThumbBefore.subarray(0, 4).toString('hex'), '89504e47');
    const sagaDarkThumbBefore = await api(`${sagaThumbUrl}?theme=dark`);
    assert.equal(sagaDarkThumbBefore.subarray(0, 4).toString('hex'), '89504e47');

    // Navigate back to System Architecture to test drill-down portals, hover popover & child strip.
    await page.locator(`.report[data-filename="${sys.page.filename}"]`).click();
    await page.waitForFunction(() => !document.querySelector('#preview').hidden);
    await page.locator('#wiki-children-bar').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#wiki-children-bar .wiki-child-chip').count(), 2);

    const frame = page.frameLocator('#preview');
    await frame.locator('#node-gateway.ve-drill-node').waitFor();
    await frame.locator('#chip-gateway.ve-drill-chip').waitFor();
    await frame.locator('.ve-drill-badge').first().waitFor({ state: 'visible' });

    // Hover SVG node -> #wiki-popover appears with title, summary & loaded PNG thumbnail!
    await page.evaluate(() => applyTheme('light', true));
    await frame.locator('#node-gateway').hover();
    await page.locator('#wiki-popover').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#wiki-popover-title').innerText(), 'API Gateway');
    assert.ok((await page.locator('#wiki-popover-summary').innerText()).includes('TLS termination'));
    await page.waitForFunction(() => {
      const img = document.getElementById('wiki-popover-thumb');
      return img && !document.getElementById('wiki-popover-thumb-wrap').hidden && img.getAttribute('src')?.includes('theme=light') && img.complete && img.naturalWidth > 0;
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: '/tmp/ve-wiki-light.png' });

    // Capture Dark mode screenshot too (with theme=dark thumbnail loaded)!
    await page.evaluate(() => applyTheme('dark', true));
    await frame.locator('#node-edge').hover();
    await frame.locator('#node-gateway').hover();
    await page.locator('#wiki-popover').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const img = document.getElementById('wiki-popover-thumb');
      return img && !document.getElementById('wiki-popover-thumb-wrap').hidden && img.getAttribute('src')?.includes('theme=dark') && img.complete && img.naturalWidth > 0;
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: '/tmp/ve-wiki-dark.png' });
    await page.evaluate(() => applyTheme('light', true));

    // Click SVG drill-down node -> navigates to API Gateway, updates breadcrumb & Up button.
    await frame.locator('#node-gateway').click();
    await page.waitForFunction(() => document.getElementById('page-title')?.textContent === 'API Gateway');
    await page.waitForFunction(() => !document.querySelector('#preview').hidden);
    assert.equal(await page.locator('#wiki-popover').isVisible(), false);
    assert.equal(await page.locator('#wiki-up').isVisible(), true);
    assert.equal(await page.locator('#page-meta .crumb-link').first().innerText(), 'system');
    await page.locator('#wiki-children-bar .wiki-child-chip').filter({ hasText: 'Token Bucket' }).waitFor();

    // Click ancestor breadcrumb -> returns to System Architecture.
    await page.locator('#page-meta .crumb-link').first().click();
    await page.waitForFunction(() => document.getElementById('page-title')?.textContent === 'System Architecture');
    await page.waitForFunction(() => !document.querySelector('#preview').hidden);

    // Click inline chip -> navigates to API Gateway, then Escape navigates back up to System Architecture!
    await frame.locator('#chip-gateway.ve-drill-chip').waitFor();
    await frame.locator('#chip-gateway').click();
    await page.waitForFunction(() => document.getElementById('page-title')?.textContent === 'API Gateway');
    await page.waitForFunction(() => !document.querySelector('#preview').hidden);
    await page.locator('#page-title').focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('page-title')?.textContent === 'System Architecture');

    // Verify viewer session can also read thumbnails (viewer cookie).
    const access = createHmac('sha256', token).update('viewer-access').digest('hex');
    const vCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const vPage = await vCtx.newPage();
    await vPage.goto(new URL('/?access=' + access, base).href);
    await vPage.waitForFunction(() => document.documentElement.dataset.sync === 'ready');
    const vThumbStatus = await vPage.evaluate(async url => (await fetch(url)).status, gw.page.thumbUrl);
    assert.equal(vThumbStatus, 200, 'Viewer cookie should load thumbnails');
    await vCtx.close();

    // Deleting saga-log must remove both Light and Dark thumbnails (404).
    await api(`/api/pages/${encodeURIComponent(sagaPage.filename)}`, { method: 'DELETE', status: 204 });
    await api(sagaThumbUrl, { status: 404 });
    await api(`${sagaThumbUrl}?theme=dark`, { status: 404 });

    // Moving/renaming a Wiki parent page must carry its entire child subtree atomically!
    const catalogBeforeRejected = await readFile(join(dir, '.entities.json'), 'utf8');
    await api(`/api/pages/${encodeURIComponent(sys.page.filename)}`, { method: 'PATCH', body: { entityId: null, path: 'system.html' }, status: 409 });
    await api('/api/moves', { method: 'POST', body: { source: { kind: 'page', filename: sys.page.filename }, destination: { entityId: null, path: '' } }, status: 409 });
    await api(`/api/pages/${encodeURIComponent(sys.page.filename)}`, { method: 'PATCH', body: { entityId: archId, path: 'system/system.html' }, status: 409 });
    await api('/api/moves', { method: 'POST', body: { source: { kind: 'page', filename: sys.page.filename }, destination: { entityId: archId, path: 'system/api-gateway' } }, status: 409 });
    assert.equal(await readFile(join(dir, '.entities.json'), 'utf8'), catalogBeforeRejected, 'Rejected Wiki parent moves must leave catalog bytes unchanged');

    // Rename system.html -> platform.html
    await api(`/api/pages/${encodeURIComponent(sys.page.filename)}`, { method: 'PATCH', body: { entityId: archId, path: 'platform.html' } });
    let afterRename = await api('/api/tree');
    assert.equal(afterRename.pages.find(p => p.filename === sys.page.filename).path, 'platform.html');
    assert.equal(afterRename.pages.find(p => p.filename === gw.page.filename).path, 'platform/api-gateway.html');
    assert.equal(afterRename.pages.find(p => p.filename === bucket.page.filename).path, 'platform/api-gateway/token-bucket.html');
    assert.equal(afterRename.pages.find(p => p.filename === orders.page.filename).path, 'platform/order-engine.html');
    assert.equal(afterRename.pages.find(p => p.filename === gw.page.filename).url, gw.page.url);

    // Move platform.html across folders via POST /api/moves -> carries all children, URLs & thumbnails
    await api('/api/moves', { method: 'POST', body: { source: { kind: 'page', filename: sys.page.filename }, destination: { entityId: otherId, path: '' } } });
    let afterMove = await api('/api/tree');
    const movedSys = afterMove.pages.find(p => p.filename === sys.page.filename);
    const movedGw = afterMove.pages.find(p => p.filename === gw.page.filename);
    const movedBucket = afterMove.pages.find(p => p.filename === bucket.page.filename);
    assert.equal(movedSys.entityId, otherId);
    assert.equal(movedSys.path, 'platform.html');
    assert.equal(movedGw.entityId, otherId);
    assert.equal(movedGw.path, 'platform/api-gateway.html');
    assert.equal(movedGw.url, gw.page.url);
    assert.equal(movedBucket.entityId, otherId);
    assert.equal(movedBucket.path, 'platform/api-gateway/token-bucket.html');
    assert.equal((await api(movedGw.thumbUrl)).subarray(0, 4).toString('hex'), '89504e47');
    assert.equal((await api(`${movedGw.thumbUrl}&theme=dark`)).subarray(0, 4).toString('hex'), '89504e47');

    assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join('; ')}`);
    await writeFile(checkpoint, JSON.stringify({ gatewayFilename: gw.page.filename, deletedFilename: sagaPage.filename }), { mode: 0o600 });
    await context.close();
    console.log('PASS wiki drill-down: page-as-parent tree, New child page, summaries, Light/Dark PNG thumbnails, hover popover, SVG & chip drill-down, breadcrumb, Esc up, atomic Wiki parent move/rename, and delete cleanup');
  }
} catch (error) {
  console.error(String(error.stack ?? error).replaceAll(token, '[redacted]'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
