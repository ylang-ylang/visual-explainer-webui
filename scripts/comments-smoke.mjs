import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

assert.equal(process.env.VE_COMMENTS_SMOKE, '1', 'Run through scripts/comments-check.sh');
const base = new URL(process.env.PUBLIC_URL);
const adminToken = (await readFile(process.env.TOKEN_FILE, 'utf8')).trim();
const viewerKey = createHmac('sha256', adminToken).update('viewer-access').digest('hex');
const phase = process.env.VE_COMMENTS_PHASE || 'main';

async function req(path, { method = 'GET', token = adminToken, body, headers = {}, raw = false } = {}) {
  const opts = {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
  };
  const res = await fetch(new URL(path, base), opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text };
}

if (phase === 'persistence') {
  const tree = await req('/api/tree');
  assert.equal(tree.status, 200);
  const page = tree.data.pages.find(p => p.path === 'raft/architecture.html');
  assert.ok(page, 'Page must survive restart');
  const comments = await req(`/api/pages/${encodeURIComponent(page.filename)}/comments`);
  assert.equal(comments.status, 200);
  assert.ok(comments.data.counts.total >= 2, 'Comments must persist across restart');
  assert.equal(comments.data.counts.open, page.openComments, 'Open comment count matches persisted threads');
  console.log('PASS comments persistence across restart');
  process.exit(0);
}

// 1. Setup two folders with scoped keys
const own = (await req('/api/entities', { method: 'POST', body: { name: 'Raft Demo' } })).data.entity;
const other = (await req('/api/entities', { method: 'POST', body: { name: 'Other Scope' } })).data.entity;
const ownKey = (await req(`/api/entities/${own.id}/tokens`, { method: 'POST', body: { expiresIn: 3600 } })).data.secret;
const otherKey = (await req(`/api/entities/${other.id}/tokens`, { method: 'POST', body: { expiresIn: 3600 } })).data.secret;

const kitV1 = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Raft Style Demo</title>
  <link rel="stylesheet" href="kit.css" data-ve-kit>
</head>
<body>
  <main>
    <h1>Raft 架构图解</h1>
    <section id="sec-flow">
      <h2>数据流设计</h2>
      <p id="p-latency">当前请求延迟统计为 P95 120ms，需要核对真实指标。</p>
      <figure id="fig-arch"><div class="ve-n" id="node-gateway" data-ref="Gateway">API Gateway</div></figure>
    </section>
  </main>
</body>
</html>`;

// 2. Publish v1 via scoped folder key with note
const pub1 = await req(`/api/entities/${own.id}/files/raft/architecture.html?note=${encodeURIComponent('Initial draft')}`, {
  method: 'PUT', token: ownKey, raw: true, body: kitV1,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
});
assert.equal(pub1.status, 201, pub1.text);
assert.equal(pub1.data.version.number, 1);
assert.equal(pub1.data.version.label, 'v1');
assert.equal(pub1.data.version.note, 'Initial draft');
assert.deepEqual(pub1.data.openComments, []);
assert.ok(pub1.data.commentsUrl.endsWith(`/api/pages/${encodeURIComponent(pub1.data.page.filename)}/comments`));
const filename = pub1.data.page.filename;

// Standalone URL (no ?embed=1) must remain clean unmodified HTML without bridge script
const standalone = await fetch(pub1.data.page.url);
assert.equal(standalone.status, 200);
const standaloneHtml = await standalone.text();
assert.ok(!standaloneHtml.includes('data-ve-raft-bridge'), 'Standalone HTML must not inject embed bridge');

// 3. Create comments via API, verify scoped access & auth boundaries
const c1 = await req(`/api/pages/${encodeURIComponent(filename)}/comments`, {
  method: 'POST',
  body: {
    body: '请把 P95 改成 P99 实际数据',
    where: { kind: 'text', quote: '当前请求延迟统计为 P95 120ms', selector: '#p-latency', tag: 'p', headings: ['Raft 架构图解', '数据流设计'] },
  },
});
assert.equal(c1.status, 201, c1.text);
assert.equal(c1.data.thread.id, 'c_1');
assert.equal(c1.data.thread.status, 'open');
assert.equal(c1.data.thread.version, 1);

// Agent reads open comments via entity convenience route (both with ?path and folder-wide)
const byPath = await req(`/api/entities/${own.id}/comments?path=${encodeURIComponent('raft/architecture.html')}&status=open`, { token: ownKey });
assert.equal(byPath.status, 200);
assert.equal(byPath.data.threads.length, 1);
assert.equal(byPath.data.threads[0].id, 'c_1');
assert.ok(byPath.data.summary.includes('[c_1] status=open · v1'));
assert.ok(byPath.data.summary.includes('#p-latency'));

const folderWide = await req(`/api/entities/${own.id}/comments?status=open`, { token: ownKey });
assert.equal(folderWide.status, 200);
assert.equal(folderWide.data.counts.open, 1);
assert.equal(folderWide.data.items.length, 1);

// Cross-folder agent key is denied everywhere
assert.equal((await req(`/api/pages/${encodeURIComponent(filename)}/comments`, { token: otherKey })).status, 403);
assert.equal((await req(`/api/pages/${encodeURIComponent(filename)}/comments`, { method: 'POST', token: otherKey, body: { body: 'nope' } })).status, 403);
assert.equal((await req(`/api/pages/${encodeURIComponent(filename)}/comments/c_1/resolve`, { method: 'POST', token: otherKey, body: {} })).status, 403);
assert.equal((await req(`/api/entities/${other.id}/comments/c_1/resolve`, { method: 'POST', token: otherKey, body: {} })).status, 403);

// Agent cannot edit or delete comments
assert.equal((await req(`/api/pages/${encodeURIComponent(filename)}/comments/c_1`, { method: 'PATCH', token: ownKey, body: { body: 'hack' } })).status, 403);
assert.equal((await req(`/api/pages/${encodeURIComponent(filename)}/comments/c_1`, { method: 'DELETE', token: ownKey })).status, 403);

// 4. Publish v2 with note, verify openComments returned in PUT response
const kitV2 = kitV1.replace('P95 120ms', 'P99 185ms');
const pub2 = await req(`/api/entities/${own.id}/files/raft/architecture.html?note=${encodeURIComponent('Switched latency to P99')}`, {
  method: 'PUT', token: ownKey, raw: true, body: kitV2,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
});
assert.equal(pub2.status, 200);
assert.equal(pub2.data.version.number, 2);
assert.equal(pub2.data.version.label, 'v2');
assert.equal(pub2.data.version.note, 'Switched latency to P99');
assert.equal(pub2.data.openComments.length, 1);
assert.equal(pub2.data.openComments[0].id, 'c_1');

// Agent resolves c_1 with a note via entity route, then repeats resolve (idempotent)
const res1 = await req(`/api/entities/${own.id}/comments/c_1/resolve`, {
  method: 'POST', token: ownKey, body: { note: 'Done in v2: updated to P99 185ms' },
});
assert.equal(res1.status, 200, res1.text);
assert.equal(res1.data.changed, true);
assert.equal(res1.data.thread.status, 'resolved');
assert.equal(res1.data.thread.replies.length, 1);
assert.equal(res1.data.thread.resolvedBy.role, 'agent');

const res2 = await req(`/api/pages/${encodeURIComponent(filename)}/comments/c_1/resolve`, {
  method: 'POST', token: ownKey, body: { note: 'Should not duplicate' },
});
assert.equal(res2.status, 200);
assert.equal(res2.data.changed, false);
assert.equal(res2.data.thread.replies.length, 1, 'Idempotent resolve must not duplicate note');

// Reply to resolved thread automatically reopens it (exact Raft rule)
const autoReopen = await req(`/api/pages/${encodeURIComponent(filename)}/comments`, {
  method: 'POST', body: { replyTo: 'c_1', body: '请再补上 P50 对比' },
});
assert.equal(autoReopen.status, 201);
assert.equal(autoReopen.data.reopened, true);
assert.equal(autoReopen.data.thread.status, 'open');
assert.equal(autoReopen.data.thread.resolvedAt, null);

// Resolve again, then explicit reopen
assert.equal((await req(`/api/pages/${encodeURIComponent(filename)}/comments/c_1/resolve`, { method: 'POST', token: ownKey, body: {} })).data.thread.status, 'resolved');
const reopened = await req(`/api/pages/${encodeURIComponent(filename)}/comments/c_1/reopen`, { method: 'POST', token: ownKey });
assert.equal(reopened.status, 200);
assert.equal(reopened.data.changed, true);
assert.equal(reopened.data.thread.status, 'open');

// Versions API by vN and restore by version
const vers = await req(`/api/entities/${own.id}/versions?path=${encodeURIComponent('raft/architecture.html')}`, { token: ownKey });
assert.equal(vers.status, 200);
assert.deepEqual(vers.data.versions.map(v => v.label), ['v2', 'v1']);
assert.equal(vers.data.versions[1].commentCounts.open, 1);
const v1Source = await req(`/api/pages/${encodeURIComponent(filename)}/versions/v1`, { token: ownKey });
assert.equal(v1Source.status, 200);
assert.ok(v1Source.data.html.includes('P95 120ms'));

// 5. Real Chromium browser verification
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  let loggedIn = false;
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  page.on('console', msg => { if (loggedIn && msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });

  await page.goto(base.href);
  await page.fill('#key', adminToken);
  await page.click('#login-submit');
  await page.waitForSelector('.report[aria-current="page"]');
  await page.waitForSelector('#preview:not([hidden])');
  loggedIn = true;
  await page.waitForFunction(() => document.querySelector('#viewer-version')?.textContent.includes('v2'));
  assert.equal(await page.locator('#comments-badge').textContent(), '1');

  // Inside iframe: select text -> verify ONLY single "Comment" button appears (no Ask/Comment, no Copy reply)
  const frame = page.frameLocator('#preview');
  await frame.locator('#p-latency').waitFor();
  await frame.locator('#p-latency').evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await frame.locator('.ve-raft-sel').waitFor({ timeout: 5000 });
  assert.equal(await frame.locator('.ve-raft-sel').textContent(), 'Comment');
  assert.equal(await frame.locator('.ve-sel, .ve-bar, .ve-pop').count(), 0, 'Upstream Ask/Comment/Copy-reply UI must be suppressed');

  // Click floating "Comment" button -> composer opens with quote anchor & draft box -> submit comment
  await frame.locator('.ve-raft-sel').click();
  await page.waitForSelector('#comments-panel:not([hidden])');
  assert.ok((await page.locator('#comment-anchor-quote').textContent()).includes('P99 185ms'));
  await frame.locator('.ve-raft-draft-box:not([hidden])').waitFor({ timeout: 5000 });
  await page.fill('#comment-input', 'Please also show P50 comparison.');
  await page.click('#comment-submit');
  await page.waitForFunction(() => document.querySelector('#comments-badge')?.textContent === '2');

  // Pick Element mode -> hover/click #node-gateway -> shows visual box & element label (no selector text clutter) -> submit
  await page.click('#pick-element');
  await page.waitForFunction(() => document.querySelector('#pick-element')?.getAttribute('aria-pressed') === 'true');
  await frame.locator('body.ve-raft-picking').waitFor({ timeout: 5000 });
  await frame.locator('#node-gateway').hover();
  assert.equal(await frame.locator('.ve-raft-pick-tag').count(), 0, 'Pick mode must use a visual box, not selector text tooltip');
  await frame.locator('#node-gateway').click();
  await page.waitForSelector('#comment-anchor-box:not([hidden])', { timeout: 5000 });
  assert.ok((await page.locator('#comment-anchor-box').textContent()).includes('Gateway'), 'Composer anchor chip should display picked element label');
  await frame.locator('.ve-raft-draft-box:not([hidden])').waitFor({ timeout: 5000 });
  await page.fill('#comment-input', 'Make the gateway block stand out more.');
  await page.click('#comment-submit');
  await page.waitForFunction(() => document.querySelector('#comments-badge')?.textContent === '3');

  // Element-picked comment displays its label anchor pill and focuses diagram element on click
  const elementAnchorBtn = page.locator('.comment-card .comment-anchor-btn', { hasText: 'Gateway' }).first();
  await elementAnchorBtn.waitFor({ timeout: 5000 });
  await elementAnchorBtn.click();
  await frame.locator('.ve-raft-comment-box.is-active').first().waitFor({ timeout: 5000 });

  // Open comments render visual bounding boxes on the diagram, not text descriptions
  await frame.locator('.ve-raft-comment-box').first().waitFor({ timeout: 5000 });
  const boxCountBefore = await frame.locator('.ve-raft-comment-box').count();
  assert.ok(boxCountBefore >= 2, `Expected >=2 comment boxes, got ${boxCountBefore}`);

  // Bounding boxes stay pixel-locked under dynamic layout shifts, scrolling, and sidebar toggles (no drift)
  const previewFrame = page.frames().find(f => f.url().includes('/pages/'));
  assert.ok(previewFrame, 'Preview iframe must be mounted');
  const assertBoxAligned = async (label) => {
    const delta = await previewFrame.evaluate(async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const target = document.getElementById('node-gateway');
      const boxes = [...document.querySelectorAll('.ve-raft-comment-box')];
      const tr = target.getBoundingClientRect();
      let best = Infinity;
      for (const b of boxes) {
        const br = b.getBoundingClientRect();
        const err = Math.max(
          Math.abs((br.left + 3) - tr.left),
          Math.abs((br.top + 3) - tr.top),
          Math.abs((br.width - 6) - tr.width),
          Math.abs((br.height - 6) - tr.height),
        );
        if (err < best) best = err;
      }
      return best;
    });
    assert.ok(delta <= 2.5, `Bounding box drifted (${delta}px) after ${label}`);
  };
  await assertBoxAligned('initial render');
  await previewFrame.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.id = 'drift-spacer';
    spacer.style.height = '1800px';
    document.body.prepend(spacer);
    window.scrollTo(0, 1750);
  });
  await assertBoxAligned('layout shift + window scroll');
  await page.click('#close-library');
  await assertBoxAligned('collapsing sidebar');
  await page.click('#nav-toggle');
  await assertBoxAligned('reopening sidebar');
  await previewFrame.evaluate(() => {
    document.getElementById('drift-spacer')?.remove();
    window.scrollTo(0, 0);
  });
  await assertBoxAligned('restoring layout');

  // Toolbar File API button opens File API targeting this exact file without .html suffix in title
  assert.equal(await page.locator('.report[aria-current="page"] .report-title').innerText(), 'architecture');
  assert.ok(!(await page.locator('#page-meta').innerText()).includes('.html'));
  await page.click('#viewer-api');
  await page.waitForFunction(() => !document.querySelector('#copy-api').disabled);
  assert.equal(await page.locator('#api-title').innerText(), 'Raft Demo / raft/architecture · API');
  assert.ok((await page.locator('#api-payload').inputValue()).includes('/files/raft/architecture.html'));
  await page.click('[data-close="api-dialog"]');

  // Resolve a comment in UI -> moves to folded Resolved list, open badge drops to 2
  const firstCard = page.locator('.comment-card:not(.resolved)').first();
  await firstCard.getByRole('button', { name: 'Resolve' }).click();
  await page.waitForFunction(() => document.querySelector('#comments-badge')?.textContent === '2');
  await page.waitForSelector('.resolved-section > summary');
  assert.ok((await page.locator('.resolved-section > summary').textContent()).includes('Resolved (1)'));

  // Expand Resolved -> click Reopen -> returns to open list (3)
  await page.locator('.resolved-section > summary').click();
  await page.locator('.resolved-section .comment-card').getByRole('button', { name: 'Reopen' }).click();
  await page.waitForFunction(() => document.querySelector('#comments-badge')?.textContent === '3');

  // Rich Markdown rendering & strict XSS neutralization in top-level comment + Agent reply, plus Edit raw Markdown preservation
  const rawMarkdownComment = [
    '### Latency Audit',
    'Verify **P99 budget** with `inline_code` and keep_snake_case_id intact.',
    '',
    '- Check `p50_ms` baseline',
    '- See [Latency Spec](https://example.com/spec)',
    '',
    '```js',
    'const p99_ms = 185;',
    '```',
    '',
    '| Metric | Target |',
    '| --- | --- |',
    '| P99 | 185ms |',
    '',
    '<img src=x onerror="window.__xss=1"> and [bad](javascript:alert(1))',
  ].join('\n');
  await page.fill('#comment-input', rawMarkdownComment);
  await page.click('#comment-submit');
  await page.waitForFunction(() => document.querySelector('#comments-badge')?.textContent === '4');

  const mdThreadId = await page.locator('.comment-card').last().getAttribute('data-thread-id');
  assert.ok(mdThreadId, 'Expected data-thread-id on newly posted Markdown comment');

  // Agent posts a rich Markdown reply with XSS attempt
  const agentMdReply = await req(`/api/pages/${encodeURIComponent(filename)}/comments`, {
    method: 'POST',
    token: ownKey,
    body: {
      replyTo: mdThreadId,
      body: [
        '**Updated** with `retry_budget` and [Docs](https://example.com/docs).',
        '',
        '- Added P50 baseline',
        '- Tuned timeout',
        '',
        '```sh',
        'echo ok',
        '```',
        '',
        '[evil](javascript:alert(2)) <img src=x onerror="window.__xss=2">',
      ].join('\n'),
    },
  });
  assert.equal(agentMdReply.status, 201, agentMdReply.text);

  // Reopen comments panel to fetch the new Agent reply
  await page.click('#comments-close');
  await page.click('#comments-toggle');
  await page.waitForSelector(`.comment-card[data-thread-id="${mdThreadId}"] .comment-reply.is-agent`);

  const mdCard = page.locator(`.comment-card[data-thread-id="${mdThreadId}"]`);
  const topBody = mdCard.locator('> .comment-body');
  assert.equal(await topBody.locator('strong', { hasText: 'P99 budget' }).count(), 1, 'Top-level bold must render as <strong>');
  assert.equal(await topBody.locator('code.md-inline-code', { hasText: 'inline_code' }).count(), 1, 'Top-level inline code must render as <code>');
  assert.equal(await topBody.locator('pre code', { hasText: 'const p99_ms = 185;' }).count(), 1, 'Top-level fenced code block must render as <pre><code>');
  assert.equal(await topBody.locator('ul li').count(), 2, 'Top-level bullet list must render as <ul><li>');
  const topLink = topBody.locator('a[target="_blank"][rel*="noopener"]', { hasText: 'Latency Spec' });
  assert.equal(await topLink.count(), 1, 'Safe https link must render with target=_blank and rel=noopener');
  assert.equal(await topLink.getAttribute('href'), 'https://example.com/spec');
  assert.equal(await topBody.locator('table td', { hasText: '185ms' }).count(), 1, 'Pipe table must render as <table><td>');
  assert.equal(await topBody.locator('em').count(), 0, 'snake_case identifiers must not be mangled into <em>');
  assert.ok((await topBody.textContent()).includes('keep_snake_case_id'), 'snake_case text must remain intact');
  assert.ok((await topBody.textContent()).includes('[bad](javascript:alert(1))'), 'Unsafe javascript: link must remain literal text');

  // Verify Agent reply Markdown rendering & AI badge
  const replyCard = mdCard.locator('.comment-reply.is-agent').first();
  assert.equal(await replyCard.locator('.avatar-dot.agent').count(), 1, 'Agent reply must show agent avatar dot');
  assert.equal(await replyCard.locator('.author-role-badge', { hasText: 'AI' }).count(), 1, 'Agent reply must show AI pill badge');
  const replyBody = replyCard.locator('.comment-body');
  assert.equal(await replyBody.locator('strong', { hasText: 'Updated' }).count(), 1, 'Reply bold must render as <strong>');
  assert.equal(await replyBody.locator('code.md-inline-code', { hasText: 'retry_budget' }).count(), 1, 'Reply inline code must render as <code>');
  assert.equal(await replyBody.locator('ul li').count(), 2, 'Reply bullet list must render as <ul><li>');
  assert.equal(await replyBody.locator('pre code', { hasText: 'echo ok' }).count(), 1, 'Reply fenced code must render as <pre><code>');
  assert.equal(await replyBody.locator('a[target="_blank"][href="https://example.com/docs"]').count(), 1, 'Reply safe link must render');

  // Strict XSS checks across entire comments panel
  assert.equal(await page.locator('#comments-panel img').count(), 0, 'Untrusted <img> tags must never be injected into DOM');
  assert.equal(await page.locator('#comments-panel a[href^="javascript:" i]').count(), 0, 'javascript: links must never exist');
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'XSS payload must never execute');

  // Clicking Edit preserves raw Markdown source untouched
  await mdCard.locator('> .comment-actions').getByRole('button', { name: 'Edit' }).click();
  const editTextarea = mdCard.locator('> .edit-box textarea');
  await editTextarea.waitFor({ timeout: 5000 });
  assert.equal(await editTextarea.inputValue(), rawMarkdownComment, 'Edit textarea must preserve exact raw Markdown');
  await mdCard.locator('> .edit-box').getByRole('button', { name: 'Cancel' }).click();
  await mdCard.locator('> .comment-body strong', { hasText: 'P99 budget' }).waitFor({ timeout: 5000 });

  // Verify Auto theme mode follows prefers-color-scheme, plus manual 3-state cycle (auto -> dark -> light -> auto)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.themeMode), 'auto');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await frame.locator('html[data-theme="dark"]').waitFor({ timeout: 5000 });
  await page.evaluate(() => { document.getElementById('comments-list').scrollTop = 0; });
  await page.screenshot({ path: '/tmp/ve-comments-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await frame.locator('html[data-theme="light"]').waitFor({ timeout: 5000 });
  await page.evaluate(() => { document.getElementById('comments-list').scrollTop = 0; });
  await page.screenshot({ path: '/tmp/ve-comments-light.png' });
  // Manual cycle: auto (light OS) -> dark -> light -> auto
  await page.click('#theme-toggle');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.themeMode), 'dark');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('ve-theme')), 'dark');
  await frame.locator('html[data-theme="dark"]').waitFor({ timeout: 5000 });
  await page.click('#theme-toggle');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.themeMode), 'light');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.click('#theme-toggle');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.themeMode), 'auto');
  assert.equal(await page.evaluate(() => localStorage.getItem('ve-theme')), null);

  // Click v1 badge on first comment -> switches viewer to historical v1 preview
  await page.locator('.comment-card .comment-ver', { hasText: 'v1' }).first().click();
  await page.waitForSelector('#history-banner:not([hidden])');
  assert.ok((await page.locator('#history-label').textContent()).includes('v1'));

  // Viewer session is read-only (can see comments, no composer, no pick-element, no resolve buttons)
  const viewerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const viewerPage = await viewerCtx.newPage();
  await viewerPage.goto(new URL(`/?access=${viewerKey}`, base).href);
  await viewerPage.waitForSelector('.report[aria-current="page"]');
  assert.equal(await viewerPage.locator('#pick-element').isVisible(), false);
  await viewerPage.click('#comments-toggle');
  await viewerPage.waitForSelector('#comments-panel:not([hidden])');
  assert.equal(await viewerPage.locator('#comment-composer').isVisible(), false);
  assert.equal(await viewerPage.locator('.comment-card').count(), 4);
  assert.equal(await viewerPage.locator('.comment-actions').count(), 0);
  await viewerCtx.close();

  assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
  console.log('PASS Raft-style comments & versions: API CRUD/resolve/reopen/auto-reopen/scope/notes/vN + real Chromium selection/pick-element/markers/resolve-fold/version-jump/viewer-readonly');
} finally {
  await browser.close();
}
