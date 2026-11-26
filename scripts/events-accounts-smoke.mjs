import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

assert.equal(process.env.VE_EVENTS_ACCOUNTS_SMOKE, '1', 'Run through scripts/events-accounts-check.sh');
const base = new URL(process.env.PUBLIC_URL);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const dataDir = process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data';
const adminToken = (await readFile(process.env.TOKEN_FILE ?? '/run/secrets/api_token', 'utf8')).trim();
const viewerKey = createHmac('sha256', adminToken).update('viewer-access').digest('hex');
const phase = process.env.VE_EVENTS_ACCOUNTS_PHASE || 'main';
const checkpointPath = join(dataDir, '.events-accounts-checkpoint.json');

async function req(path, { method = 'GET', token = adminToken, body, headers = {}, raw = false } = {}) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text, headers: res.headers };
}

function openSse(path, token) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, base);
    const events = [];
    const waiters = [];
    let buffer = '';
    const r = httpRequest(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`Expected 200 SSE, got ${res.statusCode}`));
        res.resume();
        return;
      }
      let connected = false;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (block.startsWith(': connected')) {
            if (!connected) {
              connected = true;
              resolve(handle);
            }
            continue;
          }
          if (block.startsWith(':')) continue;
          let id = '', event = '', dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) dataStr += (dataStr ? '\n' : '') + line.slice(6);
          }
          if (dataStr) {
            const parsed = { id, event, data: JSON.parse(dataStr) };
            events.push(parsed);
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].pred(parsed)) {
                const w = waiters.splice(i, 1)[0];
                clearTimeout(w.timer);
                w.resolve(parsed);
              }
            }
          }
        }
      });
    });
    const handle = {
      events,
      waitFor(pred, timeoutMs = 10000) {
        const hit = events.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((resWait, rejWait) => {
          const entry = {
            pred,
            resolve: resWait,
            timer: setTimeout(() => {
              const idx = waiters.indexOf(entry);
              if (idx >= 0) waiters.splice(idx, 1);
              rejWait(new Error('Timed out waiting for SSE event'));
            }, timeoutMs),
          };
          waiters.push(entry);
        });
      },
      close() {
        r.destroy();
      },
    };
    r.on('error', err => {
      if (!r.destroyed) reject(err);
    });
    r.end();
  });
}

if (phase === 'persistence') {
  const saved = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const ownerSession = await req('/api/session');
  assert.equal(ownerSession.status, 200);
  assert.equal(ownerSession.data.name, 'Lead Owner');
  const bobSession = await req('/api/session', { token: saved.bobSecret });
  assert.equal(bobSession.status, 200);
  assert.equal(bobSession.data.role, 'admin');
  assert.equal(bobSession.data.name, 'Bob');
  assert.equal((await req('/api/accounts', { token: saved.bobSecret })).status, 200);
  assert.equal((await req('/api/session', { token: saved.aliceSecret })).status, 401);

  const activeGuest = await fetch(saved.activeShareUrl);
  assert.equal(activeGuest.status, 200);
  assert.ok((await activeGuest.text()).includes('Events and Accounts Demo'));

  const expiredGuest = await fetch(saved.expiredShareUrl);
  assert.equal(expiredGuest.status, 410);
  assert.ok((await expiredGuest.text()).includes('expired'));

  console.log('PASS events/accounts/shares persistence across restart (renamed owner, admin account, deleted user denied, active share 200, expired share 410)');
  process.exit(0);
}

// 1. Setup folders and diagram
const folderA = (await req('/api/entities', { method: 'POST', body: { id: 'events-a', name: 'Events Alpha' } })).data.entity;
const folderB = (await req('/api/entities', { method: 'POST', body: { id: 'events-b', name: 'Events Beta' } })).data.entity;
const keyA = (await req(`/api/entities/${folderA.id}/tokens`, { method: 'POST', body: { expiresIn: 3600 } })).data.secret;
const keyB = (await req(`/api/entities/${folderB.id}/tokens`, { method: 'POST', body: { expiresIn: 3600 } })).data.secret;

const demoHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Events and Accounts Demo</title></head>
<body><main><h1>Events and Accounts Demo</h1><p id="p1">Latency target is 50ms.</p></main></body></html>`;

const pub = await req(`/api/entities/${folderA.id}/files/report.html`, {
  method: 'PUT', token: keyA, raw: true, body: demoHtml,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
});
assert.equal(pub.status, 201, pub.text);
const filename = pub.data.page.filename;

// 2. SSE + IP host deduplication + scope isolation + timeout + automatic comment.created
assert.equal((await req(`/api/entities/${folderA.id}/events`, { token: null })).status, 401);
assert.equal((await req(`/api/entities/${folderA.id}/events`, { token: keyB })).status, 403);
assert.equal((await req(`/api/entities/${folderA.id}/events?events=not.valid`, { token: keyA })).status, 400);

// Legacy viewer cannot subscribe to events
const viewerAccess = await fetch(new URL(`/?access=${viewerKey}`, base), { redirect: 'manual' });
const viewerCookie = viewerAccess.headers.get('set-cookie').split(';')[0];
assert.equal((await req(`/api/entities/${folderA.id}/events`, { token: null, headers: { Cookie: viewerCookie } })).status, 403);

// One-shot timeout returns 204
const timedOut = await req(`/api/entities/${folderA.id}/events?events=comment.dispatch&once=1&timeout=1&client=probe`, { token: keyA });
assert.equal(timedOut.status, 204);

const sse1 = await openSse(`/api/entities/${folderA.id}/events?path=report.html&client=runner-1`, keyA);
const sse2 = await openSse(`/api/entities/${folderA.id}/events?client=runner-2`, keyA);

try {
  const listeners = await req(`/api/pages/${encodeURIComponent(filename)}/listeners`);
  assert.equal(listeners.status, 200);
  assert.equal(listeners.data.listeners.hostCount, 1, 'Two connections from same IP must deduplicate to 1 host');
  assert.equal(listeners.data.listeners.connectionCount, 2);
  assert.deepEqual([...listeners.data.listeners.hosts[0].clients].sort(), ['runner-1', 'runner-2']);

  // Human comment triggers comment.created on SSE
  const c1 = await req(`/api/pages/${encodeURIComponent(filename)}/comments`, {
    method: 'POST', body: { body: 'Check the 50ms budget.' },
  });
  assert.equal(c1.status, 201);
  const createdEv = await sse1.waitFor(e => e.event === 'comment.created');
  assert.equal(createdEv.data.threadId, c1.data.thread.id);
  const beforeDispatchId = createdEv.id;

  // Accounts API rejects 'viewer' role
  const badRole = await req('/api/accounts', { method: 'POST', body: { name: 'Bad', role: 'viewer' } });
  assert.equal(badRole.status, 400);

  // 3. Real Chromium verification (SSE Send, Owner rename, Users dialog, User session, Guest Share links)
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const ownerCtx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    const ownerPage = await ownerCtx.newPage();
    const errors = [];
    ownerPage.on('pageerror', err => errors.push(err.message));

    await ownerPage.goto(base.href);
    await ownerPage.fill('#key', adminToken);
    await ownerPage.click('#login-submit');
    await ownerPage.waitForSelector('.report[aria-current="page"]');
    await ownerPage.waitForSelector('#preview:not([hidden])');

    // File API prompt includes SSE & ?once=1 documentation
    await ownerPage.click('#viewer-api');
    await ownerPage.waitForFunction(() => !document.querySelector('#copy-api').disabled);
    const payloadText = await ownerPage.locator('#api-payload').inputValue();
    assert.ok(payloadText.includes('/events?') && payloadText.includes('once=1'), 'Copied prompt must document /events SSE and ?once=1');
    await ownerPage.click('[data-close="api-dialog"]');

    // Open comments panel -> verify 1 host & Send button -> click Send with parallel ?once=1 listener
    await ownerPage.click('#comments-toggle');
    await ownerPage.waitForSelector('#comments-panel:not([hidden])');
    await ownerPage.waitForFunction(() => document.querySelector('#comments-hosts-text')?.textContent === '1 host');
    assert.equal(await ownerPage.locator('#comments-dispatch').isVisible(), true);

    const oncePromise = req(`/api/entities/${folderA.id}/events?path=report.html&events=comment.dispatch&once=1&timeout=15&client=oneshot`, { token: keyA });
    await new Promise(r => setTimeout(r, 120));
    await ownerPage.click('#comments-dispatch');

    const [onceRes, sse1Dispatch, sse2Dispatch] = await Promise.all([
      oncePromise,
      sse1.waitFor(e => e.event === 'comment.dispatch'),
      sse2.waitFor(e => e.event === 'comment.dispatch'),
    ]);
    assert.equal(onceRes.status, 200);
    assert.equal(onceRes.data.type, 'comment.dispatch');
    assert.equal(onceRes.data.openCount, 1);
    assert.ok(onceRes.data.summary.includes('Check the 50ms budget.'));
    assert.equal(sse1Dispatch.id, onceRes.data.id);
    assert.equal(sse2Dispatch.id, onceRes.data.id);

    // Replay with Last-Event-ID immediately returns the missed dispatch event
    const replay = await req(`/api/entities/${folderA.id}/events?events=comment.dispatch&once=1&timeout=5`, {
      token: keyA, headers: { 'Last-Event-ID': beforeDispatchId },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.id, onceRes.data.id);

    // Close SSE streams -> verify listeners count drops to 0
    sse1.close();
    sse2.close();
    await new Promise(r => setTimeout(r, 150));
    const afterClose = await req(`/api/pages/${encodeURIComponent(filename)}/listeners`);
    assert.equal(afterClose.data.listeners.hostCount, 0);
    assert.equal(afterClose.data.listeners.connectionCount, 0);

    // Owner self-rename via sidebar #account-self
    await ownerPage.click('#account-self');
    await ownerPage.waitForSelector('#rename-self-dialog[open]');
    await ownerPage.fill('#rename-self-input', 'Lead Owner');
    await ownerPage.click('#rename-self-submit');
    await ownerPage.waitForSelector('#rename-self-dialog', { state: 'hidden' });
    assert.equal(await ownerPage.locator('#account-self-name').innerText(), 'Lead Owner');
    assert.equal((await req('/api/session')).data.name, 'Lead Owner');

    // Admin Users dialog: verify ONLY User & Admin roles exist, create Alice (user) and Bob (admin)
    await ownerPage.click('#accounts-open');
    await ownerPage.waitForSelector('#accounts-dialog[open]');
    const roleOptions = await ownerPage.locator('#account-new-role option').evaluateAll(opts => opts.map(o => o.value));
    assert.deepEqual(roleOptions, ['user', 'admin'], 'Account roles must be strictly user and admin');

    await ownerPage.fill('#account-new-name', 'Alice');
    await ownerPage.selectOption('#account-new-role', 'user');
    await ownerPage.click('#account-create-submit');
    await ownerPage.waitForSelector('#account-created-box:not([hidden])');
    const aliceSecret = await ownerPage.locator('#account-created-secret').inputValue();
    assert.match(aliceSecret, /^ve_usr_/);

    await ownerPage.fill('#account-new-name', 'Bob');
    await ownerPage.selectOption('#account-new-role', 'admin');
    await ownerPage.click('#account-create-submit');
    await ownerPage.waitForFunction((prev) => document.querySelector('#account-created-secret')?.value !== prev, aliceSecret);
    const bobSecret = await ownerPage.locator('#account-created-secret').inputValue();
    assert.match(bobSecret, /^ve_usr_/);

    await ownerPage.click('[data-close="accounts-dialog"]');
    await ownerPage.waitForSelector('#accounts-dialog', { state: 'hidden' });
    await ownerPage.waitForFunction(() => document.querySelector('#account-created-secret')?.value === '');
    assert.equal(await ownerPage.locator('#account-created-secret').inputValue(), '', 'Secret must be cleared on dialog close');

    // Bob (admin) can access /api/accounts
    assert.equal((await req('/api/accounts', { token: bobSecret })).status, 200);

    // Alice (user) signs in via UI in a fresh context
    const aliceCtx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    const alicePage = await aliceCtx.newPage();
    alicePage.on('pageerror', err => errors.push(err.message));
    await alicePage.goto(base.href);
    await alicePage.fill('#key', aliceSecret);
    await alicePage.click('#login-submit');
    await alicePage.waitForSelector('.report[aria-current="page"]');

    // Alice sees shared Root, her name, NO Users button, denied /api/accounts (403)
    assert.equal(await alicePage.locator('#account-self-name').innerText(), 'Alice');
    assert.equal(await alicePage.locator('#accounts-open').isVisible(), false, 'User must not see Users management button');
    assert.equal(await alicePage.locator('#viewer-share').isVisible(), true);
    const aliceDeniedGet = await alicePage.evaluate(async () => (await fetch('/api/accounts')).status);
    const aliceDeniedPost = await alicePage.evaluate(async () => (await fetch('/api/accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X', role: 'user' }),
    })).status);
    assert.equal(aliceDeniedGet, 403);
    assert.equal(aliceDeniedPost, 403);

    // Alice can create a folder and post a comment (attributed to 'Alice')
    const aliceFolderStatus = await alicePage.evaluate(async () => (await fetch('/api/entities', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Alice Workspace' }),
    })).status);
    assert.equal(aliceFolderStatus, 201);

    await alicePage.click('#comments-toggle');
    await alicePage.waitForSelector('#comment-composer:not([hidden])');
    await alicePage.fill('#comment-input', 'Comment from Alice');
    await alicePage.click('#comment-submit');
    await alicePage.waitForFunction(() => [...document.querySelectorAll('.comment-body')].some(el => el.textContent === 'Comment from Alice'));
    const commentsAfterAlice = (await req(`/api/pages/${encodeURIComponent(filename)}/comments`)).data.threads;
    assert.equal(commentsAfterAlice.find(t => t.body === 'Comment from Alice').author.name, 'Alice');

    // Alice renames herself to 'Alice Wang' -> new comment uses 'Alice Wang'
    await alicePage.click('#account-self');
    await alicePage.waitForSelector('#rename-self-dialog[open]');
    await alicePage.fill('#rename-self-input', 'Alice Wang');
    await alicePage.click('#rename-self-submit');
    await alicePage.waitForSelector('#rename-self-dialog', { state: 'hidden' });
    assert.equal(await alicePage.locator('#account-self-name').innerText(), 'Alice Wang');
    await alicePage.fill('#comment-input', 'Second comment after rename');
    await alicePage.click('#comment-submit');
    await alicePage.waitForFunction(() => [...document.querySelectorAll('.comment-body')].some(el => el.textContent === 'Second comment after rename'));
    const commentsAfterRename = (await req(`/api/pages/${encodeURIComponent(filename)}/comments`)).data.threads;
    assert.equal(commentsAfterRename.find(t => t.body === 'Second comment after rename').author.name, 'Alice Wang');

    // Owner deletes Alice -> Alice's active session is immediately evicted (401)
    await ownerPage.click('#accounts-open');
    await ownerPage.waitForSelector('#accounts-dialog[open]');
    const aliceRow = ownerPage.locator('#accounts-list .mgmt-row', { hasText: 'Alice Wang' });
    await aliceRow.getByRole('button', { name: 'Delete' }).click();
    await aliceRow.waitFor({ state: 'detached' });
    await ownerPage.click('[data-close="accounts-dialog"]');

    assert.equal(await alicePage.evaluate(async () => (await fetch('/api/session')).status), 401);
    assert.equal(await alicePage.evaluate(async () => (await fetch('/api/tree')).status), 401);
    await aliceCtx.close();

    // 4. Single-page temporary guest share link via UI
    await ownerPage.click('#viewer-share');
    await ownerPage.waitForSelector('#share-dialog[open]');
    await ownerPage.fill('#share-label', 'Client preview');
    await ownerPage.click('#share-create-submit');
    await ownerPage.waitForSelector('#share-created-box:not([hidden])');
    const shareUrl = await ownerPage.locator('#share-created-url').inputValue();
    assert.match(shareUrl, /\/s\/[A-Za-z0-9_-]{43}$/);

    // Guest fetches /s/<token> without auth -> 200 HTML with sandbox CSP; /api/tree remains 401
    const guestRes = await fetch(shareUrl);
    assert.equal(guestRes.status, 200);
    assert.ok(guestRes.headers.get('content-security-policy').includes('sandbox allow-scripts'));
    assert.equal(guestRes.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(guestRes.headers.get('cache-control'), 'no-store');
    assert.ok((await guestRes.text()).includes('Events and Accounts Demo'));
    assert.equal((await fetch(shareUrl, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(new URL('/api/tree', base))).status, 401);

    // Revoke link in UI -> immediately returns 404
    const shareRow = ownerPage.locator('#share-list .mgmt-row', { hasText: 'Client preview' });
    await shareRow.getByRole('button', { name: 'Revoke' }).click();
    await shareRow.waitFor({ state: 'detached' });
    assert.equal((await fetch(shareUrl)).status, 404);
    await ownerPage.click('[data-close="share-dialog"]');

    // Deleting a page cleans up its share links -> 404
    const tempPub = await req(`/api/entities/${folderA.id}/files/disposable.html`, {
      method: 'PUT', token: keyA, raw: true, body: demoHtml,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
    assert.equal(tempPub.status, 201);
    const tempShare = await req(`/api/pages/${encodeURIComponent(tempPub.data.page.filename)}/shares`, {
      method: 'POST', body: { expiresIn: 3600, label: 'Temp' },
    });
    assert.equal(tempShare.status, 201);
    assert.equal((await fetch(tempShare.data.url)).status, 200);
    assert.equal((await req(`/api/pages/${encodeURIComponent(tempPub.data.page.filename)}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(tempShare.data.url)).status, 404);

    // Prepare active + expired shares for restart persistence phase (410 test)
    const activeShare = await req(`/api/pages/${encodeURIComponent(filename)}/shares`, {
      method: 'POST', body: { expiresIn: 86400, label: 'Persisted' },
    });
    const expiredShare = await req(`/api/pages/${encodeURIComponent(filename)}/shares`, {
      method: 'POST', body: { expiresIn: 3600, label: 'Expired' },
    });
    const sharesStorePath = join(dataDir, '.shares.json');
    const store = JSON.parse(await readFile(sharesStorePath, 'utf8'));
    const expEntry = store.shares.find(s => s.id === expiredShare.data.share.id);
    assert.ok(expEntry);
    expEntry.expiresAt = new Date(Date.now() - 60000).toISOString();
    await writeFile(sharesStorePath, JSON.stringify(store) + '\n', { mode: 0o600 });

    await writeFile(checkpointPath, JSON.stringify({
      bobSecret,
      aliceSecret,
      activeShareUrl: activeShare.data.url,
      expiredShareUrl: expiredShare.data.url,
    }), { mode: 0o600 });

    assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
    await ownerCtx.close();
    console.log('PASS events/accounts/shares E2E: SSE + ?once=1 + replay + IP dedup + Send UI + admin/user accounts (no viewer) + self-rename + delete eviction + guest /s/:token 200/404');
  } finally {
    await browser.close();
  }
} finally {
  sse1.close();
  sse2.close();
}
