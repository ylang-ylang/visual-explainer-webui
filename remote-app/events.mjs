import { ApiError } from './catalog.mjs';

export const ALLOWED_EVENT_TYPES = Object.freeze([
  'comment.dispatch',
  'comment.created',
  'comment.replied',
  'comment.reopened',
]);

const allowedEventSet = new Set(ALLOWED_EVENT_TYPES);
const MAX_CLIENT_LENGTH = 64;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 3600;
const DEFAULT_ONCE_TIMEOUT_SEC = 300;

export function normalizeClientIp(raw) {
  if (typeof raw !== 'string') return 'unknown';
  const first = raw
    .split(',')
    .map(part => part.replace(/\p{Cc}/gu, '').trim())
    .find(Boolean);
  if (!first) return 'unknown';
  const unbracketed = first.startsWith('[') && first.endsWith(']') ? first.slice(1, -1) : first;
  if (!unbracketed) return 'unknown';
  const v4Mapped = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(unbracketed);
  if (v4Mapped) return v4Mapped[1];
  return unbracketed.toLowerCase();
}

function sanitizeClient(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string' || !raw.isWellFormed()) throw new ApiError(400, 'client must be a string');
  const cleaned = raw.replace(/\p{Cc}/gu, '').trim();
  return [...cleaned].slice(0, MAX_CLIENT_LENGTH).join('').trim();
}

function parseEventsFilter(events) {
  if (events === undefined || events === null) return new Set();
  let items;
  if (events instanceof Set || Array.isArray(events)) {
    items = [...events];
  } else if (typeof events === 'string') {
    items = events.split(',').map(item => item.trim()).filter(Boolean);
  } else {
    throw new ApiError(400, 'events must be a Set, array, or comma-separated string');
  }
  const set = new Set();
  for (const item of items) {
    if (typeof item !== 'string') throw new ApiError(400, 'Event type must be a string');
    const name = item.trim();
    if (!allowedEventSet.has(name)) {
      throw new ApiError(400, `Unknown event type: ${name || '(empty)'}`);
    }
    set.add(name);
  }
  return set;
}

function parseTimeoutSec(raw, once) {
  if (raw === undefined || raw === null || raw === '') {
    return once ? DEFAULT_ONCE_TIMEOUT_SEC : 0;
  }
  const value = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isInteger(value)) {
    throw new ApiError(400, `timeoutSec must be an integer between ${MIN_TIMEOUT_SEC} and ${MAX_TIMEOUT_SEC}`);
  }
  if (!once && value === 0) return 0;
  if (value < MIN_TIMEOUT_SEC || value > MAX_TIMEOUT_SEC) {
    throw new ApiError(400, `timeoutSec must be between ${MIN_TIMEOUT_SEC} and ${MAX_TIMEOUT_SEC}`);
  }
  return value;
}

function parseAfter(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw new ApiError(400, 'after must be a non-negative integer event id');
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new ApiError(400, 'after event id is out of range');
  return value;
}

function formatSseEvent(event) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function matchesScope(subEntityId, targetEntityId, inScope) {
  if (subEntityId === null || subEntityId === undefined) return true;
  if (typeof inScope === 'function') return Boolean(inScope(subEntityId, targetEntityId));
  return subEntityId === targetEntityId;
}

function matchesEvent(sub, event) {
  if (!matchesScope(sub.entityId, event.entityId, sub.inScope)) return false;
  if (sub.filename && event.filename !== sub.filename) return false;
  if (sub.events && sub.events.size > 0 && !sub.events.has(event.type)) return false;
  return true;
}

export function createEventHub({ maxHistory = 200, heartbeatMs = 25000 } = {}) {
  const historyLimit = Number.isInteger(maxHistory) && maxHistory >= 0 ? maxHistory : 200;
  const heartbeatIntervalMs = Number.isFinite(heartbeatMs) && heartbeatMs >= 0 ? heartbeatMs : 25000;

  let nextEventId = 0;
  let nextSubId = 0;
  const history = [];
  const subscribers = new Set();
  const detachHandlers = new WeakMap();

  function cleanup(sub) {
    subscribers.delete(sub);
    if (sub.timer !== null) {
      clearTimeout(sub.timer);
      sub.timer = null;
    }
    if (sub.heartbeat !== null) {
      clearInterval(sub.heartbeat);
      sub.heartbeat = null;
    }
    const detach = detachHandlers.get(sub);
    if (detach) {
      detachHandlers.delete(sub);
      detach();
    }
  }

  function attachCleanup(req, res, sub) {
    const onResClose = () => cleanup(sub);
    const onResError = () => cleanup(sub);
    const onReqClose = () => {
      // On Node 16+, GET requests may emit req 'close' once body completes while the response stays open.
      if (!req?.complete || res.writableEnded || res.destroyed || req.socket?.destroyed) {
        cleanup(sub);
      }
    };
    res.on?.('close', onResClose);
    res.on?.('error', onResError);
    req?.on?.('close', onReqClose);
    detachHandlers.set(sub, () => {
      res.off?.('close', onResClose);
      res.off?.('error', onResError);
      req?.off?.('close', onReqClose);
    });
  }

  function sendJsonEvent(res, event) {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }
    res.end(JSON.stringify(event));
  }

  function emit({ type, entityId = null, filename = null, path = '', payload = {} } = {}) {
    if (typeof type !== 'string' || !type) throw new ApiError(400, 'Event type is required');
    const id = String(++nextEventId);
    const timestamp = new Date().toISOString();
    const event = { id, type, timestamp, entityId, filename, path };
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      for (const [key, value] of Object.entries(payload)) {
        if (!(key in event)) event[key] = value;
      }
    }

    if (historyLimit > 0) {
      history.push(event);
      if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
    }

    let deliveredConnections = 0;
    const deliveredIps = new Set();
    const frame = formatSseEvent(event);

    for (const sub of [...subscribers]) {
      if (sub.res.writableEnded || sub.res.destroyed) {
        cleanup(sub);
        continue;
      }
      if (!matchesEvent(sub, event)) continue;

      if (sub.once) {
        cleanup(sub);
        try {
          sendJsonEvent(sub.res, event);
          deliveredConnections += 1;
          deliveredIps.add(sub.ip);
        } catch {
          // Socket already closed during write.
        }
      } else {
        try {
          sub.res.write(frame);
          deliveredConnections += 1;
          deliveredIps.add(sub.ip);
        } catch {
          cleanup(sub);
        }
      }
    }

    return { event, deliveredConnections, deliveredHosts: deliveredIps.size };
  }

  function subscribe(req, res, options = {}) {
    const {
      entityId = null,
      filename = null,
      path = '',
      events = null,
      after = null,
      once = false,
      timeoutSec,
      client = '',
      ip,
      inScope = null,
    } = options;

    const isOnce = Boolean(once);
    const cleanClient = sanitizeClient(client);
    const eventFilter = parseEventsFilter(events);
    const resolvedTimeoutSec = parseTimeoutSec(timeoutSec, isOnce);
    const rawAfter = (after !== null && after !== undefined && String(after).trim() !== '')
      ? after
      : req?.headers?.['last-event-id'];
    const afterId = parseAfter(rawAfter);
    const scopeFn = typeof inScope === 'function' ? inScope : null;
    const subEntityId = entityId ?? null;
    const subFilename = filename || null;
    const subPath = typeof path === 'string' ? path : '';
    const resolvedIp = normalizeClientIp(ip !== undefined ? ip : (req?.socket?.remoteAddress ?? ''));

    const matcher = {
      entityId: subEntityId,
      filename: subFilename,
      events: eventFilter,
      inScope: scopeFn,
    };

    const replay = afterId !== null
      ? history.filter(ev => Number(ev.id) > afterId && matchesEvent(matcher, ev))
      : [];

    if (isOnce && replay.length > 0) {
      if (!res.writableEnded && !res.destroyed) sendJsonEvent(res, replay[0]);
      return { id: null, replayed: true, event: replay[0] };
    }

    if (res.writableEnded || res.destroyed) {
      return { id: null, replayed: false, event: null };
    }

    req?.setTimeout?.(0);
    res.setTimeout?.(0);

    const sub = {
      id: `sub_${++nextSubId}`,
      entityId: subEntityId,
      filename: subFilename,
      path: subPath,
      events: eventFilter,
      once: isOnce,
      client: cleanClient,
      ip: resolvedIp,
      connectedAt: new Date().toISOString(),
      inScope: scopeFn,
      res,
      timer: null,
      heartbeat: null,
    };

    if (isOnce) {
      subscribers.add(sub);
      attachCleanup(req, res, sub);
      sub.timer = setTimeout(() => {
        if (!subscribers.has(sub)) return;
        cleanup(sub);
        try {
          if (!res.writableEnded && !res.destroyed && !res.headersSent) {
            res.writeHead(204, { 'Cache-Control': 'no-store' });
            res.end();
          }
        } catch {
          // Ignore write errors on closing sockets.
        }
      }, resolvedTimeoutSec * 1000);
      return { id: sub.id, replayed: false, event: null };
    }

    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(': connected\n\n');
      for (const ev of replay) {
        res.write(formatSseEvent(ev));
      }
    } catch {
      return { id: null, replayed: false, event: null };
    }

    if (res.writableEnded || res.destroyed) {
      return { id: null, replayed: false, event: null };
    }

    subscribers.add(sub);
    attachCleanup(req, res, sub);

    if (heartbeatIntervalMs > 0) {
      sub.heartbeat = setInterval(() => {
        if (!subscribers.has(sub) || res.writableEnded || res.destroyed) {
          cleanup(sub);
          return;
        }
        try {
          res.write(': ping\n\n');
        } catch {
          cleanup(sub);
        }
      }, heartbeatIntervalMs);
    }

    if (resolvedTimeoutSec > 0) {
      sub.timer = setTimeout(() => {
        if (!subscribers.has(sub)) return;
        cleanup(sub);
        try {
          if (!res.writableEnded && !res.destroyed) res.end();
        } catch {
          // Ignore write errors on closing sockets.
        }
      }, resolvedTimeoutSec * 1000);
    }

    return { id: sub.id, replayed: replay.length > 0, event: null };
  }

  function hostSummary({ entityId = null, filename = null, inScope = null } = {}) {
    const matching = [];
    for (const sub of [...subscribers]) {
      if (sub.res.writableEnded || sub.res.destroyed) {
        cleanup(sub);
        continue;
      }
      const scopeFn = typeof inScope === 'function' ? inScope : sub.inScope;
      const scopeOk = matchesScope(sub.entityId, entityId, scopeFn);
      const fileOk = !sub.filename || !filename || sub.filename === filename;
      if (scopeOk && fileOk) matching.push(sub);
    }

    const byIp = new Map();
    for (const sub of matching) {
      let entry = byIp.get(sub.ip);
      if (!entry) {
        entry = {
          ip: sub.ip,
          connections: 0,
          clients: new Set(),
          scopes: new Set(),
          connectedAt: sub.connectedAt,
        };
        byIp.set(sub.ip, entry);
      }
      entry.connections += 1;
      if (sub.client) entry.clients.add(sub.client);
      entry.scopes.add(sub.filename ? 'file' : 'folder');
      if (sub.connectedAt < entry.connectedAt) entry.connectedAt = sub.connectedAt;
    }

    const hosts = [...byIp.values()].map(entry => ({
      ip: entry.ip,
      connections: entry.connections,
      clients: [...entry.clients],
      scopes: [...entry.scopes],
      connectedAt: entry.connectedAt,
    }));

    return {
      hostCount: hosts.length,
      connectionCount: matching.length,
      hosts,
    };
  }

  function closeAll() {
    for (const sub of [...subscribers]) {
      cleanup(sub);
      try {
        if (!sub.res.writableEnded && !sub.res.destroyed) {
          if (sub.once && !sub.res.headersSent) {
            sub.res.writeHead(204, { 'Cache-Control': 'no-store' });
          }
          sub.res.end();
        }
      } catch {
        // Ignore errors during graceful shutdown.
      }
    }
  }

  return { emit, subscribe, hostSummary, closeAll };
}
