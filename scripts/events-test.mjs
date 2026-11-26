#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { ApiError } from '../remote-app/catalog.mjs';
import { createEventHub, normalizeClientIp } from '../remote-app/events.mjs';

function startTestServer(hub, { inScope = null } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const entityId = url.searchParams.has('entityId')
      ? (url.searchParams.get('entityId') === 'null' ? null : url.searchParams.get('entityId'))
      : null;
    const filename = url.searchParams.get('filename') || null;
    const path = url.searchParams.get('path') || '';
    const eventsParam = url.searchParams.get('events');
    const events = eventsParam ? eventsParam.split(',').filter(Boolean) : null;
    const after = url.searchParams.get('after');
    const once = url.searchParams.get('once') === '1';
    const timeoutSec = url.searchParams.has('timeout') ? url.searchParams.get('timeout') : undefined;
    const client = url.searchParams.get('client') ?? '';
    const ip = url.searchParams.has('ip') ? url.searchParams.get('ip') : undefined;
    try {
      hub.subscribe(req, res, {
        entityId,
        filename,
        path,
        events,
        after,
        once,
        timeoutSec,
        client,
        ip,
        inScope,
      });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        async close() {
          hub.closeAll();
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
          await new Promise(done => server.close(() => done()));
        },
      });
    });
  });
}

function openSse(baseUrl, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, { method: 'GET', headers }, res => {
      res.setEncoding('utf8');
      let buffer = '';
      const blocks = [];
      const waiters = [];

      const flushWaiters = () => {
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          const waiter = waiters[i];
          const idx = blocks.findIndex(waiter.predicate);
          if (idx !== -1) {
            waiters.splice(i, 1);
            clearTimeout(waiter.timer);
            const [matched] = blocks.splice(idx, 1);
            waiter.resolve(matched);
          }
        }
      };

      res.on('data', chunk => {
        buffer += chunk;
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          blocks.push(parseSseBlock(raw));
        }
        flushWaiters();
      });

      const ended = new Promise(done => {
        res.on('end', done);
        res.on('close', done);
      });

      resolve({
        status: res.statusCode,
        headers: res.headers,
        ended,
        waitFor(predicate, timeoutMs = 2000) {
          const existing = blocks.findIndex(predicate);
          if (existing !== -1) return Promise.resolve(blocks.splice(existing, 1)[0]);
          return new Promise((resWait, rejWait) => {
            const waiter = {
              predicate,
              resolve: resWait,
              timer: setTimeout(() => {
                const idx = waiters.indexOf(waiter);
                if (idx !== -1) waiters.splice(idx, 1);
                rejWait(new Error(`Timed out waiting for SSE block (received: ${JSON.stringify(blocks)})`));
              }, timeoutMs),
            };
            waiters.push(waiter);
          });
        },
        pendingBlocks() { return [...blocks]; },
        close() {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on('error', err => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
    req.end();
  });
}

function parseSseBlock(raw) {
  const lines = raw.split('\n');
  if (lines.every(line => line.startsWith(':'))) {
    return { kind: 'comment', comment: lines.map(line => line.slice(1).trim()).join('\n') };
  }
  const parsed = { kind: 'event', id: null, event: null, data: null };
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('id:')) parsed.id = line.slice(3).trim();
    else if (line.startsWith('event:')) parsed.event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length) parsed.data = JSON.parse(dataLines.join('\n'));
  return parsed;
}

function httpGet(baseUrl, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, { method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json: text ? JSON.parse(text) : null,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitUntil(fn, timeoutMs = 1500, intervalMs = 15) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise(done => setTimeout(done, intervalMs));
  }
  assert.fail('Condition not met before timeout');
}

test('normalizeClientIp handles IPv4-mapped IPv6, forwarded lists, brackets, and empty inputs', () => {
  assert.equal(normalizeClientIp('::ffff:192.168.201.237'), '192.168.201.237');
  assert.equal(normalizeClientIp('::FFFF:10.0.0.5'), '10.0.0.5');
  assert.equal(normalizeClientIp('0:0:0:0:0:ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeClientIp('[::ffff:192.168.1.5]'), '192.168.1.5');
  assert.equal(normalizeClientIp('192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeClientIp('::ffff:192.168.1.5, 10.0.0.1'), '192.168.1.5');
  assert.equal(normalizeClientIp('::1'), '::1');
  assert.equal(normalizeClientIp(' 2001:DB8::1 '), '2001:db8::1');
  assert.equal(normalizeClientIp(''), 'unknown');
  assert.equal(normalizeClientIp('   '), 'unknown');
  assert.equal(normalizeClientIp(null), 'unknown');
  assert.equal(normalizeClientIp(undefined), 'unknown');
});

test('subscribe validates event types, timeoutSec, after, and sanitizes client label', async () => {
  const hub = createEventHub({ heartbeatMs: 0 });
  const srv = await startTestServer(hub);
  try {
    const badEvent = await httpGet(srv.baseUrl, '/events?events=comment.created,bogus.event');
    assert.equal(badEvent.status, 400);
    assert.match(badEvent.json.error, /Unknown event type/);

    const badOnceTimeout = await httpGet(srv.baseUrl, '/events?once=1&timeout=0');
    assert.equal(badOnceTimeout.status, 400);

    const tooBigTimeout = await httpGet(srv.baseUrl, '/events?once=1&timeout=3601');
    assert.equal(tooBigTimeout.status, 400);

    const badAfter = await httpGet(srv.baseUrl, '/events?after=not-a-number');
    assert.equal(badAfter.status, 400);

    // Control characters stripped and length capped at 64.
    const longClient = `  agent\x00\x07-${'x'.repeat(80)}  `;
    const sse = await openSse(srv.baseUrl, `/events?entityId=proj&ip=10.0.0.8&client=${encodeURIComponent(longClient)}`);
    try {
      await sse.waitFor(b => b.kind === 'comment' && b.comment === 'connected');
      const summary = hub.hostSummary({ entityId: 'proj' });
      assert.equal(summary.hostCount, 1);
      assert.equal(summary.hosts[0].clients.length, 1);
      assert.equal(summary.hosts[0].clients[0].length, 64);
      assert.ok(summary.hosts[0].clients[0].startsWith('agent-'));
      assert.ok(!/[\x00-\x1f\x7f]/.test(summary.hosts[0].clients[0]));
    } finally {
      sse.close();
    }
  } finally {
    await srv.close();
  }
});

test('SSE connect, heartbeat, live event delivery, and Last-Event-ID replay with ring buffer', async () => {
  const hub = createEventHub({ maxHistory: 3, heartbeatMs: 40 });
  const srv = await startTestServer(hub);
  try {
    const sse = await openSse(srv.baseUrl, '/events?entityId=team-a&ip=192.168.10.2&client=watcher');
    try {
      assert.equal(sse.status, 200);
      assert.equal(sse.headers['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal(sse.headers['cache-control'], 'no-cache, no-store');
      assert.equal(sse.headers['x-accel-buffering'], 'no');

      const connected = await sse.waitFor(b => b.kind === 'comment' && b.comment === 'connected');
      assert.equal(connected.comment, 'connected');

      const ping = await sse.waitFor(b => b.kind === 'comment' && b.comment === 'ping');
      assert.equal(ping.comment, 'ping');

      const delivery = hub.emit({
        type: 'comment.created',
        entityId: 'team-a',
        filename: 'arch.html',
        path: 'docs/arch.html',
        payload: { threadId: 'c_1', body: 'Please clarify arrow' },
      });
      assert.equal(delivery.event.id, '1');
      assert.equal(delivery.event.type, 'comment.created');
      assert.ok(Number.isFinite(Date.parse(delivery.event.timestamp)));
      assert.equal(delivery.deliveredConnections, 1);
      assert.equal(delivery.deliveredHosts, 1);

      const frame = await sse.waitFor(b => b.kind === 'event');
      assert.equal(frame.id, '1');
      assert.equal(frame.event, 'comment.created');
      assert.deepEqual(frame.data, delivery.event);
      assert.equal(frame.data.threadId, 'c_1');
      assert.equal(frame.data.body, 'Please clarify arrow');
    } finally {
      sse.close();
    }

    // Emit 3 more events so history (maxHistory=3) holds IDs 2, 3, 4 (evicting 1).
    hub.emit({ type: 'comment.replied', entityId: 'team-a', filename: 'arch.html', path: 'docs/arch.html', payload: { seq: 2 } });
    hub.emit({ type: 'comment.dispatch', entityId: 'team-b', filename: 'other.html', path: 'other.html', payload: { seq: 3 } });
    hub.emit({ type: 'comment.reopened', entityId: 'team-a', filename: 'arch.html', path: 'docs/arch.html', payload: { seq: 4 } });

    // Reconnect with Last-Event-ID: 1 -> replays matching buffered events > 1 (IDs 2 and 4; skips 3 from team-b).
    const replaySse = await openSse(srv.baseUrl, '/events?entityId=team-a', { 'Last-Event-ID': '1' });
    try {
      await replaySse.waitFor(b => b.kind === 'comment' && b.comment === 'connected');
      const ev2 = await replaySse.waitFor(b => b.kind === 'event' && b.id === '2');
      assert.equal(ev2.event, 'comment.replied');
      assert.equal(ev2.data.seq, 2);
      const ev4 = await replaySse.waitFor(b => b.kind === 'event' && b.id === '4');
      assert.equal(ev4.event, 'comment.reopened');
      assert.equal(ev4.data.seq, 4);
      assert.ok(!replaySse.pendingBlocks().some(b => b.kind === 'event' && b.id === '3'));
    } finally {
      replaySse.close();
    }
  } finally {
    await srv.close();
  }
});

test('SSE event type filtering and entity/file scoping including hierarchical inScope', async () => {
  const parents = new Map([['child', 'parent']]);
  const inScope = (scopeId, targetId) => {
    let cur = targetId;
    while (cur !== null && cur !== undefined) {
      if (cur === scopeId) return true;
      cur = parents.get(cur) ?? null;
    }
    return false;
  };

  const hub = createEventHub({ heartbeatMs: 0 });
  const srv = await startTestServer(hub, { inScope });
  const connections = [];
  try {
    const globalSub = await openSse(srv.baseUrl, '/events?entityId=null&ip=10.0.0.1');
    const parentSub = await openSse(srv.baseUrl, '/events?entityId=parent&ip=10.0.0.2');
    const fileSub = await openSse(srv.baseUrl, '/events?entityId=child&filename=a.html&ip=10.0.0.3');
    const dispatchSub = await openSse(srv.baseUrl, '/events?entityId=child&events=comment.dispatch&ip=10.0.0.4');
    connections.push(globalSub, parentSub, fileSub, dispatchSub);

    for (const conn of connections) {
      await conn.waitFor(b => b.kind === 'comment' && b.comment === 'connected');
    }

    // 1) comment.created on child/a.html -> global, parent, fileSub (3 connections, 3 hosts).
    const r1 = hub.emit({ type: 'comment.created', entityId: 'child', filename: 'a.html', path: 'a.html', payload: { tag: 'r1' } });
    assert.equal(r1.deliveredConnections, 3);
    assert.equal(r1.deliveredHosts, 3);
    assert.equal((await globalSub.waitFor(b => b.kind === 'event' && b.data.tag === 'r1')).id, r1.event.id);
    assert.equal((await parentSub.waitFor(b => b.kind === 'event' && b.data.tag === 'r1')).id, r1.event.id);
    assert.equal((await fileSub.waitFor(b => b.kind === 'event' && b.data.tag === 'r1')).id, r1.event.id);

    // 2) comment.created on child/b.html -> global, parent only (2 connections).
    const r2 = hub.emit({ type: 'comment.created', entityId: 'child', filename: 'b.html', path: 'b.html', payload: { tag: 'r2' } });
    assert.equal(r2.deliveredConnections, 2);
    assert.equal(r2.deliveredHosts, 2);
    assert.equal((await globalSub.waitFor(b => b.kind === 'event' && b.data.tag === 'r2')).id, r2.event.id);
    assert.equal((await parentSub.waitFor(b => b.kind === 'event' && b.data.tag === 'r2')).id, r2.event.id);

    // 3) comment.dispatch on child/a.html -> all 4 subscribers.
    const r3 = hub.emit({ type: 'comment.dispatch', entityId: 'child', filename: 'a.html', path: 'a.html', payload: { tag: 'r3' } });
    assert.equal(r3.deliveredConnections, 4);
    assert.equal(r3.deliveredHosts, 4);
    for (const conn of connections) {
      const ev = await conn.waitFor(b => b.kind === 'event' && b.data.tag === 'r3');
      assert.equal(ev.event, 'comment.dispatch');
    }
    // Verify dispatchSub never received r1 or r2, and fileSub never received r2.
    assert.equal(dispatchSub.pendingBlocks().filter(b => b.kind === 'event').length, 0);
    assert.equal(fileSub.pendingBlocks().filter(b => b.kind === 'event').length, 0);

    // 4) comment.dispatch on unrelated entity 'other' -> only globalSub.
    const r4 = hub.emit({ type: 'comment.dispatch', entityId: 'other', filename: 'a.html', path: 'a.html', payload: { tag: 'r4' } });
    assert.equal(r4.deliveredConnections, 1);
    assert.equal(r4.deliveredHosts, 1);
    assert.equal((await globalSub.waitFor(b => b.kind === 'event' && b.data.tag === 'r4')).id, r4.event.id);
  } finally {
    for (const conn of connections) conn.close();
    await srv.close();
  }
});

test('?once=1 blocking wait, immediate replay with after, and timeout returning 204', async () => {
  const hub = createEventHub({ heartbeatMs: 0 });
  const srv = await startTestServer(hub);
  try {
    // 1) Blocking wait receives live matching event and unregisters itself.
    const waitPromise = httpGet(
      srv.baseUrl,
      '/events?once=1&entityId=proj&filename=diagram.html&events=comment.dispatch&ip=192.168.2.5&client=oneshot',
    );
    await waitUntil(() => hub.hostSummary({ entityId: 'proj', filename: 'diagram.html' }).connectionCount === 1);

    // Non-matching event should NOT wake it.
    const ignored = hub.emit({
      type: 'comment.created',
      entityId: 'proj',
      filename: 'diagram.html',
      path: 'diagram.html',
      payload: { marker: 'ignored' },
    });
    assert.equal(ignored.deliveredConnections, 0);
    assert.equal(hub.hostSummary({ entityId: 'proj', filename: 'diagram.html' }).connectionCount, 1);

    // Matching event wakes it immediately with 200 JSON.
    const emitted = hub.emit({
      type: 'comment.dispatch',
      entityId: 'proj',
      filename: 'diagram.html',
      path: 'diagram.html',
      payload: { marker: 'matched' },
    });
    assert.equal(emitted.deliveredConnections, 1);
    assert.equal(emitted.deliveredHosts, 1);

    const res = await waitPromise;
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.json, emitted.event);
    assert.equal(hub.hostSummary({ entityId: 'proj', filename: 'diagram.html' }).connectionCount, 0);

    // 2) Immediate replay via ?after= returns the FIRST matching buffered event without registering.
    hub.emit({
      type: 'comment.dispatch',
      entityId: 'proj',
      filename: 'diagram.html',
      path: 'diagram.html',
      payload: { marker: 'second-dispatch' },
    });
    const replayRes = await httpGet(
      srv.baseUrl,
      '/events?once=1&entityId=proj&filename=diagram.html&events=comment.dispatch&after=0',
    );
    assert.equal(replayRes.status, 200);
    assert.equal(replayRes.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(replayRes.headers['cache-control'], 'no-store');
    assert.equal(replayRes.json.id, emitted.event.id);
    assert.equal(replayRes.json.marker, 'matched');
    assert.equal(hub.hostSummary({ entityId: 'proj' }).connectionCount, 0);

    // 3) Timeout returns 204 No Content and cleans up subscriber.
    const started = Date.now();
    const timeoutRes = await httpGet(srv.baseUrl, '/events?once=1&entityId=proj&timeout=1&ip=192.168.2.9');
    const elapsedMs = Date.now() - started;
    assert.equal(timeoutRes.status, 204);
    assert.equal(timeoutRes.headers['cache-control'], 'no-store');
    assert.equal(timeoutRes.text, '');
    assert.ok(elapsedMs >= 900, `Expected ~1s timeout, got ${elapsedMs}ms`);
    assert.equal(hub.hostSummary({ entityId: 'proj' }).connectionCount, 0);
  } finally {
    await srv.close();
  }
});

test('hostSummary deduplicates IPv4-mapped and plain IP, distinguishes distinct hosts, and cleans up on disconnect', async () => {
  const hub = createEventHub({ heartbeatMs: 0 });
  const srv = await startTestServer(hub);
  try {
    // Two connections from the same machine: ::ffff:192.168.1.5 (folder) and 192.168.1.5 (file).
    const connA1 = await openSse(
      srv.baseUrl,
      `/events?entityId=proj&ip=${encodeURIComponent('::ffff:192.168.1.5')}&client=pi-agent`,
    );
    await connA1.waitFor(b => b.kind === 'comment' && b.comment === 'connected');

    const connA2 = await openSse(
      srv.baseUrl,
      '/events?entityId=proj&filename=flow.html&ip=192.168.1.5&client=codex',
    );
    await connA2.waitFor(b => b.kind === 'comment' && b.comment === 'connected');

    const oneHost = hub.hostSummary({ entityId: 'proj', filename: 'flow.html' });
    assert.equal(oneHost.hostCount, 1);
    assert.equal(oneHost.connectionCount, 2);
    assert.equal(oneHost.hosts.length, 1);
    assert.equal(oneHost.hosts[0].ip, '192.168.1.5');
    assert.equal(oneHost.hosts[0].connections, 2);
    assert.deepEqual(oneHost.hosts[0].clients, ['pi-agent', 'codex']);
    assert.deepEqual(oneHost.hosts[0].scopes, ['folder', 'file']);
    assert.ok(Number.isFinite(Date.parse(oneHost.hosts[0].connectedAt)));

    // Different filename in same entity matches only the folder-scoped connection.
    const otherFile = hub.hostSummary({ entityId: 'proj', filename: 'other.html' });
    assert.equal(otherFile.hostCount, 1);
    assert.equal(otherFile.connectionCount, 1);
    assert.deepEqual(otherFile.hosts[0].clients, ['pi-agent']);
    assert.deepEqual(otherFile.hosts[0].scopes, ['folder']);

    // Distinct IP (admin global) increases hostCount to 2 and connectionCount to 3.
    const connB = await openSse(srv.baseUrl, '/events?entityId=null&ip=192.168.1.9');
    await connB.waitFor(b => b.kind === 'comment' && b.comment === 'connected');

    const twoHosts = hub.hostSummary({ entityId: 'proj', filename: 'flow.html' });
    assert.equal(twoHosts.hostCount, 2);
    assert.equal(twoHosts.connectionCount, 3);
    assert.deepEqual(twoHosts.hosts.map(h => h.ip), ['192.168.1.5', '192.168.1.9']);
    assert.deepEqual(twoHosts.hosts[1].clients, []);
    assert.deepEqual(twoHosts.hosts[1].scopes, ['folder']);

    // Emitting verifies deliveredConnections (3) vs deliveredHosts (2).
    const delivered = hub.emit({
      type: 'comment.created',
      entityId: 'proj',
      filename: 'flow.html',
      path: 'flow.html',
      payload: { ok: true },
    });
    assert.equal(delivered.deliveredConnections, 3);
    assert.equal(delivered.deliveredHosts, 2);

    // Disconnect first connection on 192.168.1.5 -> still 2 hosts, 2 connections.
    connA1.close();
    await waitUntil(() => hub.hostSummary({ entityId: 'proj', filename: 'flow.html' }).connectionCount === 2);
    const afterFirstDrop = hub.hostSummary({ entityId: 'proj', filename: 'flow.html' });
    assert.equal(afterFirstDrop.hostCount, 2);
    assert.equal(afterFirstDrop.hosts[0].connections, 1);
    assert.deepEqual(afterFirstDrop.hosts[0].clients, ['codex']);
    assert.deepEqual(afterFirstDrop.hosts[0].scopes, ['file']);

    // Disconnect second connection on 192.168.1.5 -> drops to 1 host (192.168.1.9), 1 connection.
    connA2.close();
    await waitUntil(() => hub.hostSummary({ entityId: 'proj', filename: 'flow.html' }).hostCount === 1);
    const afterSecondDrop = hub.hostSummary({ entityId: 'proj', filename: 'flow.html' });
    assert.equal(afterSecondDrop.connectionCount, 1);
    assert.equal(afterSecondDrop.hosts[0].ip, '192.168.1.9');

    // closeAll() ends remaining SSE and waiting once connections cleanly.
    const pendingOnce = httpGet(srv.baseUrl, '/events?once=1&entityId=proj&timeout=60&ip=10.1.1.1');
    await waitUntil(() => hub.hostSummary({ entityId: 'proj', filename: 'flow.html' }).hostCount === 2);
    hub.closeAll();
    const [closedOnce] = await Promise.all([pendingOnce, connB.ended]);
    assert.equal(closedOnce.status, 204);
    assert.equal(hub.hostSummary({ entityId: 'proj', filename: 'flow.html' }).connectionCount, 0);
    assert.equal(hub.hostSummary({ entityId: 'proj', filename: 'flow.html' }).hostCount, 0);
  } finally {
    await srv.close();
  }
});
