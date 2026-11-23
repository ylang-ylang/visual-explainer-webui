#!/usr/bin/env node
// Create only disposable fixtures owned by scripts/check-image.sh, before startup.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert.ok(process.env.VE_HISTORY_FIXTURE, 'Use scripts/check-image.sh');
const fixture = resolve(process.env.VE_HISTORY_FIXTURE);
const data = join(fixture, 'data');
const remote = join(fixture, 'remote', 'repo.git');
const projected = process.argv.includes('--projected');
assert.ok(process.argv.slice(2).every(arg => arg === '--projected') && process.argv.length <= 3);
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 30000 }).trimEnd();
}
git('init', '--bare', '--initial-branch=main', remote);
const timestamp = '2026-01-01T00:00:00.000Z';
const catalog = {
  version: 1,
  entities: projected ? [{ id: 'migration-space', name: 'Migrated space', createdAt: timestamp, updatedAt: timestamp }] : [],
  pages: projected ? { 'legacy.html': 'migration-space' } : {},
};
await writeFile(join(data, '.entities.json'), `${JSON.stringify(catalog, null, 2)}\n`);
if (projected) {
  const worktree = join(fixture, 'seed-worktree');
  await mkdir(join(worktree, 'migration-space'), { recursive: true });
  await mkdir(join(worktree, '_unassigned'));
  await writeFile(join(worktree, '.entities.json'), await readFile(join(data, '.entities.json')));
  await writeFile(join(worktree, 'migration-space', 'legacy.html'), await readFile(join(data, 'legacy.html')));
  await writeFile(join(worktree, '_unassigned', '.gitkeep'), '');
  git('init', '--initial-branch=main', worktree);
  git('-C', worktree, 'config', 'user.name', 'Legacy fixture owner');
  git('-C', worktree, 'config', 'user.email', 'legacy-fixture@localhost');
  git('-C', worktree, 'add', '--', '.entities.json', 'migration-space/legacy.html', '_unassigned/.gitkeep');
  git('-C', worktree, 'commit', '-m', 'Existing v1 projected bare history');
  git('clone', '--bare', worktree, join(data, '.git'));
  git('--git-dir', join(data, '.git'), 'remote', 'set-url', 'origin', '/history-remote/repo.git');
} else {
  git('init', '--initial-branch=main', data);
  git('-C', data, 'config', 'user.name', 'Legacy fixture owner');
  git('-C', data, 'config', 'user.email', 'legacy-fixture@localhost');
  git('-C', data, 'add', '--', 'legacy.html', 'LEGACY.src.HTM', '.entities.json');
  git('-C', data, 'commit', '-m', 'Legacy flat content and v1 catalog before folder projection');
  // Store the path visible to the service, not the host's disposable directory.
  git('-C', data, 'remote', 'add', 'origin', '/history-remote/repo.git');
  await writeFile(join(data, 'staged-canary.txt'), 'HISTORY_STAGED_CANARY\n');
  git('-C', data, 'add', '--', 'staged-canary.txt');
}
const legacy = git('--git-dir', join(data, '.git'), 'rev-parse', 'HEAD');
git('--git-dir', join(data, '.git'), 'push', remote, 'main');
await writeFile(join(fixture, 'legacy-checkpoint.json'), JSON.stringify({
  legacy,
  ...(projected ? {} : { index: (await readFile(join(data, '.git', 'index'))).toString('base64') }),
}));
