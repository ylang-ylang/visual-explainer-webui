#!/usr/bin/env node
// Create only disposable fixtures owned by scripts/check-image.sh, before startup.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert.ok(process.env.VE_HISTORY_FIXTURE, 'Use scripts/check-image.sh');
const fixture = resolve(process.env.VE_HISTORY_FIXTURE);
const data = join(fixture, 'data');
const remote = join(fixture, 'remote', 'repo.git');
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 30000 }).trimEnd();
}
git('init', '--bare', '--initial-branch=main', remote);
git('init', '--initial-branch=main', data);
git('-C', data, 'config', 'user.name', 'Legacy fixture owner');
git('-C', data, 'config', 'user.email', 'legacy-fixture@localhost');
git('-C', data, 'add', '--', 'legacy.html', 'LEGACY.src.HTM');
git('-C', data, 'commit', '-m', 'Legacy flat content before folder projection');
const legacy = git('-C', data, 'rev-parse', 'HEAD');
git('-C', data, 'push', remote, 'main');
// Store the path visible to the service, not the host's disposable directory.
git('-C', data, 'remote', 'add', 'origin', '/history-remote/repo.git');
await writeFile(join(data, 'staged-canary.txt'), 'HISTORY_STAGED_CANARY\n');
git('-C', data, 'add', '--', 'staged-canary.txt');
await writeFile(join(fixture, 'legacy-checkpoint.json'), JSON.stringify({
  legacy,
  index: (await readFile(join(data, '.git', 'index'))).toString('base64'),
}));
