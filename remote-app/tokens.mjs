import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, entityName } from './catalog.mjs';

const digest = secret => createHash('sha256').update(secret).digest('hex');
const metadata = ({ id, name, createdAt, expiresAt }) => ({ id, name, createdAt, ...(expiresAt === undefined ? {} : { expiresAt }) });
const active = entry => entry.expiresAt === undefined || Date.now() < Date.parse(entry.expiresAt);
function expiry(expiresIn) {
  if (expiresIn === undefined || expiresIn === null) return {};
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 30 * 24 * 60 * 60) {
    throw new ApiError(400, 'expiresIn must be null (no expiry) or 1–2592000 seconds');
  }
  return { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}

// Mutations are serialized by the catalog queue, including entity deletion.
export async function createTokens(outputDir, catalog) {
  const path = join(outputDir, '.tokens.json');
  let entries = [];
  const status = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (status) {
    if (!status.isFile() || status.isSymbolicLink()) throw new Error('Token registry must be a regular private file');
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data?.version !== 1 || Object.keys(data).sort().join(',') !== 'tokens,version' || !Array.isArray(data.tokens)) throw new Error('Malformed token registry');
    const ids = new Set();
    for (const entry of data.tokens) {
      if (!entry || Object.keys(entry).sort().join(',') !== (Object.hasOwn(entry, 'expiresAt')
          ? 'createdAt,entityId,expiresAt,hash,id,name' : 'createdAt,entityId,hash,id,name') ||
          typeof entry.id !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.id) || ids.has(entry.id) ||
          typeof entry.hash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.hash) ||
          entityName(entry.name) !== entry.name || !Number.isFinite(Date.parse(entry.createdAt)) ||
          (Object.hasOwn(entry, 'expiresAt') && (typeof entry.expiresAt !== 'string' ||
            !Number.isFinite(Date.parse(entry.expiresAt)) || new Date(entry.expiresAt).toISOString() !== entry.expiresAt))) throw new Error('Malformed token registry');
      catalog.entity(entry.entityId);
      ids.add(entry.id);
    }
    entries = data.tokens;
    await chmod(path, 0o600);
  }
  async function persist(next) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, tokens: next }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
      entries = next;
    } finally { await rm(temporary, { force: true }).catch(() => console.error('Token registry temporary cleanup failed')); }
  }
  return {
    authenticate(secret) {
      const hash = Buffer.from(digest(secret), 'hex');
      const entry = entries.find(entry => timingSafeEqual(hash, Buffer.from(entry.hash, 'hex')));
      return entry && active(entry) && catalog.entities().some(entity => entity.id === entry.entityId)
        ? { role: 'agent', entityId: entry.entityId, tokenId: entry.id, expiresAt: entry.expiresAt ?? null }
        : null;
    },
    list(entityId) { catalog.entity(entityId); return entries.filter(entry => entry.entityId === entityId).map(metadata); },
    async create(entityId, name, expiresIn) {
      catalog.entity(entityId);
      const id = randomUUID();
      name = name === undefined ? `API ${id.slice(0, 8)}` : entityName(name);
      const secret = `ve_${randomBytes(32).toString('base64url')}`;
      const entry = { id, entityId, name, createdAt: new Date().toISOString(), hash: digest(secret), ...expiry(expiresIn) };
      await persist([...entries, entry]);
      return { token: metadata(entry), secret };
    },
    async setExpiry(entityId, id, expiresIn) {
      catalog.entity(entityId);
      const entry = entries.find(entry => entry.entityId === entityId && entry.id === id);
      if (!entry) throw new ApiError(404, 'Token not found');
      if (!active(entry)) throw new ApiError(409, 'Token has expired; create a new key');
      const { expiresAt, ...unchanged } = entry;
      const updated = { ...unchanged, ...expiry(expiresIn) };
      await persist(entries.map(value => value === entry ? updated : value));
      return { token: metadata(updated) };
    },
    async revoke(entityId, id) {
      catalog.entity(entityId);
      if (!entries.some(entry => entry.entityId === entityId && entry.id === id)) throw new ApiError(404, 'Token not found');
      await persist(entries.filter(entry => entry.entityId !== entityId || entry.id !== id));
    },
    async revokeEntity(entityId) {
      if (entries.some(entry => entry.entityId === entityId)) await persist(entries.filter(entry => entry.entityId !== entityId));
    },
  };
}
