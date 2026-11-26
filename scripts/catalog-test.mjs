#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createCatalog } from '../remote-app/catalog.mjs';
import { createHistory } from '../remote-app/history.mjs';

const date = '2025-01-01T00:00:00.000Z';
const entity = id => ({ id, name: id.toUpperCase(), createdAt: date, updatedAt: date });
for (const version of [1, 2]) test(`v${version} migrates to backed-up v3 without changing identities or serving bytes`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 've-catalog-migration-'));
  try {
    const source = '<html>exact source</html>\n';
    const input = JSON.stringify({ version, entities: [entity('a')], pages: {
      'stable.html': version === 1 ? 'a' : { entityId: 'a', path: 'topic/stable.html' },
    }, ...(version === 2 ? { folders: { a: ['empty/deep'] } } : {}) }, null, 2) + '\n';
    await writeFile(join(dir, '.entities.json'), input);
    await writeFile(join(dir, 'stable.html'), source);
    await writeFile(join(dir, 'stable.src.html'), source);
    const catalog = await createCatalog(dir);
    assert.equal(JSON.parse(await readFile(join(dir, '.entities.json'))).version, 3);
    assert.equal(catalog.entity('a').parent, null);
    assert.deepEqual(catalog.location('stable.html'), { entityId: 'a', path: version === 1 ? 'stable.html' : 'topic/stable.html' });
    const backups = (await readdir(dir)).filter(name => name.startsWith('.entities.pre-v3.'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(dir, backups[0]), 'utf8'), input);
    assert.equal((await stat(join(dir, backups[0]))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(dir, 'stable.html'), 'utf8'), source);
    assert.equal(await readFile(join(dir, 'stable.src.html'), 'utf8'), source);
    const before = await readFile(join(dir, '.entities.json'), 'utf8');
    await createCatalog(dir);
    assert.equal(await readFile(join(dir, '.entities.json'), 'utf8'), before);
    assert.equal((await readdir(dir)).filter(name => name.startsWith('.entities.pre-v3.')).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('history preserves legacy root companion suffixes/case and projects genuinely renamed root sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 've-root-sources-'));
  const settings = ['GIT_HISTORY_REMOTE', 'GIT_HISTORY_SSH_KEY', 'GIT_HISTORY_KNOWN_HOSTS'];
  const saved = settings.map(name => process.env[name]);
  for (const name of settings) delete process.env[name]; // Never use a developer's history remote or credentials.
  try {
    const fixtures = [['edge.htm', 'edge.src.html'], ['mixed.HTM', 'mixed.src.HTML']];
    for (const [page, source] of fixtures) {
      await writeFile(join(dir, page), `<html>${page}</html>\n`);
      await writeFile(join(dir, source), `<!-- exact source ${source} -->\n`);
    }
    const c = await createCatalog(dir);
    await c.create('a', 'A');
    const history = await createHistory(dir, c);
    const initial = await history.snapshot('Legacy root sources');
    const paths = () => execFileSync('git', [`--git-dir=${join(dir, '.git')}`, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim().split('\n');
    for (const [page, source] of fixtures) {
      assert.ok(paths().includes('_unassigned/' + source), 'Unmoved root sources retain their exact extension and case');
      assert.equal((await history.version(page, initial)).html, `<!-- exact source ${source} -->\n`);
    }
    await c.assign('edge.htm', 'a', 'nested/renamed.htm');
    const assigned = await history.snapshot('Assign legacy source');
    assert.ok(paths().includes('a/nested/renamed.src.htm'));
    assert.equal((await history.version('edge.htm', assigned)).html, '<!-- exact source edge.src.html -->\n');
    await c.assign('edge.htm', null, 'renamed-root.html');
    const root = await history.snapshot('Rename at root');
    assert.ok(paths().includes('_unassigned/renamed-root.src.html'));
    assert.equal((await history.version('edge.htm', root)).html, '<!-- exact source edge.src.html -->\n');
    assert.equal((await history.version('edge.htm', initial)).html, '<!-- exact source edge.src.html -->\n');
    for (const [, source] of fixtures) assert.equal(await readFile(join(dir, source), 'utf8'), `<!-- exact source ${source} -->\n`);
  } finally {
    for (const [index, name] of settings.entries()) if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index];
    await rm(dir, { recursive: true, force: true });
  }
});

test('atomic hierarchy moves, mixed anchored subtrees, scoped resolution and root promotion survive reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 've-catalog-moves-'));
  try {
    let c = await createCatalog(dir);
    for (const id of ['a', 'b', 'c']) await c.create(id, id.toUpperCase());
    await c.createFolder('a', 'src/nested');
    await c.createFolder('b', 'dest');
    await c.assign('one.html', 'a', 'src/nested/one.html');
    await c.assign('two.html', 'c', 'two.html');
    const folder = (entityId, path = '') => ({ kind: 'folder', entityId, path });
    await c.move(folder('c'), { entityId: 'a', path: 'src/nested' });
    assert.equal(c.find('a', 'src/nested/C/two.html'), 'two.html');
    await c.move(folder('a', 'src'), { entityId: 'b', path: 'dest' });
    assert.deepEqual(c.entity('c').parent, { entityId: 'b', path: 'dest/src/nested' });
    assert.equal(c.find('b', 'dest/src/nested/C/two.html'), 'two.html');
    assert.equal(c.find('c', 'two.html'), 'two.html');
    assert.equal(c.inScope('a', 'c'), false);
    assert.equal(c.inScope('b', 'c'), true);
    async function unchanged(action, status = 409) {
      const before = await readFile(join(dir, '.entities.json'), 'utf8');
      await assert.rejects(action, error => error.status === status);
      assert.equal(await readFile(join(dir, '.entities.json'), 'utf8'), before);
    }
    await unchanged(() => c.move(folder('b'), { entityId: 'c', path: '' }));
    await unchanged(() => c.move(folder('b', 'dest/src'), { entityId: 'b', path: 'dest/src/nested' }));
    await unchanged(() => c.move(folder('c'), { entityId: 'c', path: '' }));
    await c.createFolder('a', 'src');
    await unchanged(() => c.move(folder('b', 'dest/src'), { entityId: 'a', path: '' }));
    await c.createFolder('a', 'a.html');
    await unchanged(() => c.assign('one.html', 'a', 'a.html'));
    await unchanged(() => c.move(folder('c'), { entityId: 'a', path: '' }, 'a.html'));
    await unchanged(() => c.move(folder('c'), { entityId: 'a', path: '' }, undefined, 'b'), 403);
    const deepest = Array.from({ length: 32 }, () => 'd').join('/');
    await c.createFolder('a', deepest);
    await unchanged(() => c.move(folder('c'), { entityId: 'a', path: deepest }), 400);
    for (let path = deepest; path; path = path.split('/').slice(0, -1).join('/')) await c.removeFolder('a', path);
    const before = await readFile(join(dir, '.entities.json'), 'utf8');
    assert.equal((await c.move(folder('c'), { entityId: 'b', path: 'dest/src/nested' })).moved, false);
    assert.equal(await readFile(join(dir, '.entities.json'), 'utf8'), before);
    const promoted = await c.move(folder('b', 'dest/src'), { entityId: null, path: '' });
    assert.equal(c.entity(promoted.entityId).name, 'src');
    assert.equal(c.entity(promoted.entityId).parent, null);
    assert.equal(c.entity('c').parent.entityId, promoted.entityId);
    await c.move(folder('a'), { entityId: 'b', path: 'dest' });
    assert.deepEqual(c.entity('a').parent, { entityId: 'b', path: 'dest' });
    await c.move(folder('a'), { entityId: null, path: '' });
    assert.equal(c.entity('a').parent, null);
    await c.move({ kind: 'page', filename: 'one.html' }, { entityId: null, path: '' });
    assert.deepEqual(c.location('one.html'), { entityId: null, path: 'one.html' });
    c = await createCatalog(dir);
    assert.equal(c.find('c', 'two.html'), 'two.html');
    assert.equal(c.entity('c').parent.entityId, promoted.entityId);
    assert.equal(c.entity('a').parent, null);
    assert.deepEqual(c.location('one.html'), { entityId: null, path: 'one.html' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('moving or renaming a Wiki parent page atomically carries its child subtree and rejects cycles or root moves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 've-catalog-wiki-move-'));
  try {
    let c = await createCatalog(dir);
    for (const id of ['arch', 'other', 'sub']) await c.create(id, id.toUpperCase());
    await c.assign('sys.html', 'arch', 'system.html');
    await c.assign('gw.html', 'arch', 'system/api-gateway.html');
    await c.assign('tb.html', 'arch', 'system/api-gateway/token-bucket.html');
    await c.assign('leaf.html', 'arch', 'standalone.html');
    await c.move({ kind: 'folder', entityId: 'sub', path: '' }, { entityId: 'arch', path: 'system/api-gateway' });
    await c.assign('subpage.html', 'sub', 'detail.html');

    async function unchanged(action, status = 409) {
      const before = await readFile(join(dir, '.entities.json'), 'utf8');
      await assert.rejects(action, error => error.status === status);
      assert.equal(await readFile(join(dir, '.entities.json'), 'utf8'), before);
    }

    // Reject Root move and self/descendant cycles (including through an anchored child).
    await unchanged(() => c.movePage('sys.html', null, 'system.html'), 409);
    await unchanged(() => c.move({ kind: 'page', filename: 'sys.html' }, { entityId: null, path: '' }), 409);
    await unchanged(() => c.movePage('sys.html', 'arch', 'system/system.html'), 409);
    await unchanged(() => c.movePage('sys.html', 'arch', 'system/api-gateway/system.html'), 409);
    await unchanged(() => c.movePage('sys.html', 'sub', 'system.html'), 409);

    // Rename system.html -> platform.html in place.
    const renamed = await c.movePage('sys.html', 'arch', 'platform.html');
    assert.equal(renamed.moved, true);
    assert.deepEqual(c.location('sys.html'), { entityId: 'arch', path: 'platform.html' });
    assert.deepEqual(c.location('gw.html'), { entityId: 'arch', path: 'platform/api-gateway.html' });
    assert.deepEqual(c.location('tb.html'), { entityId: 'arch', path: 'platform/api-gateway/token-bucket.html' });
    assert.deepEqual(c.entity('sub').parent, { entityId: 'arch', path: 'platform/api-gateway' });
    assert.equal(c.find('arch', 'platform/api-gateway/SUB/detail.html'), 'subpage.html');
    assert.ok(!c.folders('arch').some(f => f.path === 'system' || f.path.startsWith('system/')));

    // Move platform.html to another entity via catalog.move().
    await c.createFolder('other', 'migrated');
    const moved = await c.move({ kind: 'page', filename: 'sys.html' }, { entityId: 'other', path: 'migrated' });
    assert.equal(moved.moved, true);
    assert.deepEqual(c.location('sys.html'), { entityId: 'other', path: 'migrated/platform.html' });
    assert.deepEqual(c.location('gw.html'), { entityId: 'other', path: 'migrated/platform/api-gateway.html' });
    assert.deepEqual(c.location('tb.html'), { entityId: 'other', path: 'migrated/platform/api-gateway/token-bucket.html' });
    assert.deepEqual(c.entity('sub').parent, { entityId: 'other', path: 'migrated/platform/api-gateway' });

    // Leaf page without Wiki children can still move to Root normally.
    await c.move({ kind: 'page', filename: 'leaf.html' }, { entityId: null, path: '' });
    assert.deepEqual(c.location('leaf.html'), { entityId: null, path: 'standalone.html' });

    // Reload from disk verifies persistence.
    c = await createCatalog(dir);
    assert.deepEqual(c.location('gw.html'), { entityId: 'other', path: 'migrated/platform/api-gateway.html' });
    assert.deepEqual(c.location('tb.html'), { entityId: 'other', path: 'migrated/platform/api-gateway/token-bucket.html' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
