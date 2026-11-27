import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ANCHORS_SPECIFIER = process.env.VE_ANCHORS_MODULE || '../remote-app/anchors.mjs';

let anchorsMod = null;
let parserMod = null;
try {
  anchorsMod = await import(ANCHORS_SPECIFIER);
  parserMod = await import('node-html-parser');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

if (!anchorsMod || !parserMod) {
  const image = process.env.VE_ANCHORS_IMAGE || 'visual-explainer-webui:local-debug';
  test('anchors.mjs unit tests (via container node-html-parser)', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    const out = execFileSync('docker', [
      'run', '--rm',
      '--user', `${uid}:${gid}`,
      '--entrypoint', 'node',
      '--env', 'VE_ANCHORS_MODULE=/opt/bridge/anchors.mjs',
      '--mount', `type=bind,src=${join(REPO_ROOT, 'remote-app/anchors.mjs')},dst=/opt/bridge/anchors.mjs,readonly`,
      '--mount', `type=bind,src=${join(REPO_ROOT, 'scripts/anchors-test.mjs')},dst=/opt/bridge/anchors-test.mjs,readonly`,
      '--mount', `type=bind,src=${join(REPO_ROOT, 'remote-app/builtin-skills')},dst=/opt/bridge/builtin-skills,readonly`,
      '-w', '/opt/bridge',
      image,
      '--test', '/opt/bridge/anchors-test.mjs',
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.ok(out.includes('pass'), out);
  });
} else {
  const { extractPageAnchors, resolveCommentWhere } = anchorsMod;
  const { parse } = parserMod;

  const SAMPLE_HTML = `<!doctype html>
<html lang="en" data-register="blueprint">
<head>
  <meta charset="utf-8">
  <title>Anchors Unit Fixture</title>
  <style>.ve-n { color: red; } /* P99 185ms inside style must be ignored */</style>
  <script>const hidden = "P99 185ms inside script must be ignored";</script>
</head>
<body>
  <main>
    <h1>Distributed Cache Architecture</h1>
    <section id="sec-overview">
      <h2>Request Pipeline</h2>
      <figure id="fig-flow">
        <svg class="ve-flow" viewBox="0 0 600 200">
          <defs><marker id="arrow"><path d="M0 0 L6 3 L0 6 Z"/></marker></defs>
          <g class="ve-e" id="pure-edge"><path d="M10 10 H100"/></g>
          <g class="ve-n" id="node-edge" data-ref="EdgeProxy">
            <rect x="10" y="20" width="120" height="40"/>
            <text>Edge Proxy</text>
            <text class="sub">TLS + Rate Limit</text>
          </g>
          <g class="ve-n" data-ref="CacheShard">
            <rect x="180" y="20" width="120" height="40"/>
            <text>Cache Shard</text>
          </g>
          <g class="ve-n" data-ve-child="storage-engine">
            <rect x="350" y="20" width="120" height="40"/>
            <text>Storage Engine</text>
          </g>
          <g class="ve-n">
            <rect x="350" y="100" width="120" height="40"/>
            <text>Replica Sync</text>
          </g>
          <g class="ve-n">
            <rect x="180" y="100" width="120" height="40"/>
            <text>Metrics Collector</text>
          </g>
          <g id="custom-callout" aria-label="Hot Write Path">
            <circle cx="50" cy="140" r="10"/>
          </g>
          <g id="dup-node"><text>Dup One</text></g>
          <g id="dup-node"><text>Dup Two</text></g>
        </svg>
        <figcaption>End-to-end cache lookup and write-through path</figcaption>
      </figure>
      <h3>Latency Budget</h3>
      <p id="p-budget">Target read latency is P99 12ms under normal shard load.</p>
      <div class="card">
        <p>Deep <span class="badge">write-ahead compaction</span> policy details.</p>
      </div>
      <p>Drill into <span data-ve-child="storage-engine">Storage Engine</span> for disk format.</p>
      <table>
        <tbody>
          <tr><td>L1 Memory</td><td>0.4ms</td></tr>
          <tr><td>L2 NVMe</td><td>2.1ms</td></tr>
        </tbody>
      </table>
      <blockquote>Consistency favors bounded staleness over global locks.</blockquote>
      <pre>quorum = floor(N/2) + 1</pre>
      <div data-ve-bridge-ui="1" id="bridge-el">Bridge overlay must be skipped</div>
    </section>
  </main>
</body>
</html>`;

  test('extractPageAnchors produces guaranteed-unique selectors in priority order (#id > data-ref > data-ve-child > nth-of-type)', () => {
    const anchors = extractPageAnchors(SAMPLE_HTML);
    const doc = parse(SAMPLE_HTML);

    assert.ok(anchors.length >= 12, `Expected rich anchor list, got ${anchors.length}`);
    const seen = new Set();
    for (const anchor of anchors) {
      assert.ok(anchor.selector, `Anchor must have non-empty selector: ${JSON.stringify(anchor)}`);
      assert.equal(seen.has(anchor.selector), false, `Duplicate selector: ${anchor.selector}`);
      seen.add(anchor.selector);
      const matched = doc.querySelectorAll(anchor.selector);
      assert.equal(matched.length, 1, `Selector ${anchor.selector} must uniquely match 1 element, got ${matched.length}`);
      assert.ok(anchor.tag && anchor.tag === anchor.tag.toLowerCase());
      assert.ok(Array.isArray(anchor.headings));
    }

    // 1. Unique #id preferred even when data-ref is also present
    const edge = anchors.find(a => a.id === 'node-edge');
    assert.ok(edge, 'Expected #node-edge anchor');
    assert.equal(edge.selector, '#node-edge');
    assert.equal(edge.ref, 'EdgeProxy');
    assert.equal(edge.label, 'EdgeProxy');
    assert.deepEqual(edge.headings, ['Distributed Cache Architecture', 'Request Pipeline']);

    // 2. Unique [data-ref] preferred when no id
    const shard = anchors.find(a => a.ref === 'CacheShard');
    assert.ok(shard, 'Expected CacheShard anchor');
    assert.equal(shard.selector, '[data-ref="CacheShard"]');
    assert.equal(shard.tag, 'g');

    // 3. Shared data-ve-child disambiguated cleanly by tag (g vs span)
    const storageSvg = anchors.find(a => a.child === 'storage-engine' && a.tag === 'g');
    const storageSpan = anchors.find(a => a.child === 'storage-engine' && a.tag === 'span');
    assert.ok(storageSvg && storageSpan, 'Expected both SVG and inline data-ve-child anchors');
    assert.equal(storageSvg.selector, 'g[data-ve-child="storage-engine"]');
    assert.equal(storageSpan.selector, 'span[data-ve-child="storage-engine"]');

    // 4. Anonymous SVG nodes fall back to unique ancestor-anchored :nth-of-type path
    const replica = anchors.find(a => a.label.includes('Replica Sync'));
    const metrics = anchors.find(a => a.label.includes('Metrics Collector'));
    assert.ok(replica && metrics, 'Expected anonymous .ve-n anchors');
    assert.match(replica.selector, /:nth-of-type\(\d+\)/);
    assert.match(metrics.selector, /:nth-of-type\(\d+\)/);
    assert.notEqual(replica.selector, metrics.selector);

    // 5. Duplicate #id falls back to unique :nth-of-type path instead of colliding on #dup-node
    const dupOne = anchors.find(a => a.label === 'Dup One');
    const dupTwo = anchors.find(a => a.label === 'Dup Two');
    assert.ok(dupOne && dupTwo, 'Expected both duplicate-id groups with distinct selectors');
    assert.notEqual(dupOne.selector, '#dup-node');
    assert.notEqual(dupTwo.selector, '#dup-node');
    assert.notEqual(dupOne.selector, dupTwo.selector);

    // 6. Pure connector & defs & bridge UI are excluded
    assert.equal(anchors.some(a => a.id === 'pure-edge'), false, 'Pure SVG connector without label/text must be skipped');
    assert.equal(anchors.some(a => a.id === 'arrow'), false, '<defs> children must be skipped');
    assert.equal(anchors.some(a => a.id === 'bridge-el'), false, 'Bridge UI elements must be skipped');

    // 7. aria-label, figcaption, table rows, blockquote, pre, headings all captured
    assert.equal(anchors.find(a => a.id === 'custom-callout')?.label, 'Hot Write Path');
    assert.equal(anchors.find(a => a.id === 'fig-flow')?.label, 'End-to-end cache lookup and write-through path');
    assert.ok(anchors.some(a => a.tag === 'tr' && a.label.includes('L2 NVMe')));
    assert.ok(anchors.some(a => a.tag === 'blockquote' && a.label.includes('bounded staleness')));
    assert.ok(anchors.some(a => a.tag === 'pre' && a.label.includes('quorum')));

    // 8. Limit cap works cleanly
    const capped = extractPageAnchors(SAMPLE_HTML, { limit: 4 });
    assert.equal(capped.length, 4);
  });

  test('extractPageAnchors prefers bare [data-ve-child="..."] when globally unique', () => {
    const html = '<!doctype html><html><body><svg><g class="ve-n" data-ve-child="unique-sub"><text>Unique Sub</text></g></svg></body></html>';
    const anchors = extractPageAnchors(html);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].selector, '[data-ve-child="unique-sub"]');
    assert.equal(anchors[0].child, 'unique-sub');
  });

  test('resolveCommentWhere resolves where.ref, enriches tag/label/headings, and preserves explicit caller label', () => {
    // 1. where.ref without selector
    const byRef = resolveCommentWhere(SAMPLE_HTML, { kind: 'element', ref: 'CacheShard' });
    assert.equal(byRef.anchorMatched, true);
    assert.equal(byRef.matchedCount, 1);
    assert.equal(byRef.where.selector, '[data-ref="CacheShard"]');
    assert.equal(byRef.where.tag, 'g');
    assert.equal(byRef.where.label, 'CacheShard');
    assert.deepEqual(byRef.where.headings, ['Distributed Cache Architecture', 'Request Pipeline']);

    // 2. where.selector with missing metadata -> auto-filled
    const bySel = resolveCommentWhere(SAMPLE_HTML, { kind: 'element', selector: '#p-budget' });
    assert.equal(bySel.anchorMatched, true);
    assert.equal(bySel.matchedCount, 1);
    assert.equal(bySel.where.tag, 'p');
    assert.ok(bySel.where.label.includes('P99 12ms'));
    assert.deepEqual(bySel.where.headings, ['Distributed Cache Architecture', 'Request Pipeline', 'Latency Budget']);

    // 3. Explicit label provided by caller is preserved
    const explicitLabel = resolveCommentWhere(SAMPLE_HTML, { kind: 'element', selector: '#node-edge', label: 'Custom Edge Title' });
    assert.equal(explicitLabel.anchorMatched, true);
    assert.equal(explicitLabel.where.label, 'Custom Edge Title');
    assert.equal(explicitLabel.where.tag, 'g');

    // 4. Multi-match selector reports exact matchedCount
    const multi = resolveCommentWhere(SAMPLE_HTML, { kind: 'element', selector: 'g.ve-n' });
    assert.equal(multi.anchorMatched, true);
    assert.equal(multi.matchedCount, 5);
  });

  test('resolveCommentWhere auto-resolves text quote-only comments to deepest element (case-sensitive & case-insensitive, skipping script/style)', () => {
    // 1. Deepest element match (span inside p inside div.card)
    const deep = resolveCommentWhere(SAMPLE_HTML, { kind: 'text', quote: 'write-ahead compaction' });
    assert.equal(deep.anchorMatched, true);
    assert.equal(deep.matchedCount, 1);
    assert.equal(deep.where.tag, 'span');
    assert.ok(deep.where.selector, 'Quote-only text comment must gain a visual box selector');
    const doc = parse(SAMPLE_HTML);
    assert.equal(doc.querySelectorAll(deep.where.selector).length, 1);
    assert.equal(doc.querySelector(deep.where.selector).textContent.trim(), 'write-ahead compaction');
    assert.deepEqual(deep.where.headings, ['Distributed Cache Architecture', 'Request Pipeline', 'Latency Budget']);

    // 2. Case-insensitive fallback
    const ci = resolveCommentWhere(SAMPLE_HTML, { kind: 'text', quote: 'BOUNDED STALENESS' });
    assert.equal(ci.anchorMatched, true);
    assert.equal(ci.where.tag, 'blockquote');
    assert.ok(ci.where.selector);

    // 3. Quote present ONLY inside <script>/<style> must NOT match
    const inScript = resolveCommentWhere(SAMPLE_HTML, { kind: 'text', quote: 'P99 185ms inside script' });
    assert.equal(inScript.anchorMatched, false);
    assert.equal(inScript.matchedCount, 0);
    assert.equal(inScript.where.selector, undefined);
  });

  test('resolveCommentWhere handles unmatched selectors, invalid syntax, and page comments gracefully', () => {
    const missing = resolveCommentWhere(SAMPLE_HTML, { kind: 'element', selector: '#does-not-exist', label: 'Ghost' });
    assert.equal(missing.anchorMatched, false);
    assert.equal(missing.matchedCount, 0);
    assert.deepEqual(missing.where, { kind: 'element', selector: '#does-not-exist', label: 'Ghost' });

    const weird = resolveCommentWhere(SAMPLE_HTML, { kind: 'element', selector: 'div:has(> span.x) >> bad' });
    assert.equal(weird.anchorMatched, false);
    assert.equal(weird.matchedCount, 0);
    assert.equal(weird.where.selector, 'div:has(> span.x) >> bad');

    const pageRes = resolveCommentWhere(SAMPLE_HTML, { kind: 'page' });
    assert.equal(pageRes.anchorMatched, true);
    assert.equal(pageRes.matchedCount, 0);
    assert.deepEqual(pageRes.where, { kind: 'page' });
  });

  test('extractPageAnchors works cleanly on compiled built-in Blueprint explainers', async () => {
    const overviewPath = existsSync('/opt/bridge/builtin-skills/explainers/overview.html')
      ? '/opt/bridge/builtin-skills/explainers/overview.html'
      : join(REPO_ROOT, 'remote-app/builtin-skills/explainers/overview.html');
    const html = await readFile(overviewPath, 'utf8');
    const anchors = extractPageAnchors(html);
    const doc = parse(html);
    assert.ok(anchors.length >= 15, `Expected >=15 anchors on overview.html, got ${anchors.length}`);
    for (const anchor of anchors) {
      const matched = doc.querySelectorAll(anchor.selector);
      assert.equal(matched.length, 1, `Selector ${anchor.selector} must uniquely match 1 element in overview.html`);
    }
    assert.ok(anchors.some(a => a.child === 'bootstrap-prompt' && a.tag === 'g'));
  });
}
