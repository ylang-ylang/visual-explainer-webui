import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, pageFilename } from './catalog.mjs';

const MAX_BODY = 8000;
const MAX_QUOTE = 1000;
const MAX_SELECTOR = 512;
const MAX_LABEL = 200;
const MAX_AUTHOR = 60;
const MAX_HEADINGS = 12;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function cleanText(value, field, max, required = true) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, `${field} is required`);
    return '';
  }
  if (typeof value !== 'string' || !value.isWellFormed()) throw new ApiError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ApiError(400, `${field} must not be empty`);
  if ([...trimmed].length > max) throw new ApiError(400, `${field} exceeds ${max} characters`);
  return trimmed;
}

function cleanSingleLine(value, field, max) {
  const text = cleanText(value, field, max, false).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text;
}

export function normalizeAuthor(input, role) {
  const isAgent = role === 'agent' || role === 'skill-editor';
  const fallback = isAgent ? 'Agent' : 'Owner';
  const name = input === undefined || input === null || input === ''
    ? fallback
    : cleanSingleLine(input, 'authorName', MAX_AUTHOR) || fallback;
  return { role: isAgent ? 'agent' : 'admin', name };
}

export function normalizeWhere(input) {
  if (input === undefined || input === null) return { kind: 'page' };
  if (!object(input)) throw new ApiError(400, 'where must be an object');
  const kind = input.kind ?? 'page';
  if (!['page', 'text', 'element'].includes(kind)) throw new ApiError(400, 'where.kind must be page, text, or element');
  if (kind === 'page') return { kind: 'page' };
  const where = { kind };
  if (input.quote !== undefined && input.quote !== null) {
    const quote = cleanText(input.quote, 'where.quote', MAX_QUOTE, false);
    if (quote) where.quote = quote;
  }
  if (input.selector !== undefined && input.selector !== null) {
    const selector = cleanSingleLine(input.selector, 'where.selector', MAX_SELECTOR);
    if (selector) where.selector = selector;
  }
  if (input.tag !== undefined && input.tag !== null) {
    const tag = cleanSingleLine(input.tag, 'where.tag', 40).toLowerCase();
    if (tag) where.tag = tag;
  }
  if (input.label !== undefined && input.label !== null) {
    const label = cleanSingleLine(input.label, 'where.label', MAX_LABEL);
    if (label) where.label = label;
  }
  if (input.headings !== undefined && input.headings !== null) {
    if (!Array.isArray(input.headings)) throw new ApiError(400, 'where.headings must be an array');
    const headings = input.headings.slice(0, MAX_HEADINGS)
      .map(item => cleanSingleLine(item, 'where.headings[]', MAX_LABEL))
      .filter(Boolean);
    if (headings.length) where.headings = headings;
  }
  if (kind === 'text' && !where.quote && !where.selector) {
    throw new ApiError(400, 'Text comment requires where.quote or where.selector');
  }
  if (kind === 'element' && !where.selector && !where.label) {
    throw new ApiError(400, 'Element comment requires where.selector or where.label');
  }
  return where;
}

export function formatWhere(where) {
  if (!where || where.kind === 'page') return 'the whole diagram';
  const parts = [];
  if (where.kind === 'element') {
    parts.push(where.tag ? `element <${where.tag}>` : 'element');
    if (where.label) parts.push(`"${where.label}"`);
  } else {
    parts.push(where.tag ? `selected text in <${where.tag}>` : 'selected text');
  }
  if (where.selector) parts.push(`selector ${where.selector}`);
  if (where.headings?.length) parts.push(`in "${where.headings.join(' › ')}"`);
  return parts.join(' · ');
}

export function formatCommentsSummary(threads, page = null, currentVersion = null) {
  const lines = [];
  if (page) {
    const label = page.path || page.filename;
    const ver = currentVersion?.number ? ` (current: v${currentVersion.number})` : '';
    lines.push(`# Comments on "${page.title || label}" (${label})${ver}`);
  }
  if (!threads.length) {
    lines.push('No matching comments.');
    return lines.join('\n');
  }
  for (const thread of threads) {
    const ver = thread.version ? `v${thread.version}` : 'unversioned';
    const resolved = thread.status === 'resolved'
      ? ` · resolved by @${thread.resolvedBy?.name || 'Owner'} at ${thread.resolvedAt}`
      : '';
    lines.push('');
    lines.push(`[${thread.id}] status=${thread.status} · ${ver}${resolved}`);
    lines.push(`Where: ${formatWhere(thread.where)}`);
    if (thread.where?.quote) {
      const snippet = thread.where.quote.replace(/\s+/g, ' ').slice(0, 160);
      lines.push(`Quoted: > ${snippet}${thread.where.quote.length > 160 ? '…' : ''}`);
    }
    lines.push(`@${thread.author.name} (${thread.author.role}, ${thread.createdAt}): ${thread.body}`);
    for (const reply of thread.replies) {
      lines.push(`  ↳ [${reply.id}] @${reply.author.name} (${reply.author.role}, ${reply.createdAt}): ${reply.body}`);
    }
  }
  const openCount = threads.filter(thread => thread.status === 'open').length;
  lines.push('');
  lines.push(`Open threads: ${openCount} / Total shown: ${threads.length}`);
  return lines.join('\n');
}

function cloneReply(reply) {
  return { ...reply, author: { ...reply.author } };
}

function cloneThread(thread) {
  return {
    ...thread,
    where: { ...thread.where, ...(thread.where.headings ? { headings: [...thread.where.headings] } : {}) },
    author: { ...thread.author },
    resolvedBy: thread.resolvedBy ? { ...thread.resolvedBy } : null,
    replies: thread.replies.map(cloneReply),
  };
}

function validateAuthor(author) {
  return object(author) && ['admin', 'agent'].includes(author.role) &&
    typeof author.name === 'string' && author.name.length > 0 && author.name.length <= MAX_AUTHOR;
}

function validateReply(reply) {
  return object(reply) && typeof reply.id === 'string' && /^c_\d+$/.test(reply.id) &&
    validateAuthor(reply.author) && typeof reply.body === 'string' && reply.body.length > 0 &&
    timestamp(reply.createdAt) && timestamp(reply.updatedAt);
}

function validateThread(thread, validateKey = pageFilename) {
  if (!object(thread) || typeof thread.id !== 'string' || !/^c_\d+$/.test(thread.id)) return false;
  try { validateKey(thread.filename); } catch { return false; }
  if (!['open', 'resolved'].includes(thread.status)) return false;
  if (thread.version !== null && (!Number.isInteger(thread.version) || thread.version < 1)) return false;
  if (thread.revision !== null && (typeof thread.revision !== 'string' || !/^[0-9a-f]{40,64}$/.test(thread.revision))) return false;
  try { normalizeWhere(thread.where); } catch { return false; }
  if (!validateAuthor(thread.author) || typeof thread.body !== 'string' || !thread.body.length) return false;
  if (!timestamp(thread.createdAt) || !timestamp(thread.updatedAt)) return false;
  if (thread.status === 'resolved' && (!timestamp(thread.resolvedAt) || !validateAuthor(thread.resolvedBy))) return false;
  if (thread.status === 'open' && (thread.resolvedAt !== null || thread.resolvedBy !== null)) return false;
  if (!Array.isArray(thread.replies) || !thread.replies.every(validateReply)) return false;
  return true;
}

// Mutations are serialized by the catalog queue, matching tokens.mjs and catalog.mjs.
export async function createComments(outputDir, { storeFile = '.comments.json', validateKey = pageFilename } = {}) {
  const path = join(outputDir, storeFile);
  let nextId = 1;
  let threads = [];

  const status = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (status) {
    if (!status.isFile() || status.isSymbolicLink()) throw new Error('Comments store must be a regular private file');
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!object(data) || data.version !== 1 || !Number.isInteger(data.nextId) || data.nextId < 1 || !Array.isArray(data.threads)) {
      throw new Error('Malformed comments store');
    }
    const seen = new Set();
    for (const thread of data.threads) {
      if (!validateThread(thread, validateKey) || seen.has(thread.id)) throw new Error('Malformed comment thread');
      seen.add(thread.id);
      for (const reply of thread.replies) {
        if (seen.has(reply.id)) throw new Error('Duplicate comment id');
        seen.add(reply.id);
      }
    }
    nextId = data.nextId;
    threads = data.threads;
    await chmod(path, 0o600);
  }

  async function persist(nextThreads, nextCounter) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, nextId: nextCounter, threads: nextThreads }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
      threads = nextThreads;
      nextId = nextCounter;
    } finally {
      await rm(temporary, { force: true }).catch(() => console.error('Comments temporary cleanup failed'));
    }
  }

  function findThread(threadId, filename = null) {
    if (typeof threadId !== 'string' || !/^c_\d+$/.test(threadId)) throw new ApiError(400, 'Invalid comment id');
    const thread = threads.find(entry => entry.id === threadId && (filename === null || entry.filename === filename));
    if (!thread) {
      const parent = threads.find(entry => entry.replies.some(reply => reply.id === threadId) && (filename === null || entry.filename === filename));
      if (parent) throw new ApiError(400, `Use the thread root id ${parent.id}, not a reply id`);
      throw new ApiError(404, 'Comment thread not found');
    }
    return thread;
  }

  function countsFor(filename = null) {
    const owned = filename === null || filename === undefined ? threads : threads.filter(entry => entry.filename === filename);
    const open = owned.filter(entry => entry.status === 'open').length;
    return { open, resolved: owned.length - open, total: owned.length };
  }

  return {
    counts(filename = null) { return countsFor(filename); },
    countsByVersion(filename) {
      const byVersion = new Map();
      for (const entry of threads) {
        if (entry.filename !== filename || !entry.version) continue;
        const current = byVersion.get(entry.version) ?? { open: 0, resolved: 0, total: 0 };
        current.total += 1;
        if (entry.status === 'open') current.open += 1;
        else current.resolved += 1;
        byVersion.set(entry.version, current);
      }
      return byVersion;
    },
    getThread(threadId) {
      const thread = findThread(threadId);
      return cloneThread(thread);
    },
    list(filename = null, { status: filter = 'all', version = null } = {}) {
      if (!['all', 'open', 'resolved'].includes(filter)) throw new ApiError(400, 'status must be open, resolved, or all');
      let list = filename === null || filename === undefined ? threads : threads.filter(entry => entry.filename === filename);
      if (filter !== 'all') list = list.filter(entry => entry.status === filter);
      if (version !== null && version !== undefined) list = list.filter(entry => entry.version === version);
      return { threads: list.map(cloneThread), counts: countsFor(filename) };
    },
    async create({ filename, version = null, revision = null, where, author, body }) {
      validateKey(filename);
      const cleanBody = cleanText(body, 'body', MAX_BODY, true);
      const cleanWhere = normalizeWhere(where);
      const now = new Date().toISOString();
      const id = `c_${nextId}`;
      const thread = {
        id,
        filename,
        status: 'open',
        version: Number.isInteger(version) && version >= 1 ? version : null,
        revision: typeof revision === 'string' && /^[0-9a-f]{40,64}$/.test(revision) ? revision : null,
        where: cleanWhere,
        author: { ...author },
        body: cleanBody,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        resolvedBy: null,
        replies: [],
      };
      await persist([...threads, thread], nextId + 1);
      return { thread: cloneThread(thread), counts: countsFor(filename) };
    },
    async reply({ filename = null, threadId, author, body }) {
      if (filename !== null && filename !== undefined) validateKey(filename);
      const existing = findThread(threadId, filename ?? null);
      const targetKey = existing.filename;
      const cleanBody = cleanText(body, 'body', MAX_BODY, true);
      const now = new Date().toISOString();
      const reply = { id: `c_${nextId}`, author: { ...author }, body: cleanBody, createdAt: now, updatedAt: now };
      const reopened = existing.status === 'resolved';
      const updated = {
        ...existing,
        status: 'open',
        resolvedAt: null,
        resolvedBy: null,
        updatedAt: now,
        replies: [...existing.replies, reply],
      };
      await persist(threads.map(entry => entry === existing ? updated : entry), nextId + 1);
      return { thread: cloneThread(updated), reply: cloneReply(reply), reopened, counts: countsFor(targetKey) };
    },
    async resolve({ filename = null, threadId, actor, note = '' }) {
      if (filename !== null && filename !== undefined) validateKey(filename);
      const existing = findThread(threadId, filename ?? null);
      const targetKey = existing.filename;
      if (existing.status === 'resolved') {
        return { thread: cloneThread(existing), changed: false, counts: countsFor(targetKey) };
      }
      const cleanNote = cleanText(note, 'note', MAX_BODY, false);
      const now = new Date().toISOString();
      let counter = nextId;
      const replies = [...existing.replies];
      if (cleanNote) {
        replies.push({ id: `c_${counter}`, author: { ...actor }, body: cleanNote, createdAt: now, updatedAt: now });
        counter += 1;
      }
      const updated = {
        ...existing,
        status: 'resolved',
        resolvedAt: now,
        resolvedBy: { ...actor },
        updatedAt: now,
        replies,
      };
      await persist(threads.map(entry => entry === existing ? updated : entry), counter);
      return { thread: cloneThread(updated), changed: true, counts: countsFor(targetKey) };
    },
    async reopen({ filename = null, threadId }) {
      if (filename !== null && filename !== undefined) validateKey(filename);
      const existing = findThread(threadId, filename ?? null);
      const targetKey = existing.filename;
      if (existing.status === 'open') {
        return { thread: cloneThread(existing), changed: false, counts: countsFor(targetKey) };
      }
      const now = new Date().toISOString();
      const updated = {
        ...existing,
        status: 'open',
        resolvedAt: null,
        resolvedBy: null,
        updatedAt: now,
      };
      await persist(threads.map(entry => entry === existing ? updated : entry), nextId);
      return { thread: cloneThread(updated), changed: true, counts: countsFor(targetKey) };
    },
    async edit({ filename = null, commentId, body }) {
      if (filename !== null && filename !== undefined) validateKey(filename);
      if (typeof commentId !== 'string' || !/^c_\d+$/.test(commentId)) throw new ApiError(400, 'Invalid comment id');
      const cleanBody = cleanText(body, 'body', MAX_BODY, true);
      const now = new Date().toISOString();
      let updatedThread = null;
      const nextThreads = threads.map(entry => {
        if (filename !== null && filename !== undefined && entry.filename !== filename) return entry;
        if (entry.id === commentId) {
          updatedThread = { ...entry, body: cleanBody, updatedAt: now };
          return updatedThread;
        }
        if (entry.replies.some(reply => reply.id === commentId)) {
          updatedThread = {
            ...entry,
            updatedAt: now,
            replies: entry.replies.map(reply => reply.id === commentId ? { ...reply, body: cleanBody, updatedAt: now } : reply),
          };
          return updatedThread;
        }
        return entry;
      });
      if (!updatedThread) throw new ApiError(404, 'Comment not found');
      await persist(nextThreads, nextId);
      return { thread: cloneThread(updatedThread), counts: countsFor(updatedThread.filename) };
    },
    async remove({ filename = null, commentId }) {
      if (filename !== null && filename !== undefined) validateKey(filename);
      if (typeof commentId !== 'string' || !/^c_\d+$/.test(commentId)) throw new ApiError(400, 'Invalid comment id');
      let foundKey = null;
      const nextThreads = [];
      for (const entry of threads) {
        if (filename !== null && filename !== undefined && entry.filename !== filename) { nextThreads.push(entry); continue; }
        if (entry.id === commentId) { foundKey = entry.filename; continue; }
        if (entry.replies.some(reply => reply.id === commentId)) {
          foundKey = entry.filename;
          nextThreads.push({
            ...entry,
            updatedAt: new Date().toISOString(),
            replies: entry.replies.filter(reply => reply.id !== commentId),
          });
          continue;
        }
        nextThreads.push(entry);
      }
      if (foundKey === null) throw new ApiError(404, 'Comment not found');
      await persist(nextThreads, nextId);
      return { deleted: true, filename: foundKey, counts: countsFor(foundKey) };
    },
    async forgetPage(filename) {
      validateKey(filename);
      const removed = threads.filter(entry => entry.filename === filename);
      if (!removed.length) return [];
      await persist(threads.filter(entry => entry.filename !== filename), nextId);
      return removed.map(cloneThread);
    },
    async restorePage(savedThreads) {
      if (!savedThreads?.length) return;
      const existingIds = new Set(threads.map(entry => entry.id));
      const toAdd = savedThreads.filter(entry => !existingIds.has(entry.id));
      if (!toAdd.length) return;
      await persist([...threads, ...toAdd], nextId);
    },
  };
}

export const createCommentsStore = createComments;
