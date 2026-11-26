#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAccounts, createShares } from '../remote-app/accounts.mjs';
import { ApiError } from '../remote-app/catalog.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 've-accounts-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('owner defaults without eager write, renames cleanly, and persists across reload', () => withTempDir(async dir => {
  const accountsPath = join(dir, '.accounts.json');
  const store = await createAccounts(dir);

  assert.equal(store.ownerName(), 'Owner');
  assert.deepEqual(store.get('owner'), { id: 'owner', name: 'Owner', role: 'admin', builtIn: true });
  assert.equal(store.get('u_0000000000000000'), null);
  assert.deepEqual(store.list(), {
    owner: { id: 'owner', name: 'Owner', role: 'admin', builtIn: true },
    accounts: [],
  });
  await assert.rejects(() => stat(accountsPath), { code: 'ENOENT' });

  const renamed = await store.rename('owner', '  Alice Owner  ');
  assert.deepEqual(renamed, { id: 'owner', name: 'Alice Owner', role: 'admin', builtIn: true });
  assert.equal(store.ownerName(), 'Alice Owner');
  assert.equal((await stat(accountsPath)).mode & 0o777, 0o600);

  const reloaded = await createAccounts(dir);
  assert.equal(reloaded.ownerName(), 'Alice Owner');
  assert.deepEqual(reloaded.get('owner'), { id: 'owner', name: 'Alice Owner', role: 'admin', builtIn: true });
}));

test('accounts support admin/user lifecycle, constant-time auth, validation, owner protection, and private storage', () => withTempDir(async dir => {
  const accountsPath = join(dir, '.accounts.json');
  const store = await createAccounts(dir);

  // Validation errors on create
  for (const badName of ['', '   ', 'a'.repeat(65), '😀'.repeat(65), 'bad\nname', 'bad\x00name', 'lone\uD800surrogate', 123, null, undefined]) {
    await assert.rejects(
      () => store.create({ name: badName, role: 'user' }),
      error => error instanceof ApiError && error.status === 400,
    );
  }
  for (const badRole of ['viewer', 'owner', 'agent', 'editor', '', null, 42]) {
    await assert.rejects(
      () => store.create({ name: 'Valid', role: badRole }),
      error => error instanceof ApiError && error.status === 400,
    );
  }
  // Still no file written after rejected mutations
  await assert.rejects(() => stat(accountsPath), { code: 'ENOENT' });

  // Create regular user (default role) and admin
  const member = await store.create({ name: '  Bob Member  ' });
  assert.match(member.account.id, /^u_[0-9a-f]{16}$/);
  assert.match(member.secret, /^ve_usr_[A-Za-z0-9_-]{43}$/);
  assert.equal(member.account.name, 'Bob Member');
  assert.equal(member.account.role, 'user');
  assert.equal(member.account.builtIn, false);
  assert.equal('hash' in member.account, false);

  const unicodeName = '😀'.repeat(64);
  const admin = await store.create({ name: unicodeName, role: 'admin' });
  assert.equal(admin.account.name, unicodeName);
  assert.equal(admin.account.role, 'admin');
  assert.equal(admin.account.builtIn, false);
  assert.equal('hash' in admin.account, false);

  // File mode 0600 and no plaintext secrets on disk
  assert.equal((await stat(accountsPath)).mode & 0o777, 0o600);
  const rawDisk = await readFile(accountsPath, 'utf8');
  assert.equal(rawDisk.includes(member.secret), false);
  assert.equal(rawDisk.includes(admin.secret), false);

  // List sorted by createdAt asc, no hash leaked
  const listed = store.list();
  assert.equal(listed.owner.id, 'owner');
  assert.equal(listed.accounts.length, 2);
  assert.equal(listed.accounts[0].id, member.account.id);
  assert.equal(listed.accounts[1].id, admin.account.id);
  for (const item of listed.accounts) assert.equal('hash' in item, false);

  // Get without hash
  const fetched = store.get(member.account.id);
  assert.deepEqual(fetched, member.account);
  assert.equal('hash' in fetched, false);

  // Authentication valid and invalid
  assert.deepEqual(store.authenticate(member.secret), {
    id: member.account.id, name: 'Bob Member', role: 'user', builtIn: false,
  });
  assert.deepEqual(store.authenticate(admin.secret), {
    id: admin.account.id, name: unicodeName, role: 'admin', builtIn: false,
  });
  const wrongSecret = 've_usr_' + 'A'.repeat(43);
  for (const badSecret of [wrongSecret, 've_' + 'A'.repeat(43), member.secret.slice(0, -1), member.secret + 'x', '', null, undefined, 123]) {
    assert.equal(store.authenticate(badSecret), null);
  }

  // Rename account
  const updatedMember = await store.rename(member.account.id, 'Bob Senior');
  assert.equal(updatedMember.name, 'Bob Senior');
  assert.equal(updatedMember.id, member.account.id);
  assert.equal('hash' in updatedMember, false);
  assert.deepEqual(store.authenticate(member.secret), {
    id: member.account.id, name: 'Bob Senior', role: 'user', builtIn: false,
  });
  await assert.rejects(
    () => store.rename('u_deadbeefdeadbeef', 'Ghost'),
    error => error instanceof ApiError && error.status === 404,
  );

  // Owner cannot be deleted; missing account gives 404
  await assert.rejects(
    () => store.remove('owner'),
    error => error instanceof ApiError && error.status === 400 && error.message === 'Cannot delete built-in owner account',
  );
  await assert.rejects(
    () => store.remove('u_deadbeefdeadbeef'),
    error => error instanceof ApiError && error.status === 404,
  );

  // Delete member -> immediately fails auth and persists across reload
  await store.remove(member.account.id);
  assert.equal(store.authenticate(member.secret), null);
  assert.equal(store.get(member.account.id), null);
  assert.deepEqual(store.authenticate(admin.secret), {
    id: admin.account.id, name: unicodeName, role: 'admin', builtIn: false,
  });

  const reloaded = await createAccounts(dir);
  assert.equal(reloaded.authenticate(member.secret), null);
  assert.deepEqual(reloaded.authenticate(admin.secret), {
    id: admin.account.id, name: unicodeName, role: 'admin', builtIn: false,
  });
  assert.equal(reloaded.list().accounts.length, 1);
}));

test('guest share links require finite expiry, resolve active/expired/revoked, prune on create, and support forgetPage/restorePage rollback', () => withTempDir(async dir => {
  const sharesPath = join(dir, '.shares.json');
  let store = await createShares(dir);

  assert.deepEqual(store.list('page-a.html'), []);
  assert.deepEqual(store.resolve('A'.repeat(43)), { status: 'not_found' });
  await assert.rejects(() => stat(sharesPath), { code: 'ENOENT' });

  // Validate expiresIn strictly (must be finite integer 60..31536000)
  for (const badTtl of [undefined, null, 0, -60, 59, 60.5, 365 * 86400 + 1, Infinity, -Infinity, NaN, '3600', true]) {
    await assert.rejects(
      () => store.create({ filename: 'page-a.html', expiresIn: badTtl }),
      error => error instanceof ApiError && error.status === 400,
    );
  }
  // Validate filename and label
  for (const badFile of ['', '../evil.html', 'page.src.html', 'notes.txt']) {
    await assert.rejects(
      () => store.create({ filename: badFile, expiresIn: 3600 }),
      error => error instanceof ApiError && error.status === 400,
    );
  }
  for (const badLabel of ['x'.repeat(81), 'line\nbreak', 'nul\x00char', 'bad\uD800', 42]) {
    await assert.rejects(
      () => store.create({ filename: 'page-a.html', expiresIn: 3600, label: badLabel }),
      error => error instanceof ApiError && error.status === 400,
    );
  }
  await assert.rejects(() => stat(sharesPath), { code: 'ENOENT' });

  // Create valid shares (including boundary expiresIn 60 and 365*86400)
  const first = await store.create({
    filename: 'page-a.html',
    expiresIn: 60,
    label: '  Design review  ',
    createdBy: 'Alice',
  });
  assert.match(first.share.id, /^sh_[0-9a-f]{16}$/);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.share.filename, 'page-a.html');
  assert.equal(first.share.label, 'Design review');
  assert.equal(first.share.createdBy, 'Alice');
  assert.equal('hash' in first.share, false);

  const second = await store.create({
    filename: 'page-a.html',
    expiresIn: 365 * 86400,
  });
  assert.equal(second.share.label, '');
  assert.equal(second.share.createdBy, 'Owner');

  const otherPage = await store.create({
    filename: 'page-b.html',
    expiresIn: 3600,
    label: 'External demo',
  });

  // Mode 0600 and no raw tokens on disk
  assert.equal((await stat(sharesPath)).mode & 0o777, 0o600);
  const rawDisk = await readFile(sharesPath, 'utf8');
  assert.equal(rawDisk.includes(first.token), false);
  assert.equal(rawDisk.includes(second.token), false);
  assert.equal(rawDisk.includes(otherPage.token), false);

  // List active shares for page-a sorted newest first, no hash
  const listed = store.list('page-a.html');
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, second.share.id);
  assert.equal(listed[1].id, first.share.id);
  for (const item of listed) assert.equal('hash' in item, false);

  // Resolve valid and invalid tokens
  const resolved = store.resolve(first.token);
  assert.equal(resolved.status, 'ok');
  assert.deepEqual(resolved.share, first.share);
  assert.equal('hash' in resolved.share, false);
  for (const badToken of ['A'.repeat(43), 'too-short', first.token + 'x', '', null, undefined, 99]) {
    assert.deepEqual(store.resolve(badToken), { status: 'not_found' });
  }

  // Manipulate expiresAt of `first` on disk to the past and reload -> status: 'expired'
  const diskData = JSON.parse(await readFile(sharesPath, 'utf8'));
  const target = diskData.shares.find(entry => entry.id === first.share.id);
  target.expiresAt = new Date(Date.now() - 5000).toISOString();
  await writeFile(sharesPath, JSON.stringify(diskData) + '\n', { mode: 0o600 });

  store = await createShares(dir);
  const expiredResult = store.resolve(first.token);
  assert.equal(expiredResult.status, 'expired');
  assert.equal(expiredResult.share.id, first.share.id);
  assert.equal(expiredResult.share.filename, 'page-a.html');
  assert.equal(expiredResult.share.expiresAt, target.expiresAt);
  assert.equal('hash' in expiredResult.share, false);
  // Active list excludes expired share
  assert.deepEqual(store.list('page-a.html').map(s => s.id), [second.share.id]);

  // Creating a new share prunes already-expired shares on write
  const third = await store.create({ filename: 'page-a.html', expiresIn: 1200, label: 'Follow-up' });
  assert.deepEqual(store.resolve(first.token), { status: 'not_found' });
  const afterPruneDisk = JSON.parse(await readFile(sharesPath, 'utf8'));
  assert.equal(afterPruneDisk.shares.some(entry => entry.id === first.share.id), false);

  // Revoke with mismatched filename throws 404 without removing
  await assert.rejects(
    () => store.revoke(third.share.id, 'page-b.html'),
    error => error instanceof ApiError && error.status === 404,
  );
  assert.equal(store.resolve(third.token).status, 'ok');

  // Revoke with matching filename removes immediately and persists
  await store.revoke(third.share.id, 'page-a.html');
  assert.deepEqual(store.resolve(third.token), { status: 'not_found' });
  await assert.rejects(
    () => store.revoke(third.share.id),
    error => error instanceof ApiError && error.status === 404,
  );

  // forgetPage + restorePage rollback
  assert.deepEqual(await store.forgetPage('no-such-page.html'), []);
  const removed = await store.forgetPage('page-a.html');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, second.share.id);
  assert.equal(typeof removed[0].hash, 'string');
  assert.deepEqual(store.list('page-a.html'), []);
  assert.deepEqual(store.resolve(second.token), { status: 'not_found' });
  assert.equal(store.resolve(otherPage.token).status, 'ok');

  await store.restorePage(removed);
  // Idempotent second restore
  await store.restorePage(removed);
  assert.equal(store.resolve(second.token).status, 'ok');
  assert.deepEqual(store.list('page-a.html').map(s => s.id), [second.share.id]);

  // Survives reload after restorePage
  const reloaded = await createShares(dir);
  assert.equal(reloaded.resolve(second.token).status, 'ok');
  assert.equal(reloaded.resolve(otherPage.token).status, 'ok');
  assert.deepEqual(reloaded.resolve(third.token), { status: 'not_found' });
}));

test('stores reject symlinks, tighten loose file modes to 0600 on load, and serialize concurrent writes', () => withTempDir(async dir => {
  const accountsPath = join(dir, '.accounts.json');
  const sharesPath = join(dir, '.shares.json');

  // Concurrent mutations preserve all entries
  const accounts = await createAccounts(dir);
  const createdAccounts = await Promise.all([
    accounts.create({ name: 'User 1', role: 'user' }),
    accounts.create({ name: 'User 2', role: 'admin' }),
    accounts.create({ name: 'User 3' }),
  ]);
  assert.equal(accounts.list().accounts.length, 3);
  for (const item of createdAccounts) assert.ok(accounts.authenticate(item.secret));

  const shares = await createShares(dir);
  const createdShares = await Promise.all([
    shares.create({ filename: 'concurrent.html', expiresIn: 300, label: 'S1' }),
    shares.create({ filename: 'concurrent.html', expiresIn: 300, label: 'S2' }),
    shares.create({ filename: 'concurrent.html', expiresIn: 300, label: 'S3' }),
  ]);
  assert.equal(shares.list('concurrent.html').length, 3);
  for (const item of createdShares) assert.equal(shares.resolve(item.token).status, 'ok');

  // Loose permissions are tightened back to 0600 on load
  await chmod(accountsPath, 0o644);
  await chmod(sharesPath, 0o644);
  await createAccounts(dir);
  await createShares(dir);
  assert.equal((await stat(accountsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(sharesPath)).mode & 0o777, 0o600);

  // Symlink stores are refused
  const symDir = await mkdtemp(join(tmpdir(), 've-accounts-sym-'));
  try {
    await symlink(accountsPath, join(symDir, '.accounts.json'));
    await symlink(sharesPath, join(symDir, '.shares.json'));
    await assert.rejects(() => createAccounts(symDir), /regular private file/);
    await assert.rejects(() => createShares(symDir), /regular private file/);
  } finally {
    await rm(symDir, { recursive: true, force: true });
  }
}));
