#!/usr/bin/env node
// Only for scripts/check-image.sh's disposable localhost services and real Git remotes.
// The seed helper creates legacy history; only the service commits thereafter.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const mode = process.argv[2] ?? '--mutations';
assert.ok(['--initial', '--mutations', '--persistence', '--empty-library'].includes(mode) && process.argv.length <= 3,
  'Usage: node scripts/history-smoke.mjs [--initial|--mutations|--persistence|--empty-library]');
assert.ok(process.env.VE_HISTORY_FIXTURE, 'VE_HISTORY_FIXTURE is required; use scripts/check-image.sh');
const fixture = resolve(process.env.VE_HISTORY_FIXTURE);
const dataDir = join(fixture, 'data');
const remoteDir = join(fixture, 'remote', 'repo.git');
const offlineDir = join(fixture, 'remote', 'offline.git');
const checkpoint = join(fixture, 'history-checkpoint.json');
const legacyFixture = mode === '--empty-library' ? null
  : JSON.parse(readFileSync(join(fixture, 'legacy-checkpoint.json'), 'utf8'));
const token = process.env.VE_TOKEN?.trim();
assert.ok(token?.length >= 32, 'VE_TOKEN is required');
const base = new URL(process.env.VE_BASE_URL);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && base.protocol === 'http:' &&
  !base.username && !base.password && !base.search && !base.hash && base.pathname === '/',
'VE_BASE_URL must be an isolated HTTP localhost origin');

const b = 'wrapper-smoke-b';
const mcp = 'wrapper-smoke-mcp.html';
const source = 'wrapper-smoke-mcp.src.html';
const apiPage = 'wrapper-smoke-api.html';
const catalogFile = '.entities.json';
const finalName = 'Wrapper smoke renamed';
const pendingId = 'history-smoke-pending';
const unassigned = '_unassigned';

function git(directory, ...args) {
  const repository = directory === dataDir ? join(dataDir, '.git') : directory;
  return execFileSync('git', ['-c', `safe.directory=${repository}`, `--git-dir=${repository}`, ...args], {
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
function blobBytes(revision, filename) {
  const repository = join(dataDir, '.git');
  return execFileSync('git', ['-c', `safe.directory=${repository}`, `--git-dir=${repository}`, 'show', `${revision}:${filename}`], {
    timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  });
}
function catalog(revision) {
  return names(revision).includes(catalogFile) ? JSON.parse(blob(revision, catalogFile)) : null;
}
function indexState() {
  if (legacyFixture) assert.deepEqual(readFileSync(join(dataDir, '.git', 'index')),
    Buffer.from(legacyFixture.index, 'base64'),
    'The unrelated staged legacy index must remain byte-for-byte untouched');
}
function synced() {
  assert.equal(head(remoteDir), head(), 'Remote main must equal local main before a successful response');
  assert.equal(local('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(remoteDir, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(local('rev-parse', '--is-bare-repository'), 'true', 'Content history must be a bare object store');
  if (names(head()).includes(catalogFile)) {
    assert.ok(process.env.VE_HISTORY_CONTAINER, 'Use the isolated checker container');
    const actual = execFileSync('docker', ['exec', process.env.VE_HISTORY_CONTAINER, 'cat', `/data/${catalogFile}`], {
      timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    });
    assert.deepEqual(blobBytes(head(), catalogFile), actual, 'Root catalog blob must preserve the exact canonical file bytes');
  }
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

const companionPath = path => path.replace(/(\.html?)$/i, '.src$1');
function assertLayout(revision, contentPaths, folders = []) {
  const actual = names(revision);
  contentPaths = [...new Set([...contentPaths, ...contentPaths.filter(path => !/\.src\.html?$/i.test(path))
    .map(companionPath).filter(path => actual.includes(path))])];
  const directories = [unassigned, ...(catalog(revision)?.entities ?? []).map(entity => entity.id), ...folders];
  const markers = directories.filter(directory => !contentPaths.some(path => path.startsWith(`${directory}/`)) &&
    !directories.some(other => other.startsWith(`${directory}/`)))
    .map(directory => `${directory}/.gitkeep`);
  const expected = [...contentPaths, ...markers];
  if (names(revision).includes(catalogFile)) expected.push(catalogFile);
  assert.deepEqual(names(revision), expected.sort(), 'Tree must contain only logical content, empty markers and root catalog');
  for (const marker of markers) assert.equal(blobBytes(revision, marker).length, 0, 'Markers must be generated empty blobs');
}

function auditHistory() {
  const seen = new Set();
  const commits = revisions();
  assert.equal(commits[0], legacyFixture.legacy, 'Legacy history must remain reachable and unchanged');
  local('merge-base', '--is-ancestor', legacyFixture.legacy, head());
  for (const [index, revision] of commits.entries()) {
    const entries = local('ls-tree', '-r', '-z', revision).split('\0').filter(Boolean);
    assert.ok(entries.length, 'No empty initial snapshot');
    for (const entry of entries) {
      const match = /^(100644|100755) blob ([0-9a-f]+)\t([^\0]+)$/.exec(entry);
      assert.ok(match, 'History must contain only regular files, never symlinks or submodules');
      const [, , oid, filename] = match;
      if (index === 0) {
        assert.ok(['legacy.html', 'LEGACY.src.HTM', catalogFile].includes(filename), 'Preserve the real pre-startup v1 commit');
      } else if (filename !== catalogFile) {
        assert.match(filename, /^(?:_unassigned|[a-z0-9][a-z0-9_-]{0,63})\/(?:[^/]+\/)*(?:[^/]+\.html?|\.gitkeep)$/i);
        assert.ok(!filename.split('/').includes('secret.html'), 'The secret symlink must never be tracked');
      }
      if (!seen.has(oid)) {
        seen.add(oid);
        const contents = local('cat-file', 'blob', oid);
        for (const canary of [token, 'HISTORY_SCREENSHOT_CANARY', 'HISTORY_PRIVATE_KEY_CANARY',
          'HISTORY_NESTED_CANARY', 'HISTORY_STAGED_CANARY', 'HISTORY_INPUT_GITKEEP_CANARY']) {
          assert.ok(!contents.includes(canary), 'Secret, screenshot, nested, staged or input-marker canary leaked into Git');
        }
      }
    }
    const legacyPath = index === 0 ? 'legacy.html' : `${unassigned}/legacy.html`;
    const sourcePath = index === 0 ? 'LEGACY.src.HTM' : `${unassigned}/LEGACY.src.HTM`;
    assert.equal(local('rev-parse', `${revision}:${legacyPath}`), local('rev-parse', `${commits[0]}:legacy.html`), 'Legacy HTML changed');
    assert.equal(local('rev-parse', `${revision}:${sourcePath}`), local('rev-parse', `${commits[0]}:LEGACY.src.HTM`), 'Case-sensitive orphan source changed');
    if (index > 0) {
      assert.equal(catalog(revision)?.version, 3, 'Every current snapshot must use the migrated v3 catalog');
      assert.equal(local('rev-parse', `${revision}^`), commits[index - 1], 'History must fast-forward without rewriting commits');
    }
    assert.ok(changed(revision).length > 0, 'No empty commits');
    assert.ok(local('show', '-s', '--format=%s', revision).length > 0, 'Commits need meaningful subjects');
  }
  synced();
}

async function initialImport() {
  const commits = revisions();
  assert.ok(commits.length >= 2, 'Startup must append layout/schema migration to real legacy history');
  assert.equal(commits[0], legacyFixture.legacy);
  assert.deepEqual(names(commits[0]), ['.entities.json', 'LEGACY.src.HTM', 'legacy.html']);
  assert.equal(local('rev-parse', `${commits[1]}^`), legacyFixture.legacy, 'Layout migration must be a direct child of old HEAD');
  assertLayout(commits[1], [`${unassigned}/legacy.html`, `${unassigned}/LEGACY.src.HTM`]);
  for (const filename of ['legacy.html', 'LEGACY.src.HTM']) {
    assert.deepEqual(blobBytes(commits[1], `${unassigned}/${filename}`), await readFile(join(dataDir, filename)),
      'Migration must preserve exact serving-file bytes');
  }
  assert.equal(catalog(commits.at(-1)).version, 3);
  assert.deepEqual((await request('/api/entities')).entities, []);
  auditHistory();
  await writeFile(checkpoint, JSON.stringify({ initial: commits[1] }));
  console.log('PASS real flat legacy migration, preserved staged index, old-HEAD ancestry and remote fast-forward');
}

async function compatibilityHistory() {
  const { initial } = JSON.parse(await readFile(checkpoint, 'utf8'));
  local('merge-base', '--is-ancestor', initial, head());
  const pages = (await request('/api/pages')).pages;
  const expected = new Map([
    ['legacy.html', { entityId: null, marker: 'Legacy smoke fixture' }],
    [mcp, { entityId: b, marker: 'WRAPPER_SMOKE_MCP_V2' }],
    [apiPage, { entityId: b, marker: 'WRAPPER_SMOKE_API_V3' }],
  ]);
  assert.equal(pages.length, expected.size);
  const contentPaths = [`${unassigned}/LEGACY.src.HTM`];
  for (const page of pages) {
    const state = expected.get(page.filename);
    assert.ok(state, 'Only compatibility fixtures may exist');
    assert.equal(page.entityId, state.entityId);
    assert.equal(page.path, page.filename, 'Legacy uploads retain logical root basenames');
    const path = `${page.entityId ?? unassigned}/${page.path}`;
    contentPaths.push(path);
    assert.deepEqual(blobBytes(head(), path), await readFile(join(dataDir, page.filename)));
    assert.ok(blob(head(), path).includes(state.marker));
    const versions = (await request(`/api/pages/${page.filename}/versions`)).versions;
    assert.ok(versions.length > 0, 'Existing legacy/API/MCP pages have real versions');
    for (const version of versions) {
      assert.match(version.revision, /^[a-f0-9]{40}$/);
      local('merge-base', '--is-ancestor', version.revision, head());
    }
  }
  contentPaths.push(`${b}/${source}`);
  assertLayout(head(), contentPaths);
  auditHistory();
  console.log('PASS compatibility pages, v2 logical projection, exact compiled blobs and real reachable versions');
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
    assert.ok(failure.error.length > 0, 'Push failure must return a real JSON error');
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
  if (mode === '--empty-library') return emptyLibrary();
  if (mode === '--persistence') {
    const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
    assert.equal(head(), saved.head, 'Restart must not create an unchanged startup commit');
    assert.equal(revisions().length, saved.count);
    assert.deepEqual(catalog(head()), saved.catalog, 'Restart must retain the exact catalog');
    await unchanged('Read after restart', '/api/entities');
    auditHistory();
    await verifyServingState(saved.pages);
    await cloneChecks('restart-clone');
    console.log('PASS restart has no empty commit, all versions persist, local and remote main remain equal');
    return;
  }
  await compatibilityHistory();
  await noopsAndErrors();
  await pushFailure();
  await sourceAndFolderMoves();
  await cloneChecks('content-clone');
  await writeFile(checkpoint, JSON.stringify({
    head: head(), count: revisions().length, catalog: catalog(head()), pages: await servingState(),
  }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

async function cloneChecks(directory) {
  const target = join(fixture, directory);
  execFileSync('git', ['-c', `safe.directory=${remoteDir}`, 'clone', '--no-local', '--', remoteDir, target], {
    timeout: 30000, encoding: 'utf8',
  });
  const cloned = (...args) => execFileSync('git', ['-C', target, ...args], {
    timeout: 30000, encoding: 'utf8',
  }).trimEnd();
  assert.equal(cloned('rev-parse', 'HEAD'), head(), 'A normal clone must obtain the published HEAD');
  assert.equal(cloned('status', '--porcelain=v1', '--untracked-files=all'), '', 'A clone must have a clean worktree and index');
  assert.equal(cloned('symbolic-ref', '--short', 'HEAD'), 'main');
  for (const path of names(head())) {
    assert.ok((await stat(join(target, path))).isFile(), 'Clone must materialize regular folder files');
    assert.deepEqual(await readFile(join(target, path)), blobBytes(head(), path), 'Clone must preserve every exact blob byte');
  }
  for (const directory of [unassigned, ...(catalog(head())?.entities ?? []).map(entity => entity.id)]) {
    assert.ok((await stat(join(target, directory))).isDirectory(), 'Every Entity, including empty ones, must materialize as a directory');
  }
  console.log('PASS real private-content clone materializes folders, exact bytes and a clean main worktree');
}

async function servingState() {
  const pages = (await request('/api/pages')).pages;
  return Promise.all(pages.map(async page => {
    const response = await fetch(page.url, { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200);
    return { page, body: await response.text(), mtimeNs: String((await stat(join(dataDir, page.filename), { bigint: true })).mtimeNs) };
  }));
}

async function verifyServingState(saved) {
  assert.deepEqual(await servingState(), saved, 'Restart must preserve all page URLs, metadata, flat serving bytes and exact mtimes');
}

async function sourceAndFolderMoves() {
  const first = 'history-edge-a';
  const second = 'history-edge-b';
  const companions = [
    ['history-edge.htm', 'history-edge.src.html'],
    ['history-pair.htm', 'history-pair.src.htm'],
    ['history-pair.html', 'history-pair.src.html'],
    ['history-mixed.HTM', 'history-mixed.src.HTML'],
  ];
  const baseContent = names(head()).filter(path => path !== catalogFile && !path.endsWith('/.gitkeep'));
  for (const [filename, source] of companions) {
    await writeFile(join(dataDir, filename), `<!doctype html><html><head><title>${filename}</title></head><body>${filename}</body></html>\n`);
    await writeFile(join(dataDir, source), `<!-- exact companion for ${filename} -->\n`);
  }
  const locations = new Map(companions.map(([filename]) => [filename, unassigned]));
  const sourceAt = (filename, folder) => folder === unassigned
    ? companions.find(([page]) => page === filename)[1] : companionPath(filename);
  const contentPaths = () => [...baseContent, ...companions.flatMap(([filename]) => {
    const folder = locations.get(filename);
    return [`${folder}/${filename}`, `${folder}/${sourceAt(filename, folder)}`];
  })];
  await request('/api/entities', { method: 'POST', status: 201, body: { id: first, name: 'Source edge fixtures' } });
  assertLayout(head(), contentPaths());
  await request('/api/entities', { method: 'POST', status: 201, body: { id: second, name: 'Destination edge fixtures' } });
  assertLayout(head(), contentPaths());
  const originalPages = await servingState();
  const originalSources = await Promise.all(companions.map(async ([, filename]) => ({
    filename, bytes: await readFile(join(dataDir, filename)), mtimeNs: (await stat(join(dataDir, filename), { bigint: true })).mtimeNs,
  })));

  async function move(filename, target) {
    const before = head();
    const count = revisions().length;
    const oldPaths = names(before);
    const from = locations.get(filename);
    const result = await request(`/api/pages/${filename}`, { method: 'PATCH', body: { entityId: target === unassigned ? null : target } });
    assert.equal(result.page.entityId, target === unassigned ? null : target);
    assert.equal(revisions().length, count + 1, 'One API move must make exactly one atomic commit');
    assert.equal(local('rev-parse', `${head()}^`), before);
    locations.set(filename, target);
    assertLayout(head(), contentPaths());
    const newPaths = names(head());
    assert.deepEqual(changed(head()), [...new Set([catalogFile,
      ...oldPaths.filter(path => !newPaths.includes(path)), ...newPaths.filter(path => !oldPaths.includes(path))])].sort(),
    'A move must change only catalog, compiled/source paths and necessary empty markers');
    for (const [oldName, newName] of [[filename, filename], [sourceAt(filename, from), sourceAt(filename, target)]]) {
      assert.equal(local('rev-parse', `${head()}:${target}/${newName}`), local('rev-parse', `${before}:${from}/${oldName}`),
        'The same compiled/source blob must move together without re-rendering');
    }
    synced();
  }

  for (const [filename] of companions) await move(filename, first);
  for (const [filename, source] of companions) {
    const response = await fetch(new URL(`/api/entities/${first}/files/${encodeURIComponent(filename)}`, base), {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(dataDir, source)),
      'Same-stem HTML/HTM files must read their own exact source companion');
  }
  await request('/api/pages/history-pair.htm', {
    method: 'PUT', body: { html: '<!doctype html><html><head><title>Source collision</title></head><body>Must not overwrite its sibling source</body></html>' },
    status: 409,
  });
  const beforeRename = head();
  await request(`/api/entities/${first}`, { method: 'PATCH', body: { name: 'Renamed display name, same folder ID' } });
  assert.deepEqual(changed(head()), [catalogFile], 'Display rename must not rename stable-ID folders');
  assert.deepEqual(names(head()), names(beforeRename));
  for (const [filename] of companions) await move(filename, second);
  assert.ok(names(head()).includes(`${first}/.gitkeep`), 'Moving the last diagram out must restore an empty Entity marker');
  await request(`/api/entities/${first}`, { method: 'DELETE', status: 204 });
  assert.ok(!names(head()).some(path => path.startsWith(`${first}/`)), 'Deleting an empty Entity must remove its directory');
  for (const [filename] of companions) await move(filename, unassigned);
  assert.ok(names(head()).includes(`${second}/.gitkeep`));
  // Leave one empty Entity in the published fixture so a real clone proves it exists.
  await verifyServingState(originalPages);
  for (const saved of originalSources) {
    assert.deepEqual(await readFile(join(dataDir, saved.filename)), saved.bytes, 'Source stays in the flat serving directory unchanged');
    assert.equal((await stat(join(dataDir, saved.filename), { bigint: true })).mtimeNs, saved.mtimeNs);
  }
  auditHistory();
  console.log('PASS .htm/.src.html fallback, matching-extension source preference, mixed-case extensions, atomic moves and stable IDs/URLs/mtimes');
}

async function emptyLibrary() {
  assert.equal(revisions().length, 1, 'An empty library needs exactly one meaningful startup snapshot');
  assert.deepEqual(names(head()), [`${unassigned}/.gitkeep`]);
  assert.equal(blobBytes(head(), `${unassigned}/.gitkeep`).length, 0);
  synced();
  const id = 'history-empty-library';
  await request('/api/entities', { method: 'POST', status: 201, body: { id, name: 'Empty library Entity' } });
  assertLayout(head(), []);
  const html = '<!doctype html><html><head><title>Empty library</title></head><body>Real empty-library render</body></html>';
  const created = await request('/api/pages/history-empty.htm', { method: 'PUT', status: 201, render: true, body: { html } });
  assertLayout(head(), [`${unassigned}/history-empty.htm`]);
  assert.ok(!names(head()).includes(`${unassigned}/.gitkeep`), 'Unassigned marker must disappear when content arrives');
  const moved = await request('/api/pages/history-empty.htm', { method: 'PATCH', body: { entityId: id } });
  assert.equal(moved.page.url, created.page.url);
  assert.equal(moved.page.modified, created.page.modified);
  assertLayout(head(), [`${id}/history-empty.htm`]);
  assert.ok(names(head()).includes(`${unassigned}/.gitkeep`), 'Unassigned directory must persist when its last page moves out');
  const unassignedPage = await request('/api/pages/history-empty.htm', { method: 'PATCH', body: { entityId: null } });
  assert.equal(unassignedPage.page.url, created.page.url);
  assert.equal(unassignedPage.page.modified, created.page.modified);
  assertLayout(head(), [`${unassigned}/history-empty.htm`]);
  await cloneChecks('empty-clone');
  await request(`/api/entities/${id}`, { method: 'DELETE', status: 204 });
  assertLayout(head(), [`${unassigned}/history-empty.htm`]);
  synced();
  console.log('PASS empty-library startup, Entity markers, unassigned marker removal/restoration and actual .htm rendering');
}
