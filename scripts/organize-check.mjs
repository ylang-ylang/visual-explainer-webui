#!/usr/bin/env node
// Host harness: never contact production, and never print the private checkpoint.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

assert.ok(process.env.VE_HISTORY_FIXTURE && process.env.VE_HISTORY_CONTAINER, 'Use an isolated disposable container');
const base = new URL(process.env.VE_BASE_URL);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const name = process.env.VE_HISTORY_CONTAINER;
const source = await readFile(new URL('./organize-smoke.mjs', import.meta.url), 'utf8');
for (const phase of ['mutations', 'persistence']) {
  if (phase === 'persistence') {
    execFileSync('docker', ['restart', name], { timeout: 30000, stdio: 'pipe' });
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const response = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(1000) });
        ready = response.status === 200 && await response.text() === 'ok';
        if (ready) break;
      } catch {}
      await setTimeout(1000);
    }
    assert.ok(ready, 'Disposable container must restart');
  }
  const result = spawnSync('docker', ['exec', '--interactive', '--env', 'VE_ORGANIZE_SMOKE=1',
    '--env', `VE_ORGANIZE_PHASE=${phase}`, '--workdir', '/opt/bridge', name, 'node', '--input-type=module'], {
    input: source, encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, (result.stderr || result.error?.message || 'Drag regression failed').replace(/ve_[A-Za-z0-9_-]{43}/g, '[redacted]'));
  process.stdout.write(result.stdout);
  if (phase === 'mutations') {
    const evidence = process.env.VE_ORGANIZE_EVIDENCE || await mkdtemp(join(tmpdir(), 've-drag-evidence-'));
    await mkdir(evidence, { recursive: true });
    for (const file of ['ve-drag-desktop.png', 've-drag-narrow.png', 've-drag-target.png', 've-drag-rejected.png']) execFileSync('docker', ['cp', `${name}:/tmp/${file}`, join(evidence, file)], { stdio: 'pipe' });
    console.log(`Browser evidence: ${evidence}`);
  }
}
