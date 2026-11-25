#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatalog } from '../remote-app/catalog.mjs';

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
