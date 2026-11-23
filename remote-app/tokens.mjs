import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, entityName } from './catalog.mjs';

const digest = secret => createHash('sha256').update(secret).digest('hex');
const metadata = ({ id, name, createdAt }) => ({ id, name, createdAt });

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
      if (!entry || Object.keys(entry).sort().join(',') !== 'createdAt,entityId,hash,id,name' ||
          typeof entry.id !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.id) || ids.has(entry.id) ||
          typeof entry.hash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.hash) ||
          entityName(entry.name) !== entry.name || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error('Malformed token registry');
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
      return entry && catalog.entities().some(entity => entity.id === entry.entityId) ? { role: 'agent', entityId: entry.entityId } : null;
    },
    list(entityId) { catalog.entity(entityId); return entries.filter(entry => entry.entityId === entityId).map(metadata); },
    async create(entityId, name) {
      catalog.entity(entityId); name = entityName(name);
      const secret = `ve_${randomBytes(32).toString('base64url')}`;
      const entry = { id: randomUUID(), entityId, name, createdAt: new Date().toISOString(), hash: digest(secret) };
      await persist([...entries, entry]);
      return { token: metadata(entry), secret };
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
