import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, pageFilename } from './catalog.mjs';

const ACCOUNT_ID_RE = /^u_[0-9a-f]{16}$/;
const ACCOUNT_SECRET_RE = /^ve_usr_[A-Za-z0-9_-]{43}$/;
const SHARE_ID_RE = /^sh_[0-9a-f]{16}$/;
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

const MAX_NAME_LEN = 64;
const MAX_LABEL_LEN = 80;
const MIN_SHARE_TTL = 60;
const MAX_SHARE_TTL = 365 * 86400;

const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function cleanName(value, field = 'name') {
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string`);
  if (!value.isWellFormed()) throw new ApiError(400, `${field} must be a well-formed string`);
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > MAX_NAME_LEN || /\p{Cc}/u.test(trimmed)) {
    throw new ApiError(400, `${field} must contain 1–${MAX_NAME_LEN} printable characters`);
  }
  return trimmed;
}

function isNormalizedName(value) {
  return typeof value === 'string' && value.isWellFormed() && value.trim() === value &&
    value.length > 0 && [...value].length <= MAX_NAME_LEN && !/\p{Cc}/u.test(value);
}

function cleanRole(value) {
  if (value !== 'admin' && value !== 'user') {
    throw new ApiError(400, 'role must be "admin" or "user"');
  }
  return value;
}

function cleanLabel(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'label must be a string');
  if (!value.isWellFormed()) throw new ApiError(400, 'label must be a well-formed string');
  const trimmed = value.trim();
  if ([...trimmed].length > MAX_LABEL_LEN || /\p{Cc}/u.test(trimmed)) {
    throw new ApiError(400, `label must be at most ${MAX_LABEL_LEN} printable characters`);
  }
  return trimmed;
}

function isNormalizedLabel(value) {
  return typeof value === 'string' && value.isWellFormed() && value.trim() === value &&
    [...value].length <= MAX_LABEL_LEN && !/\p{Cc}/u.test(value);
}

function cleanExpiresIn(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) ||
      value < MIN_SHARE_TTL || value > MAX_SHARE_TTL) {
    throw new ApiError(400, `expiresIn must be an integer between ${MIN_SHARE_TTL} and ${MAX_SHARE_TTL} seconds`);
  }
  return value;
}

function makeQueue() {
  let queue = Promise.resolve();
  return operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
}

async function writeAtomicJson(path, payload, cleanupLabel) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(payload) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => console.error(`${cleanupLabel} temporary cleanup failed`));
  }
}

const ownerMetadata = name => ({ id: 'owner', name, role: 'admin', builtIn: true });
const accountMetadata = ({ id, name, role, createdAt, updatedAt }) => ({
  id, name, role, createdAt, updatedAt, builtIn: false,
});

function validateAccountEntry(entry) {
  return object(entry) &&
    Object.keys(entry).sort().join(',') === 'createdAt,hash,id,name,role,updatedAt' &&
    typeof entry.id === 'string' && ACCOUNT_ID_RE.test(entry.id) &&
    isNormalizedName(entry.name) &&
    (entry.role === 'admin' || entry.role === 'user') &&
    typeof entry.hash === 'string' && HEX_SHA256_RE.test(entry.hash) &&
    timestamp(entry.createdAt) && timestamp(entry.updatedAt);
}

export async function createAccounts(outputDir) {
  const path = join(outputDir, '.accounts.json');
  let ownerDisplayName = 'Owner';
  let accounts = [];

  const status = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (status) {
    if (!status.isFile() || status.isSymbolicLink()) throw new Error('Accounts store must be a regular private file');
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!object(data) || data.version !== 1 ||
        Object.keys(data).sort().join(',') !== 'accounts,ownerName,version' ||
        !isNormalizedName(data.ownerName) || !Array.isArray(data.accounts)) {
      throw new Error('Malformed accounts store');
    }
    const ids = new Set();
    for (const entry of data.accounts) {
      if (!validateAccountEntry(entry) || ids.has(entry.id)) {
        throw new Error('Malformed accounts store');
      }
      ids.add(entry.id);
    }
    ownerDisplayName = data.ownerName;
    accounts = data.accounts;
    await chmod(path, 0o600);
  }

  const enqueue = makeQueue();

  async function persist(nextOwnerName, nextAccounts) {
    await writeAtomicJson(path, { version: 1, ownerName: nextOwnerName, accounts: nextAccounts }, 'Accounts store');
    ownerDisplayName = nextOwnerName;
    accounts = nextAccounts;
  }

  return {
    ownerName() { return ownerDisplayName; },
    get(id) {
      if (id === 'owner') return ownerMetadata(ownerDisplayName);
      const found = accounts.find(entry => entry.id === id);
      return found ? accountMetadata(found) : null;
    },
    list() {
      return {
        owner: ownerMetadata(ownerDisplayName),
        accounts: accounts
          .map((entry, index) => ({ entry, index }))
          .sort((a, b) => {
            const diff = Date.parse(a.entry.createdAt) - Date.parse(b.entry.createdAt);
            return diff !== 0 ? diff : a.index - b.index;
          })
          .map(({ entry }) => accountMetadata(entry)),
      };
    },
    authenticate(secret) {
      if (typeof secret !== 'string' || !ACCOUNT_SECRET_RE.test(secret)) return null;
      const hash = Buffer.from(digest(secret), 'hex');
      let matched = null;
      for (const entry of accounts) {
        if (timingSafeEqual(hash, Buffer.from(entry.hash, 'hex'))) {
          matched = entry;
        }
      }
      return matched ? { id: matched.id, name: matched.name, role: matched.role, builtIn: false } : null;
    },
    async create({ name, role = 'user' } = {}) {
      return enqueue(async () => {
        const normalizedName = cleanName(name);
        const normalizedRole = cleanRole(role);
        let id;
        do { id = `u_${randomBytes(8).toString('hex')}`; } while (accounts.some(entry => entry.id === id));
        const secret = `ve_usr_${randomBytes(32).toString('base64url')}`;
        const now = new Date().toISOString();
        const entry = {
          id,
          name: normalizedName,
          role: normalizedRole,
          hash: digest(secret),
          createdAt: now,
          updatedAt: now,
        };
        await persist(ownerDisplayName, [...accounts, entry]);
        return { account: accountMetadata(entry), secret };
      });
    },
    async rename(id, name) {
      return enqueue(async () => {
        if (id === 'owner') {
          const nextOwnerName = cleanName(name);
          await persist(nextOwnerName, accounts);
          return ownerMetadata(ownerDisplayName);
        }
        const existing = accounts.find(entry => entry.id === id);
        if (!existing) throw new ApiError(404, 'Account not found');
        const nextName = cleanName(name);
        const updated = { ...existing, name: nextName, updatedAt: new Date().toISOString() };
        await persist(ownerDisplayName, accounts.map(entry => entry === existing ? updated : entry));
        return accountMetadata(updated);
      });
    },
    async remove(id) {
      return enqueue(async () => {
        if (id === 'owner') throw new ApiError(400, 'Cannot delete built-in owner account');
        if (!accounts.some(entry => entry.id === id)) throw new ApiError(404, 'Account not found');
        await persist(ownerDisplayName, accounts.filter(entry => entry.id !== id));
      });
    },
  };
}

const shareMetadata = ({ id, filename, label, createdAt, expiresAt, createdBy }) => ({
  id, filename, label, createdAt, expiresAt, createdBy,
});
const shareActive = (entry, now = Date.now()) => now < Date.parse(entry.expiresAt);

function validateShareEntry(entry) {
  if (!object(entry) || Object.keys(entry).sort().join(',') !== 'createdAt,createdBy,expiresAt,filename,hash,id,label') {
    return false;
  }
  if (typeof entry.id !== 'string' || !SHARE_ID_RE.test(entry.id)) return false;
  try { pageFilename(entry.filename); } catch { return false; }
  return typeof entry.hash === 'string' && HEX_SHA256_RE.test(entry.hash) &&
    isNormalizedLabel(entry.label) &&
    timestamp(entry.createdAt) && timestamp(entry.expiresAt) &&
    isNormalizedName(entry.createdBy);
}

export async function createShares(outputDir) {
  const path = join(outputDir, '.shares.json');
  let shares = [];

  const status = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (status) {
    if (!status.isFile() || status.isSymbolicLink()) throw new Error('Shares store must be a regular private file');
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!object(data) || data.version !== 1 ||
        Object.keys(data).sort().join(',') !== 'shares,version' ||
        !Array.isArray(data.shares)) {
      throw new Error('Malformed shares store');
    }
    const ids = new Set();
    for (const entry of data.shares) {
      if (!validateShareEntry(entry) || ids.has(entry.id)) {
        throw new Error('Malformed shares store');
      }
      ids.add(entry.id);
    }
    shares = data.shares;
    await chmod(path, 0o600);
  }

  const enqueue = makeQueue();

  async function persist(nextShares) {
    await writeAtomicJson(path, { version: 1, shares: nextShares }, 'Shares store');
    shares = nextShares;
  }

  return {
    list(filename) {
      const now = Date.now();
      return shares
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.filename === filename && shareActive(entry, now))
        .sort((a, b) => {
          const diff = Date.parse(b.entry.createdAt) - Date.parse(a.entry.createdAt);
          return diff !== 0 ? diff : b.index - a.index;
        })
        .map(({ entry }) => shareMetadata(entry));
    },
    async create({ filename, expiresIn, label = '', createdBy = 'Owner' } = {}) {
      return enqueue(async () => {
        pageFilename(filename);
        const ttl = cleanExpiresIn(expiresIn);
        const normalizedLabel = cleanLabel(label);
        const creator = (createdBy === undefined || createdBy === null) ? 'Owner' : cleanName(createdBy, 'createdBy');
        const nowMs = Date.now();
        const createdAt = new Date(nowMs).toISOString();
        const expiresAt = new Date(nowMs + ttl * 1000).toISOString();
        let id;
        do { id = `sh_${randomBytes(8).toString('hex')}`; } while (shares.some(entry => entry.id === id));
        const token = randomBytes(32).toString('base64url');
        const entry = {
          id,
          filename,
          hash: digest(token),
          label: normalizedLabel,
          createdAt,
          expiresAt,
          createdBy: creator,
        };
        const activeShares = shares.filter(item => shareActive(item, nowMs));
        await persist([...activeShares, entry]);
        return { share: shareMetadata(entry), token };
      });
    },
    resolve(token) {
      if (typeof token !== 'string' || !SHARE_TOKEN_RE.test(token)) {
        return { status: 'not_found' };
      }
      const hash = Buffer.from(digest(token), 'hex');
      let matched = null;
      for (const entry of shares) {
        if (timingSafeEqual(hash, Buffer.from(entry.hash, 'hex'))) {
          matched = entry;
        }
      }
      if (!matched) return { status: 'not_found' };
      const share = shareMetadata(matched);
      if (Date.now() >= Date.parse(matched.expiresAt)) {
        return { status: 'expired', share };
      }
      return { status: 'ok', share };
    },
    async revoke(id, filename = null) {
      return enqueue(async () => {
        const index = shares.findIndex(entry =>
          entry.id === id && (filename === null || filename === undefined || entry.filename === filename),
        );
        if (index === -1) throw new ApiError(404, 'Share link not found');
        await persist(shares.filter((_, i) => i !== index));
      });
    },
    async forgetPage(filename) {
      return enqueue(async () => {
        pageFilename(filename);
        const removed = shares.filter(entry => entry.filename === filename);
        if (!removed.length) return [];
        await persist(shares.filter(entry => entry.filename !== filename));
        return removed.map(entry => ({ ...entry }));
      });
    },
    async restorePage(savedEntries) {
      return enqueue(async () => {
        if (!savedEntries?.length) return;
        const existingIds = new Set(shares.map(entry => entry.id));
        const toAdd = [];
        for (const entry of savedEntries) {
          if (!validateShareEntry(entry)) throw new ApiError(400, 'Invalid share entry');
          if (existingIds.has(entry.id)) continue;
          existingIds.add(entry.id);
          toAdd.push({ ...entry });
        }
        if (!toAdd.length) return;
        await persist([...shares, ...toAdd]);
      });
    },
  };
}
