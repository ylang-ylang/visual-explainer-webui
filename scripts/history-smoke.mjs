#!/usr/bin/env node
// Only for scripts/check-image.sh's disposable localhost container and bare remote.
// Host Git inspects history and stages one unrelated fixture canary; the service
// alone creates content commits.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const mode = process.argv[2] ?? '--mutations';
assert.ok(['--initial', '--mutations', '--persistence'].includes(mode) && process.argv.length <= 3,
  'Usage: node scripts/history-smoke.mjs [--initial|--persistence]');
assert.ok(process.env.VE_HISTORY_FIXTURE, 'VE_HISTORY_FIXTURE is required; use scripts/check-image.sh');
const fixture = resolve(process.env.VE_HISTORY_FIXTURE);
const dataDir = join(fixture, 'data');
const remoteDir = join(fixture, 'remote', 'repo.git');
const offlineDir = join(fixture, 'remote', 'offline.git');
const checkpoint = join(fixture, 'history-checkpoint.json');
const token = process.env.VE_TOKEN?.trim();
assert.ok(token?.length >= 32, 'VE_TOKEN is required');
const base = new URL(process.env.VE_BASE_URL);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && base.protocol === 'http:' &&
  !base.username && !base.password && !base.search && !base.hash && base.pathname === '/',
'VE_BASE_URL must be an isolated HTTP localhost origin');

const a = 'wrapper-smoke-a';
const b = 'wrapper-smoke-b';
const empty = 'wrapper-smoke-empty';
const mcp = 'wrapper-smoke-mcp.html';
const source = 'wrapper-smoke-mcp.src.html';
const apiPage = 'wrapper-smoke-api.html';
const catalogFile = '.entities.json';
const finalName = 'Wrapper smoke renamed';
const pendingId = 'history-smoke-pending';
const stagedCanary = 'staged-canary.txt';

function git(directory, ...args) {
  return execFileSync('git', ['-c', `safe.directory=${directory}`, '-C', directory, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();
}
function local(...args) { return git(dataDir, ...args); }
function head(directory = dataDir) { return git(directory, 'rev-parse', 'refs/heads/main'); }
function revisions() { return local('rev-list', '--reverse', 'main').split('\n'); }
function names(revision) {
  return local('ls-tree', '-r', '--name-only', '-z', revision).split('\0').filter(Boolean).sort();
}
function changed(revision) {
  return local('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', revision)
    .split('\0').filter(Boolean).sort();
}
function blob(revision, filename) { return local('show', `${revision}:${filename}`); }
function catalog(revision) {
  return names(revision).includes(catalogFile)
    ? JSON.parse(blob(revision, catalogFile)) : { version: 1, entities: [], pages: {} };
}
function indexState(expectCanary = mode !== '--initial') {
  const managed = [...new Set(revisions().flatMap(names))];
  assert.equal(local('diff', '--cached', '--name-only', '-z', '--',
    ...managed.map(filename => `:(literal)${filename}`)), '',
  'Managed entries in the normal index must match HEAD after every snapshot');
  const staged = local('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).sort();
  assert.deepEqual(staged, expectCanary ? [stagedCanary] : [],
    'Unrelated staged entries must survive snapshots without being committed or unstaged');
  if (expectCanary) {
    assert.equal(local('rev-parse', `:${stagedCanary}`),
      local('hash-object', '--', join(dataDir, stagedCanary)), 'Unrelated staged bytes must remain intact');
  }
}
function synced() {
  assert.equal(head(remoteDir), head(), 'Remote main must equal local main before a successful response');
  assert.equal(local('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(remoteDir, 'symbolic-ref', '--short', 'HEAD'), 'main');
  indexState();
}
async function request(path, { method = 'GET', body, status = 200, render = false } = {}) {
  const response = await fetch(new URL(path, base), {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual', signal: AbortSignal.timeout(render ? 180000 : 30000),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: expected ${status}, got ${response.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : undefined;
}

function auditHistory() {
  const seen = new Set();
  const commits = revisions();
  for (const revision of commits) {
    const entries = local('ls-tree', '-r', '-z', revision).split('\0').filter(Boolean);
    assert.ok(entries.length, 'No empty initial snapshot');
    const paths = [];
    for (const entry of entries) {
      const match = /^(100644|100755) blob ([0-9a-f]+)\t([^\0]+)$/.exec(entry);
      assert.ok(match, 'History must contain only regular files, never symlinks or submodules');
      const [, , oid, filename] = match;
      paths.push(filename);
      assert.ok(!filename.includes('/') && (filename === catalogFile || /\.html?$/i.test(filename)),
        `Non-content file tracked: ${filename}`);
      assert.notEqual(filename, 'secret.html', 'The secret symlink must never be tracked');
      if (!seen.has(oid)) {
        seen.add(oid);
        const contents = local('cat-file', 'blob', oid);
        for (const canary of [token, 'HISTORY_SCREENSHOT_CANARY', 'HISTORY_PRIVATE_KEY_CANARY', 'HISTORY_NESTED_CANARY', 'HISTORY_STAGED_CANARY']) {
          assert.ok(!contents.includes(canary), 'Secret, screenshot or nested-file canary leaked into Git');
        }
      }
    }
    assert.ok(paths.includes('legacy.html') && paths.includes('LEGACY.src.HTM'), 'Initial pages and mixed-case sources must persist');
    assert.equal(local('rev-parse', `${revision}:legacy.html`), local('rev-parse', `${commits[0]}:legacy.html`), 'Legacy HTML changed');
    assert.ok(changed(revision).length > 0, 'No empty commits');
    assert.equal(local('show', '-s', '--format=%an <%ae>', revision), 'Visual Explainer <visual-explainer@localhost>');
    assert.ok(local('show', '-s', '--format=%s', revision).length > 0, 'Commits need meaningful subjects');
  }
  synced();
}

async function initialImport() {
  const commits = revisions();
  assert.equal(commits.length, 1, 'Startup must import existing content in one commit');
  assert.deepEqual(names(commits[0]).filter(filename => filename !== catalogFile), ['LEGACY.src.HTM', 'legacy.html']);
  assert.equal(blob(commits[0], 'legacy.html'), (await readFile(join(dataDir, 'legacy.html'), 'utf8')).trimEnd());
  assert.equal(blob(commits[0], 'LEGACY.src.HTM'), '<!-- HISTORY_SOURCE_CANARY -->');
  for (const filename of ['legacy.html', 'LEGACY.src.HTM']) {
    assert.equal(local('rev-parse', `${commits[0]}:${filename}`),
      local('hash-object', '--', join(dataDir, filename)), 'Initial import must preserve exact file bytes');
  }
  const firstCatalog = catalog(commits[0]);
  assert.deepEqual(firstCatalog.entities, []);
  assert.deepEqual(firstCatalog.pages, {});
  auditHistory();
  // Stage only this disposable, non-content fixture file. Never commit it.
  await writeFile(join(dataDir, stagedCanary), 'HISTORY_STAGED_CANARY\n');
  assert.ok(process.env.VE_HISTORY_CONTAINER, 'Use the isolated checker container');
  execFileSync('docker', ['exec', process.env.VE_HISTORY_CONTAINER,
    'git', '-C', '/data', 'add', '--', stagedCanary], { timeout: 30000 });
  indexState(true);
  await writeFile(checkpoint, JSON.stringify({ initial: commits[0] }));
  console.log('PASS Git startup import, mixed-case source, regular-file whitelist and bare-remote sync');
}

async function compatibilityHistory() {
  const { initial } = JSON.parse(await readFile(checkpoint, 'utf8'));
  const commits = revisions();
  assert.equal(commits[0], initial);
  assert.equal(commits.length, 16,
    'Original API/MCP suite must produce exactly 15 real mutation commits, no GET/error/restart commits');
  let entityNames = {};
  let pages = {};
  const steps = [
    { entities: { [a]: 'Wrapper smoke source' } },
    { entities: { [a]: 'Wrapper smoke source', [b]: 'Wrapper smoke destination' } },
    { entities: { [a]: 'Wrapper smoke source', [b]: 'Wrapper smoke destination', [empty]: 'Wrapper smoke empty' } },
    { entities: { [a]: 'Wrapper smoke source', [b]: finalName, [empty]: 'Wrapper smoke empty' } },
    { entities: { [a]: 'Wrapper smoke source', [b]: finalName } },
    { pages: { [mcp]: a }, files: [mcp, source, catalogFile], marker: 'WRAPPER_SMOKE_MCP_V1' },
    { files: [mcp, source], marker: 'WRAPPER_SMOKE_MCP_V2' },
    { files: [apiPage], apiMarker: 'WRAPPER_SMOKE_API_V1' },
    { pages: { [mcp]: a, [apiPage]: a }, files: [apiPage, catalogFile], apiMarker: 'WRAPPER_SMOKE_API_V2' },
    { files: [apiPage], apiMarker: 'WRAPPER_SMOKE_API_V3' },
    { pages: { [mcp]: b, [apiPage]: a } },
    { pages: { [mcp]: b, [apiPage]: b } },
    { pages: { [mcp]: b } },
    { pages: { [mcp]: b, [apiPage]: b } },
    { entities: { [b]: finalName } },
  ];
  for (const [index, step] of steps.entries()) {
    const revision = commits[index + 1];
    assert.equal(local('rev-parse', `${revision}^`), commits[index], 'Mutations must form one linear history');
    if (step.entities) entityNames = step.entities;
    if (step.pages) pages = step.pages;
    const snapshot = catalog(revision);
    assert.deepEqual(Object.fromEntries(snapshot.entities.map(entity => [entity.id, entity.name])), entityNames,
      `Entity create/rename/delete snapshot ${index + 1}`);
    assert.deepEqual(snapshot.pages, pages, `Page association snapshot ${index + 1}`);
    const delta = changed(revision);
    for (const filename of step.files ?? [catalogFile]) {
      assert.ok(delta.includes(filename), `Mutation ${index + 1} must include ${filename}`);
    }
    if (!step.files) assert.deepEqual(delta, [catalogFile], 'Catalog-only mutation must not rewrite pages');
    if (step.marker) {
      assert.ok(blob(revision, mcp).includes(step.marker));
      assert.ok(blob(revision, source).includes(step.marker), 'Source and rendered version must share one commit');
    }
    if (step.apiMarker) assert.ok(blob(revision, apiPage).includes(step.apiMarker));
  }
  auditHistory();
  console.log('PASS every original API/MCP mutation, page versions, atomic source/render/assignment and catalog history');
}

async function unchanged(label, path, options) {
  const before = head();
  await request(path, options);
  assert.equal(head(), before, `${label} must not create a commit`);
  synced();
}

async function noopsAndErrors() {
  await unchanged('GET', '/api/entities');
  await unchanged('Same association', `/api/pages/${apiPage}`, { method: 'PATCH', body: { entityId: b } });
  await unchanged('Same normalized entity name', `/api/entities/${b}`, { method: 'PATCH', body: { name: ` ${finalName} ` } });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wrapper API V3</title>

</head><body><main><h1>WRAPPER_SMOKE_API_V3</h1><p>Real wrapper API compatibility fixture.</p>
</main></body></html>`;
  await unchanged('Identical rendered bytes', `/api/pages/${apiPage}`, { method: 'PUT', body: { html }, render: true });
  await unchanged('Invalid entity', '/api/entities', { method: 'POST', status: 400, body: { id: 'INVALID ID', name: 'Invalid' } });
  await unchanged('Duplicate entity', '/api/entities', { method: 'POST', status: 409, body: { id: b, name: 'Duplicate' } });
  await unchanged('Invalid association', `/api/pages/${apiPage}`, { method: 'PATCH', status: 404, body: { entityId: 'history-missing' } });
  await unchanged('Renderer failure', '/api/pages/history-rejected.html', {
    method: 'PUT', status: 400, render: true, body: { html: '<p>Not a document</p>' },
  });
  console.log('PASS read-only, identical render, normalized rename, association no-ops and invalid/failed mutation commit suppression');
}

async function pushFailure() {
  const before = head();
  const beforeCount = revisions().length;
  synced();
  // Moving this fixture-owned bare repo makes receive-pack fail deterministically.
  // No hooks are disabled: client -c settings can propagate to file-transport
  // receive-pack, so a rejecting remote hook would not be a reliable fixture.
  await rename(remoteDir, offlineDir);
  let pending;
  try {
    const failure = await request('/api/entities', {
      method: 'POST', status: 503, body: { id: pendingId, name: 'History pending commit' },
    });
    assert.equal(typeof failure?.error, 'string');
    assert.match(failure.error, /saved|preserv/i, '503 must explain that content/local history is already saved');
    assert.match(failure.error, /git|push|history|sync/i, '503 must identify the Git failure');
    pending = head();
    assert.notEqual(pending, before, 'Push failure must preserve a new local commit');
    assert.equal(revisions().length, beforeCount + 1);
    assert.equal(local('rev-parse', `${pending}^`), before);
    assert.equal(head(offlineDir), before, 'Failed push must leave remote head unchanged');
    assert.equal(catalog(pending).entities.find(entity => entity.id === pendingId)?.name, 'History pending commit');
    assert.ok((await request('/api/entities')).entities.some(entity => entity.id === pendingId),
      'The failed response must not hide or roll back already-saved content');
  } finally {
    await rename(offlineDir, remoteDir);
  }
  await request(`/api/entities/${pendingId}`, { method: 'PATCH', body: { name: 'History recovered commit' } });
  const recovered = head();
  assert.equal(revisions().length, beforeCount + 2);
  assert.equal(local('rev-parse', `${recovered}^`), pending, 'Recovery must retain the pending commit');
  assert.equal(git(remoteDir, 'rev-parse', `${recovered}^`), pending, 'Next valid mutation must push both commits');
  synced();
  await request(`/api/entities/${pendingId}`, { method: 'DELETE', status: 204 });
  assert.equal(revisions().length, beforeCount + 3, 'Cleanup deletion is itself a versioned mutation');
  assert.equal(catalog(head()).entities.some(entity => entity.id === pendingId), false);
  synced();

  // A no-op must also retry pending history, even when it creates no new commit.
  await rename(remoteDir, offlineDir);
  let retryCommit;
  try {
    await request('/api/entities', {
      method: 'POST', status: 503, body: { id: pendingId, name: 'History no-op retry' },
    });
    retryCommit = head();
    assert.equal(revisions().length, beforeCount + 4);
    assert.notEqual(retryCommit, head(offlineDir));
  } finally {
    await rename(offlineDir, remoteDir);
  }
  await unchanged('No-op recovery', `/api/pages/${apiPage}`, { method: 'PATCH', body: { entityId: b } });
  assert.equal(head(remoteDir), retryCommit, 'A no-op must push pending commits without adding an empty commit');
  await request(`/api/entities/${pendingId}`, { method: 'DELETE', status: 204 });
  assert.equal(revisions().length, beforeCount + 5);
  auditHistory();
  console.log('PASS push failure 503, preserved local content/commit, unchanged remote, later mutation and no-op pending-push recovery');
}

async function main() {
  if (mode === '--initial') return initialImport();
  if (mode === '--persistence') {
    const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
    assert.equal(head(), saved.head, 'Restart must not create an unchanged startup commit');
    assert.equal(revisions().length, saved.count);
    assert.deepEqual(catalog(head()), saved.catalog, 'Restart must retain the exact catalog');
    await unchanged('Read after restart', '/api/entities');
    auditHistory();
    console.log('PASS restart has no empty commit, all versions persist, local and remote main remain equal');
    return;
  }
  await compatibilityHistory();
  await noopsAndErrors();
  await pushFailure();
  await writeFile(checkpoint, JSON.stringify({ head: head(), count: revisions().length, catalog: catalog(head()) }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
