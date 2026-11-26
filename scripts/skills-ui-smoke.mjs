// Focused Admin Skills Workspace UI & E2E smoke test (run via scripts/skills-ui-check.sh).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

assert.equal(process.env.VE_SKILLS_UI_SMOKE, '1', 'Run through scripts/skills-ui-check.sh');
const base = new URL(process.env.PUBLIC_URL);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const dataDir = process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data';
const adminToken = (await readFile(process.env.TOKEN_FILE ?? '/run/secrets/api_token', 'utf8')).trim();
const viewerKey = createHmac('sha256', adminToken).update('viewer-access').digest('hex');
const phase = process.env.VE_SKILLS_UI_PHASE || 'main';
const checkpointPath = join(dataDir, '.skills-ui-checkpoint.json');

async function req(path, { method = 'GET', token = adminToken, body, headers = {}, raw = false } = {}) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text, headers: res.headers };
}

if (phase === 'persistence') {
  const saved = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const overview = await req('/api/skills');
  assert.equal(overview.status, 200);
  assert.equal(overview.data.editEnabled, false, 'Edit lock must remain OFF across restart');
  assert.equal(overview.data.docs.length, saved.docCount, 'Managed skill doc count must persist across restart');
  assert.equal(overview.data.explainers.length, saved.explainerCount, 'Built-in explainer count must persist across restart');
  assert.equal(overview.data.explainers.every(e => e.synced === true), true, 'All built-in explainers must remain synced after rollback & restart');
  assert.equal(Object.keys(overview.data.conflicts || {}).length, 0, 'Conflicts must remain empty after restart');
  const kitDoc = overview.data.docs.find(d => d.id === 'references/kit.md');
  assert.equal(kitDoc.status, 'upstream', 'Rolled-back doc must remain upstream after restart');
  const boot = await req('/api/visual-explainer/bootstrap-prompt');
  assert.equal(boot.status, 200);
  assert.ok(!boot.data.content.includes('CUSTOM_BOOTSTRAP_MARKER_E2E'), 'Rolled-back bootstrap prompt must remain restored after restart');
  console.log('PASS skills UI persistence across restart (edit lock OFF, 22 docs & 8 synced explainers, rolled-back skill & bootstrap prompt persisted)');
  process.exit(0);
}

// Seed a regular folder + starter diagram so Library mode has content alongside Skills mode.
const demoEntity = (await req('/api/entities', { method: 'POST', body: { id: 'demo-lib', name: 'Demo Library' } })).data.entity;
const libHtml = `<!doctype html>
<html lang="en" data-register="blueprint"><head><meta charset="utf-8"><title>Library Architecture</title><link rel="stylesheet" href="kit.css" data-ve-kit></head>
<body><main><h1>Library Architecture</h1><p>Regular workspace diagram.</p></main></body></html>`;
const pubLib = await req(`/api/entities/${demoEntity.id}/files/arch.html`, {
  method: 'PUT', raw: true, body: libHtml, headers: { 'Content-Type': 'text/html; charset=utf-8' },
});
assert.equal(pubLib.status, 201, pubLib.text);

// Create a regular user account to test strict Admin-only visibility.
const userCreated = await req('/api/accounts', { method: 'POST', body: { name: 'Regular User', role: 'user' } });
assert.equal(userCreated.status, 201);
const userSecret = userCreated.data.secret;

const initialOverview = await req('/api/skills');
assert.equal(initialOverview.status, 200);
const totalDocs = initialOverview.data.docs.length;
const totalExplainers = initialOverview.data.explainers.length;
assert.equal(totalDocs, 22, `Expected exactly 22 managed skill docs, got ${totalDocs}`);
assert.equal(totalExplainers, 8, `Expected exactly 8 built-in progressive explainers, got ${totalExplainers}`);
assert.equal(initialOverview.data.explainers.every(e => e.synced === true), true, 'All 8 built-in explainers must start synced');
assert.equal(Object.keys(initialOverview.data.conflicts || {}).length, 0, 'Expected 0 conflicts on fresh init');
assert.equal(initialOverview.data.editEnabled, false, 'Skill editing must start locked (false)');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  // 1. Regular user must NOT see #skills-open and gets 403 on /api/skills.
  const userCtx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const userPage = await userCtx.newPage();
  const userErrors = [];
  let userLoggedIn = false;
  userPage.on('pageerror', err => userErrors.push(err.message));
  userPage.on('console', msg => { if (userLoggedIn && msg.type() === 'error') userErrors.push(msg.text()); });

  await userPage.goto(base.href);
  await userPage.fill('#key', userSecret);
  await userPage.click('#login-submit');
  await userPage.waitForSelector('.report[aria-current="page"]');
  userLoggedIn = true;
  assert.equal(await userPage.locator('#skills-open').isVisible(), false, 'Regular user must NOT see #skills-open');
  assert.equal(await userPage.locator('#accounts-open').isVisible(), false, 'Regular user must NOT see #accounts-open');
  assert.deepEqual(userErrors, [], `User session console/page errors: ${userErrors.join('; ')}`);
  assert.equal((await req('/api/skills', { token: userSecret })).status, 403, 'Regular user bearer must receive 403 on /api/skills');
  assert.equal(await userPage.evaluate(async () => (await fetch('/api/skills')).status), 403, 'Regular user cookie session must receive 403 on /api/skills');
  await userCtx.close();

  // Viewer must also NOT see #skills-open.
  const viewerCtx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const viewerPage = await viewerCtx.newPage();
  const viewerErrors = [];
  viewerPage.on('pageerror', err => viewerErrors.push(err.message));
  await viewerPage.goto(`${base.origin}/?access=${viewerKey}`);
  await viewerPage.waitForSelector('.report[aria-current="page"]');
  assert.equal(await viewerPage.locator('#skills-open').isVisible(), false, 'Viewer must NOT see #skills-open');
  assert.equal(await viewerPage.evaluate(async () => (await fetch('/api/skills')).status), 403, 'Viewer must receive 403 on /api/skills');
  assert.deepEqual(viewerErrors, [], `Viewer session errors: ${viewerErrors.join('; ')}`);
  await viewerCtx.close();

  // 2. Admin workflow in full Chromium browser.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
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

  // Admin sees #skills-open next to #accounts-open.
  assert.equal(await page.locator('#skills-open').isVisible(), true, 'Admin must see #skills-open');
  assert.equal(await page.locator('#accounts-open').isVisible(), true, 'Admin must see #accounts-open');

  // Open Admin Skills workspace.
  await page.click('#skills-open');
  await page.waitForSelector('#skills-sidebar:not([hidden])');
  await page.waitForFunction((expected) => document.querySelectorAll('#skills-docs-list .skill-doc-row').length === expected, totalDocs);

  // Verify default locked state: aria-checked="false", Locked status pill, write/API controls disabled.
  assert.equal(await page.locator('#skills-edit-toggle').getAttribute('aria-checked'), 'false');
  assert.ok((await page.locator('#skills-lock-status').innerText()).includes('Locked'));
  assert.equal(await page.locator('#skills-api-open').isDisabled(), true, 'Skill Editor API button must be disabled when locked');
  assert.equal(await page.locator('#skills-docs-count').innerText(), String(totalDocs));
  assert.ok(await page.locator('#skills-docs-list .skill-doc-row[data-doc-id="SKILL.md"]').isVisible());
  assert.ok(await page.locator('#skills-docs-list .skill-doc-row[data-doc-id="webui/bootstrap-prompt.md"]').isVisible());
  assert.ok(await page.locator('#skills-docs-list .skill-doc-row[data-doc-id="references/kit.md"]').isVisible());

  // Verify all 8 pre-populated built-in progressive explainers render out-of-the-box and are Synced.
  const expectedExplainerIds = [
    'overview', 'bootstrap-prompt', 'SKILL', 'style-guide',
    'kit', 'diagrams', 'motion', 'commands-and-extras',
  ];
  assert.equal(await page.locator('#skills-explainers-count').innerText(), String(totalExplainers));
  for (const expId of expectedExplainerIds) {
    assert.equal(
      await page.locator(`#skills-explainers-tree .report[data-explainer-id="${expId}"]`).isVisible(),
      true,
      `Expected built-in explainer "${expId}" to be visible in sidebar`,
    );
  }
  await page.waitForSelector('#preview:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#skills-hash-status')?.textContent?.includes('Synced'));

  // Out-of-the-box L0 overview -> L1 SKILL Wiki drill-down & #wiki-up navigation while read-only locked!
  await page.click('#skills-explainers-tree .report[data-explainer-id="overview"]');
  await page.waitForSelector('#preview:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#skills-explainers-tree .report[data-explainer-id="overview"]')?.getAttribute('aria-current') === 'page');
  const builtinOverviewFrame = page.frameLocator('#preview');
  await builtinOverviewFrame.locator('span[data-ve-child="SKILL"].ve-drill-chip').first().waitFor({ state: 'visible', timeout: 10000 });
  await builtinOverviewFrame.locator('span[data-ve-child="SKILL"].ve-drill-chip').first().click();
  await page.waitForFunction(() => document.querySelector('#skills-explainers-tree .report[data-explainer-id="SKILL"]')?.getAttribute('aria-current') === 'page');
  await page.waitForSelector('#preview:not([hidden])');
  assert.equal(await page.locator('#wiki-up').isVisible(), true, 'Up-to-parent button must show after L0 overview -> L1 SKILL drill-down');
  assert.ok((await page.locator('#skills-hash-status').innerText()).includes('Synced'), 'Built-in SKILL explainer must show Synced');
  await page.click('#wiki-up');
  await page.waitForFunction(() => document.querySelector('#skills-explainers-tree .report[data-explainer-id="overview"]')?.getAttribute('aria-current') === 'page');
  await page.waitForSelector('#preview:not([hidden])');

  // Verify comment/pick controls are locked before unlock.
  assert.equal(await page.locator('#pick-element').isDisabled(), true, 'Pick button must be disabled while Skill Editing is locked');
  await page.click('#comments-toggle');
  await page.waitForSelector('#comments-panel:not([hidden])');
  assert.equal(await page.locator('#comment-composer').isVisible(), false, 'Comment composer must be hidden while locked');
  assert.equal(await page.locator('#comments-dispatch').isVisible(), false, 'Send dispatch button must be hidden while locked');
  assert.equal(await page.locator('#comments-lock-note').isVisible(), true, 'Lock hint must be visible in comments drawer');
  await page.click('#comments-close');

  // 3. Toggle #skills-edit-toggle ON -> verify UI unlocks and create Skill Editor key + copy prompt.
  await page.click('#skills-edit-toggle');
  await page.waitForFunction(() => document.querySelector('#skills-edit-toggle')?.getAttribute('aria-checked') === 'true');
  assert.ok((await page.locator('#skills-lock-status').innerText()).includes('Editing enabled'));
  assert.equal(await page.locator('#skills-api-open').isDisabled(), false, 'Skill Editor API button must be enabled when unlocked');

  await page.click('#skills-api-open');
  await page.waitForSelector('#skills-api-dialog[open]');
  await page.fill('#skill-key-name', 'E2E Skill Agent');
  await page.click('#skill-key-create-submit');
  await page.waitForSelector('#skill-key-created-box:not([hidden])');
  const skillKeySecret = await page.locator('#skill-key-secret').inputValue();
  assert.match(skillKeySecret, /^ve_sk_[A-Za-z0-9_-]{43}$/, 'Minted key must match ve_sk_ format');

  const promptText = await page.locator('#skill-editor-prompt').inputValue();
  assert.ok(promptText.includes(skillKeySecret), 'Skill Editor Prompt must embed minted ve_sk_ key');
  assert.ok(promptText.includes('/api/skills'), 'Skill Editor Prompt must reference /api/skills');
  assert.ok(promptText.includes('/api/skills/docs/'), 'Skill Editor Prompt must reference /api/skills/docs/<id>');
  assert.ok(promptText.includes('/api/skills/explainers/'), 'Skill Editor Prompt must reference /api/skills/explainers/<id>');
  assert.ok(promptText.includes('X-VE-Skill-Hash'), 'Skill Editor Prompt must document mandatory X-VE-Skill-Hash header');
  assert.ok(promptText.includes('/api/skills/comments'), 'Skill Editor Prompt must reference /api/skills/comments');
  assert.ok(promptText.includes('/api/skills/events?events=comment.dispatch&once=1&timeout=300&client=agent'), 'Skill Editor Prompt must include default non-blocking background SSE listener URL');
  assert.ok(promptText.includes('after='), 'Skill Editor Prompt must document &after=<eventId> re-arming');

  // Capture API modal screenshot before closing.
  await page.screenshot({ path: '/tmp/ve-skills-api-light.png' });
  await page.click('[data-close="skills-api-dialog"]');
  await page.waitForSelector('#skills-api-dialog', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#skill-key-secret')?.value === '' && document.querySelector('#skill-editor-prompt')?.value === '');
  assert.equal(await page.locator('#skill-key-secret').inputValue(), '', 'Skill key secret must be cleared when dialog closes');
  assert.equal(await page.locator('#skill-editor-prompt').inputValue(), '', 'Skill editor prompt secret must be cleared when dialog closes');

  // 4. Use minted ve_sk_ key to override references/kit.md + webui/bootstrap-prompt.md and publish hash-bound explainers!
  const origKit = (await req('/api/skills/docs/references/kit.md', { token: skillKeySecret })).data.content;
  const updatedKit = `${origKit.trimEnd()}\n\n## Custom Studio Rule\n- Prefer crisp 12px+ typography in Blueprint panels.\n`;
  const putKit = await req('/api/skills/docs/references/kit.md', {
    method: 'PUT', token: skillKeySecret, body: { content: updatedKit, note: 'Add custom studio rule' },
  });
  assert.equal(putKit.status, 200, putKit.text);
  const kitHash = putKit.data.skillHash;
  assert.match(kitHash, /^[0-9a-f]{64}$/);

  // Publish hash-bound explainer for kit (and overview parent if not present yet, so Wiki drill-down is tested end-to-end).
  const kitExplainerHtml = `<!doctype html>
<html lang="en" data-register="blueprint">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Component kit tokens, typography hierarchy, and custom studio rules.">
  <title>Component Kit Guide</title>
  <link rel="stylesheet" href="kit.css" data-ve-kit>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Skill Explainer · references/kit.md</p>
      <h1>Component Kit Guide</h1>
      <p class="lead">Visual map of kit tokens, diagram cards, and the newly added studio typography rule.</p>
    </header>
    <section id="sec-custom-rule">
      <h2>Custom Studio Rule</h2>
      <p id="kit-rule-target">Prefer crisp 12px+ typography in Blueprint panels across Light and Dark themes.</p>
    </section>
    <figure>
      <ve-flow label="Kit tokens feed diagram nodes and responsive panels.">
        <ve-node id="tokens" at="1 1" key>Blueprint Tokens</ve-node>
        <ve-node id="cards" at="2 1">Diagram Panels</ve-node>
        <ve-node id="checks" at="3 1">Render Check</ve-node>
        <ve-edge from="tokens" to="cards" label="CSS vars"/>
        <ve-edge from="cards" to="checks" label="12px+ check" hot/>
      </ve-flow>
      <figcaption>Verified against effective references/kit.md SHA-256 hash.</figcaption>
    </figure>
  </main>
</body>
</html>`;

  const putKitExp = await req('/api/skills/explainers/kit', {
    method: 'PUT',
    token: skillKeySecret,
    raw: true,
    body: kitExplainerHtml,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-VE-Skill-Hash': kitHash,
      'X-VE-Covers': 'references/kit.md',
      'X-VE-Title': 'Component Kit Guide',
      'X-VE-Summary': 'Component kit tokens, typography hierarchy, and custom studio rules.',
      'X-VE-Layer': '1',
      'X-VE-Parent': 'overview',
      'X-VE-Note': 'Sync kit explainer with custom studio rule',
    },
  });
  assert.equal(putKitExp.status, 200, putKitExp.text);
  assert.equal(putKitExp.data.synced, true);

  // Also test dynamic bootstrap prompt override -> verify Folder/File API reflects it immediately!
  const origBootstrap = (await req('/api/skills/docs/webui/bootstrap-prompt.md', { token: skillKeySecret })).data.content;
  const customBootstrap = `${origBootstrap.trimEnd()}\n\n<!-- CUSTOM_BOOTSTRAP_MARKER_E2E -->\n`;
  const putBoot = await req('/api/skills/docs/webui/bootstrap-prompt.md', {
    method: 'PUT', token: skillKeySecret, body: { content: customBootstrap, note: 'Test bootstrap prompt override' },
  });
  assert.equal(putBoot.status, 200, putBoot.text);

  // Switch back to Library -> open File API -> verify overridden bootstrap-prompt.md is used!
  await page.click('#skills-back');
  await page.waitForSelector('#skills-sidebar', { state: 'hidden' });
  await page.waitForSelector('#preview:not([hidden])');
  await page.click('#viewer-api');
  await page.waitForFunction(() => !document.querySelector('#copy-api').disabled);
  const dynamicPrompt = await page.locator('#api-payload').inputValue();
  assert.ok(dynamicPrompt.includes('CUSTOM_BOOTSTRAP_MARKER_E2E'), 'File API prompt must immediately render overridden webui/bootstrap-prompt.md');
  assert.ok(dynamicPrompt.includes('VE_KEY=\'ve_'), 'Overridden bootstrap prompt must still substitute {{VE_KEY_QUOTED}} cleanly');
  await page.click('[data-close="api-dialog"]');
  await page.waitForSelector('#api-dialog', { state: 'hidden' });

  // Return to Skills mode -> verify Overridden + Synced badges, stale overview drift detection, Wiki drill-down, Diff modal, Screenshots!
  await page.click('#skills-open');
  await page.waitForSelector('#skills-sidebar:not([hidden])');
  await page.waitForSelector('#skills-explainers-tree .report[data-explainer-id="overview"]');
  await page.waitForSelector('#skills-explainers-tree .report[data-explainer-id="kit"]');

  // Verify references/kit.md shows Overridden + Synced badges in sidebar.
  const kitRow = page.locator('#skills-docs-list .skill-doc-row[data-doc-id="references/kit.md"]');
  await kitRow.waitFor({ state: 'visible' });
  const kitRowText = await kitRow.innerText();
  assert.ok(kitRowText.includes('Overridden'), `Expected Overridden badge on kit row, got: ${kitRowText}`);
  assert.ok(kitRowText.includes('Synced'), `Expected Synced badge on kit row, got: ${kitRowText}`);

  // Start on built-in overview (now Out of sync because kit.md & bootstrap-prompt.md changed), then drill down into updated kit explainer!
  await page.click('#skills-explainers-tree .report[data-explainer-id="overview"]');
  await page.waitForSelector('#preview:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#skills-explainers-tree .report[data-explainer-id="overview"]')?.getAttribute('aria-current') === 'page');
  await page.waitForFunction(() => document.querySelector('#skills-hash-status')?.textContent?.includes('Out of sync'));
  const overviewFrame = page.frameLocator('#preview');
  await overviewFrame.locator('span[data-ve-child="kit"].ve-drill-chip').first().waitFor({ state: 'visible', timeout: 10000 });
  await overviewFrame.locator('span[data-ve-child="kit"].ve-drill-chip').first().click();
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent === 'Component Kit Guide');
  await page.waitForSelector('#preview:not([hidden])');

  // Verify hash-binding banner shows Synced + 8-char hash prefix, and #wiki-up shows Overview!
  const hashText = await page.locator('#skills-hash-status').innerText();
  assert.ok(hashText.includes('Synced') && hashText.includes(kitHash.slice(0, 8)), `Expected Synced + short hash, got: ${hashText}`);
  assert.equal(await page.locator('#wiki-up').isVisible(), true, 'Up to parent button must show on L1 skill explainer');

  // Capture crisp Light & Dark screenshots of the Admin Skills workspace!
  await page.evaluate(() => applyTheme('light', true));
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/ve-skills-light.png' });

  await page.evaluate(() => applyTheme('dark', true));
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/ve-skills-dark.png' });

  await page.evaluate(() => applyTheme('light', true));
  await page.waitForTimeout(150);

  // Inspect Diff modal for references/kit.md -> verify Effective Markdown, Diff vs Upstream (+/-), and Reset button visible.
  await kitRow.locator('.skill-doc-inspect').click();
  await page.waitForSelector('#skill-doc-dialog[open]');
  await page.waitForFunction(() => document.querySelector('#skill-doc-title')?.textContent === 'references/kit.md');
  await page.click('#skill-tab-diff');
  await page.waitForSelector('#skill-doc-body .diff-add');
  const diffText = await page.locator('#skill-doc-body').innerText();
  assert.ok(diffText.includes('Custom Studio Rule'), 'Unified diff must show added Custom Studio Rule line');
  assert.equal(await page.locator('#skill-doc-reset').isVisible(), true, 'Reset to upstream must be visible for overridden doc while unlocked');
  await page.screenshot({ path: '/tmp/ve-skills-diff-light.png' });
  await page.click('[data-close="skill-doc-dialog"]');
  await page.waitForSelector('#skill-doc-dialog', { state: 'hidden' });

  // 5. Pick an element on the skill explainer, post a comment, click Send -> verify SSE once=1 listener receives dispatch!
  await page.click('#pick-element');
  await page.waitForFunction(() => document.querySelector('#pick-element')?.getAttribute('aria-pressed') === 'true');
  const kitFrame = page.frameLocator('#preview');
  await kitFrame.locator('#kit-rule-target').click();
  await page.waitForSelector('#comments-panel:not([hidden])');
  await page.waitForSelector('#comment-anchor:not([hidden])');
  await page.fill('#comment-input', 'Please add dark-mode contrast note to Custom Studio Rule.');
  await page.click('#comment-submit');
  await page.waitForFunction(() => [...document.querySelectorAll('#comments-list .comment-body')].some(el => el.textContent.includes('dark-mode contrast note')));

  // Start background one-shot SSE listener with ve_sk_ key, wait briefly, then click Send!
  const ssePromise = req('/api/skills/events?events=comment.dispatch&once=1&timeout=15&client=e2e-agent', { token: skillKeySecret });
  await new Promise(r => setTimeout(r, 150));
  await page.waitForSelector('#comments-dispatch:not([hidden])');
  await page.click('#comments-dispatch');

  const sseEvent = await ssePromise;
  assert.equal(sseEvent.status, 200, `Expected 200 from skills SSE dispatch, got ${sseEvent.status}: ${sseEvent.text}`);
  assert.equal(sseEvent.data.type, 'comment.dispatch');
  assert.equal(sseEvent.data.explainerId, 'kit');
  assert.ok(sseEvent.data.summary.includes('dark-mode contrast note'), 'Dispatched SSE event must include the picked skill comment');
  await page.click('#comments-close');

  // 6. Open Skill Version History dialog -> inspect diff -> Rollback to v1!
  await page.click('#skills-history-open');
  await page.waitForSelector('#skills-history-dialog[open]');
  await page.waitForSelector('#skills-versions-list .version-row[data-version-label="v1"]');

  // Click Diff on latest version to verify /api/skills/versions/:rev/diff works in UI.
  await page.locator('#skills-versions-list .version-row').first().getByRole('button', { name: 'Diff' }).click();
  await page.waitForSelector('#skills-version-diff-box:not([hidden])');
  await page.click('#skills-version-diff-close');

  // Click Rollback to v1 -> confirm -> verify references/kit.md is back to Upstream!
  const v1Row = page.locator('#skills-versions-list .version-row[data-version-label="v1"]');
  await v1Row.getByRole('button', { name: 'Rollback to v1' }).click();
  await page.waitForSelector('#confirm-dialog[open]');
  await page.click('#confirm-submit');
  await page.waitForSelector('#confirm-dialog', { state: 'hidden' });

  await page.waitForFunction(() => {
    const row = document.querySelector('#skills-docs-list .skill-doc-row[data-doc-id="references/kit.md"]');
    return row && row.textContent.includes('Upstream') && !row.textContent.includes('Overridden');
  });
  const afterRollback = (await req('/api/skills')).data;
  assert.equal(afterRollback.explainers.length, totalExplainers, 'Rollback to v1 must restore all 8 built-in explainers');
  assert.equal(afterRollback.explainers.every(e => e.synced === true), true, 'Rollback to v1 must restore synced=true on all 8 built-in explainers');

  // 7. Toggle #skills-edit-toggle OFF -> verify UI re-locks and API returns 423!
  await page.click('#skills-edit-toggle');
  await page.waitForFunction(() => document.querySelector('#skills-edit-toggle')?.getAttribute('aria-checked') === 'false');
  assert.ok((await page.locator('#skills-lock-status').innerText()).includes('Locked'));
  assert.equal(await page.locator('#skills-api-open').isDisabled(), true, 'Skill Editor API must re-lock when switch turned OFF');

  const lockedPut = await req('/api/skills/docs/references/kit.md', {
    method: 'PUT', token: skillKeySecret, body: { content: updatedKit },
  });
  assert.equal(lockedPut.status, 423, 'Write API must return 423 Locked after Admin turns Skill Editing OFF');

  const lockedPostComment = await req('/api/skills/comments', {
    method: 'POST', body: { explainerId: 'kit', body: 'Should be blocked' },
  });
  assert.equal(lockedPostComment.status, 423, 'Comment POST must return 423 Locked when Skill Editing is OFF');

  await writeFile(checkpointPath, JSON.stringify({ docCount: totalDocs, explainerCount: totalExplainers }), { mode: 0o600 });

  assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
  await ctx.close();
  console.log(`PASS Admin Skills UI E2E: strict RBAC (user/viewer 403 & hidden), ${totalDocs} docs & ${totalExplainers} synced built-in explainers (out-of-the-box L0 overview -> L1 SKILL drill-down + wiki-up), default edit lock, unlock + ve_sk_ key + prompt, dynamic bootstrap-prompt.md override, stale detection + hash-bound explainer + Wiki drill-down, diff modal, pick-element comment + SSE dispatch, history diff + rollback to v1, re-lock (423), zero console errors`);
} finally {
  await browser.close();
}
