#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEventHub } from '../remote-app/events.mjs';

const WATCH_SH = fileURLToPath(new URL('../remote-app/static/watch.sh', import.meta.url));

function runWatcher(args, { env = {} } = {}) {
  const proc = spawn('/bin/sh', [WATCH_SH, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? '/tmp',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', chunk => { stdout += chunk; });
  proc.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return {
    proc,
    done,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close() {
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
          return new Promise(done => server.close(() => done()));
        },
      });
    });
  });
}

async function waitUntil(fn, timeoutMs = 4000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  assert.fail('Condition not met before timeout');
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childPidsOf(parentPid) {
  const res = spawnSync('ps', ['-o', 'pid=', '--ppid', String(parentPid)], { encoding: 'utf8' });
  if (res.status !== 0) return [];
  return res.stdout.trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

test('watch.sh passes strict POSIX sh -n syntax check and rejects missing args/key', () => {
  const syntax = spawnSync('/bin/sh', ['-n', WATCH_SH], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const noUrl = spawnSync('/bin/sh', [WATCH_SH], { env: { PATH: process.env.PATH, VE_KEY: 've_test' }, encoding: 'utf8' });
  assert.equal(noUrl.status, 1);
  assert.match(noUrl.stderr, /Missing required --url/);

  const noKey = spawnSync('/bin/sh', [WATCH_SH, '--url', 'http://127.0.0.1:1/events'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /Missing required VE_KEY/);
});

test('watch.sh swallows consecutive 204 polls locally, sends key via stdin (not argv), encodes params, and exits 0 on 200', async () => {
  const secret = 've_secret_canary_value_do_not_leak_in_argv_12345';
  const requests = [];
  let sawHiddenKey = false;
  const srv = await startServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    requests.push({
      auth: req.headers.authorization,
      once: u.searchParams.get('once'),
      timeout: u.searchParams.get('timeout'),
      client: u.searchParams.get('client'),
      path: u.searchParams.get('path'),
      events: u.searchParams.get('events'),
      after: u.searchParams.get('after'),
    });
    if (requests.length <= 2) {
      // Check ps output while curl is active: secret must NEVER appear in process argv
      const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
      if (ps.status === 0 && !ps.stdout.includes(secret)) sawHiddenKey = true;
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const payload = { id: '42', type: 'comment.created', path: '子文件夹/a b.html', body: 'Looks good' };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  });
  try {
    const w = runWatcher([
      '--url', `${srv.baseUrl}/api/entities/proj/events`,
      '--timeout', '1',
      '--client', 'test-agent',
      '--path', '子文件夹/a b.html',
      '--after', '40',
      '--no-singleton',
    ], { env: { VE_KEY: secret } });
    const res = await w.done;
    assert.equal(res.code, 0, res.stderr);
    assert.equal(requests.length, 3, 'Must loop silently over two 204 responses before returning on 3rd 200');
    assert.equal(sawHiddenKey, true, 'VE_KEY must not appear in process argv');
    for (const r of requests) {
      assert.equal(r.auth, `Bearer ${secret}`);
      assert.equal(r.once, '1');
      assert.equal(r.timeout, '1');
      assert.equal(r.client, 'test-agent');
      assert.equal(r.path, '子文件夹/a b.html');
      assert.equal(r.events, null, 'Default invocation must omit events= so all comment.* events trigger');
      assert.equal(r.after, '40');
    }
    const parsed = JSON.parse(res.stdout.trim());
    assert.deepEqual(parsed, { id: '42', type: 'comment.created', path: '子文件夹/a b.html', body: 'Looks good' });
  } finally {
    await srv.close();
  }
});

test('watch.sh auto-terminates immediately on mid-wait key expiry, key revocation, and folder deletion', async () => {
  const hub = createEventHub({ heartbeatMs: 0 });
  const srv = await startServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization || '';
    const tokenId = auth.replace(/^Bearer\s+/, '');
    const expiresAt = u.searchParams.get('expiresAt') || null;
    hub.subscribe(req, res, {
      entityId: u.searchParams.get('entityId') || 'proj',
      once: u.searchParams.get('once') === '1',
      timeoutSec: u.searchParams.get('timeout') || '30',
      client: u.searchParams.get('client') || '',
      tokenId,
      expiresAt,
    });
  });

  try {
    // 1. Mid-wait expiry fires -> 401 -> watch.sh exits 0 with key_expired
    const soonIso = new Date(Date.now() + 250).toISOString();
    const wExp = runWatcher([
      '--url', `${srv.baseUrl}/events?entityId=proj&expiresAt=${encodeURIComponent(soonIso)}`,
      '--timeout', '30',
      '--no-singleton',
    ], { env: { VE_KEY: 'tok_expiring' } });
    const rExp = await wExp.done;
    assert.equal(rExp.code, 0, rExp.stderr);
    assert.deepEqual(JSON.parse(rExp.stdout.trim()), { status: 'key_expired', httpCode: 401, action: 'stop' });

    // 2. Active revocation via disconnectByToken -> 401 -> watch.sh exits 0 immediately
    const wRev = runWatcher([
      '--url', `${srv.baseUrl}/events?entityId=proj`,
      '--timeout', '30',
      '--no-singleton',
    ], { env: { VE_KEY: 'tok_revoke_me' } });
    await waitUntil(() => hub.hostSummary({ entityId: 'proj' }).connectionCount === 1);
    hub.disconnectByToken('tok_revoke_me', 'Token revoked');
    const rRev = await wRev.done;
    assert.equal(rRev.code, 0, rRev.stderr);
    assert.deepEqual(JSON.parse(rRev.stdout.trim()), { status: 'key_expired', httpCode: 401, action: 'stop' });

    // 3. Active folder deletion via disconnectByEntity -> 404 -> watch.sh exits 0 with scope_gone
    const wDel = runWatcher([
      '--url', `${srv.baseUrl}/events?entityId=doomed`,
      '--timeout', '30',
      '--no-singleton',
    ], { env: { VE_KEY: 'tok_doomed' } });
    await waitUntil(() => hub.hostSummary({ entityId: 'doomed' }).connectionCount === 1);
    hub.disconnectByEntity('doomed', 'Folder deleted');
    const rDel = await wDel.done;
    assert.equal(rDel.code, 0, rDel.stderr);
    assert.deepEqual(JSON.parse(rDel.stdout.trim()), { status: 'scope_gone', httpCode: 404, action: 'stop' });
  } finally {
    hub.closeAll();
    await srv.close();
  }
});

test('watch.sh respects --max-idle-sec and retries across 503 + server restart without failing', async () => {
  // 1. --max-idle-sec stops cleanly after idle window
  const idleSrv = await startServer((req, res) => {
    setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
      }
    }, 600);
  });
  try {
    const wIdle = runWatcher([
      '--url', `${idleSrv.baseUrl}/events`,
      '--timeout', '5',
      '--max-idle-sec', '1',
      '--no-singleton',
    ], { env: { VE_KEY: 've_idle' } });
    const rIdle = await wIdle.done;
    assert.equal(rIdle.code, 0, rIdle.stderr);
    const out = JSON.parse(rIdle.stdout.trim());
    assert.equal(out.status, 'idle_timeout');
    assert.equal(out.action, 'stop');
    assert.ok(out.idleSec >= 1);
  } finally {
    await idleSrv.close();
  }

  // 2. Simulated 503 then full server shutdown + restart on same port -> watch.sh recovers and gets 200
  let attempt = 0;
  let port = 0;
  let server = http.createServer((req, res) => {
    attempt += 1;
    if (attempt === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Temporarily unavailable' }));
      return;
    }
    // Second request: immediately close socket to simulate restart
    req.socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  const wRetry = runWatcher([
    '--url', `http://127.0.0.1:${port}/events`,
    '--timeout', '5',
    '--no-singleton',
  ], { env: { VE_KEY: 've_retry' } });

  try {
    await waitUntil(() => attempt >= 2, 6000);
    // Shut down server briefly, then bring up replacement server on the same port returning 200
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise(done => server.close(() => done()));

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ id: '99', type: 'comment.replied', recovered: true }));
    });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

    const rRetry = await wRetry.done;
    assert.equal(rRetry.code, 0, rRetry.stderr);
    assert.deepEqual(JSON.parse(rRetry.stdout.trim()), { id: '99', type: 'comment.replied', recovered: true });
  } finally {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise(done => server.close(() => done()));
  }
});

test('watch.sh singleton PID lock terminates prior watcher and leaves zero orphaned curl processes', async () => {
  const hub = createEventHub({ heartbeatMs: 0 });
  const srv = await startServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    hub.subscribe(req, res, {
      entityId: 'singleton-proj',
      once: u.searchParams.get('once') === '1',
      timeoutSec: u.searchParams.get('timeout') || '60',
      client: u.searchParams.get('client') || '',
    });
  });
  const tmp = await mkdtemp(join(tmpdir(), 've-watch-pid-'));
  const pidFile = join(tmp, 'scope.pid');

  try {
    const w1 = runWatcher([
      '--url', `${srv.baseUrl}/events`,
      '--timeout', '60',
      '--client', 'first',
      '--pid-file', pidFile,
    ], { env: { VE_KEY: 've_singleton' } });

    await waitUntil(() => hub.hostSummary({ entityId: 'singleton-proj' }).connectionCount === 1);
    await waitUntil(() => existsSync(pidFile));
    const pid1 = Number((await readFile(pidFile, 'utf8')).trim());
    assert.equal(pid1, w1.proc.pid);
    const curlPids1 = childPidsOf(pid1);
    assert.ok(curlPids1.length >= 1, 'Expected active curl child process under first watcher');

    // Launch second watcher for the exact same PID lock -> must SIGTERM w1 and its curl cleanly!
    const w2 = runWatcher([
      '--url', `${srv.baseUrl}/events`,
      '--timeout', '60',
      '--client', 'second',
      '--pid-file', pidFile,
    ], { env: { VE_KEY: 've_singleton' } });

    const r1 = await w1.done;
    assert.ok(r1.code === 143 || r1.signal === 'SIGTERM', `Expected old watcher terminated by SIGTERM, got code=${r1.code} signal=${r1.signal}`);

    // Verify zero orphaned curl children from w1!
    for (const cpid of curlPids1) {
      await waitUntil(() => !isPidAlive(cpid), 2000);
    }

    // Verify w2 owns the PID file and is the sole live connection
    await waitUntil(async () => {
      const summary = hub.hostSummary({ entityId: 'singleton-proj' });
      return summary.connectionCount === 1 && summary.hosts[0]?.clients.includes('second');
    });
    assert.equal(Number((await readFile(pidFile, 'utf8')).trim()), w2.proc.pid);

    // Emit an event -> w2 exits cleanly and removes its PID file
    hub.emit({ type: 'comment.created', entityId: 'singleton-proj', filename: 'a.html', path: 'a.html', payload: { ok: true } });
    const r2 = await w2.done;
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(JSON.parse(r2.stdout.trim()).type, 'comment.created');
    assert.equal(existsSync(pidFile), false, 'PID file must be removed when owner exits cleanly');
  } finally {
    hub.closeAll();
    await srv.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('watch.sh --mode stream outputs NDJSON events, tracks Last-Event-ID across drops, and stops cleanly on auth.expired', async () => {
  const hub = createEventHub({ heartbeatMs: 0 });
  const srv = await startServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization || '';
    const tokenId = auth.replace(/^Bearer\s+/, '');
    hub.subscribe(req, res, {
      entityId: 'stream-proj',
      once: false,
      after: u.searchParams.get('after'),
      client: u.searchParams.get('client') || '',
      tokenId,
    });
  });

  try {
    const w = runWatcher([
      '--url', `${srv.baseUrl}/events`,
      '--mode', 'stream',
      '--client', 'streamer',
      '--no-singleton',
    ], { env: { VE_KEY: 'tok_stream' } });

    await waitUntil(() => hub.hostSummary({ entityId: 'stream-proj' }).connectionCount === 1);

    const e1 = hub.emit({ type: 'comment.created', entityId: 'stream-proj', filename: 'a.html', path: 'a.html', payload: { seq: 1 } });
    await waitUntil(() => w.getStdout().includes('"seq":1'));

    // Simulate server drop (closeAll) while emitting seq:2 during outage -> watch.sh reconnects with after=1 and replays seq:2!
    hub.closeAll();
    const e2 = hub.emit({ type: 'comment.replied', entityId: 'stream-proj', filename: 'a.html', path: 'a.html', payload: { seq: 2 } });

    await waitUntil(() => w.getStdout().includes('"seq":2'), 6000);
    await waitUntil(() => hub.hostSummary({ entityId: 'stream-proj' }).connectionCount === 1);

    // Revoke token -> server sends event: auth.expired -> watch.sh stops cleanly with key_expired
    hub.disconnectByToken('tok_stream', 'Token revoked');
    const res = await w.done;
    assert.equal(res.code, 0, res.stderr);
    const lines = res.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 3, `Expected 2 events + 1 stop message, got: ${res.stdout}`);
    assert.equal(lines[0].id, e1.event.id);
    assert.equal(lines[0].seq, 1);
    assert.equal(lines[1].id, e2.event.id);
    assert.equal(lines[1].seq, 2);
    assert.deepEqual(lines[2], { status: 'key_expired', action: 'stop' });
  } finally {
    hub.closeAll();
    await srv.close();
  }
});
