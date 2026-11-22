import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function pageFilename(filename) {
  if (typeof filename !== 'string' || !filename ||
      basename(filename) !== filename || filename.includes('\\') || filename.includes('..') ||
      /[\x00-\x1f\x7f]/.test(filename) || !/\.html?$/i.test(filename) || /\.src\.html?$/i.test(filename)) {
    throw new ApiError(400, 'filename must be a canonical .html or .htm basename, not a source file');
  }
  return filename;
}

export function canonicalFilename(filename) {
  pageFilename(filename);
  if (filename.trim() !== filename || filename.startsWith('@')) {
    throw new ApiError(400, 'filename must not require renderer normalization');
  }
  return filename;
}

export function entityId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new ApiError(400, 'entityId must be a lowercase slug of 1–64 characters');
  }
  return value;
}

export function entityName(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'name must be a string');
  const name = value.trim();
  if (!name || [...name].length > 120) throw new ApiError(400, 'name must contain 1–120 characters');
  return name;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export async function createCatalog(outputDir) {
  // Mirror the renderer's ancestor guard before creating the persistent catalog directory.
  let existing = outputDir;
  while (!(await lstat(existing).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })) && dirname(existing) !== existing) existing = dirname(existing);
  if (join(await realpath(existing), relative(existing, outputDir)) !== outputDir) {
    throw new Error('Output directory must not contain symlinks');
  }
  await mkdir(outputDir, { recursive: true });
  if (await realpath(outputDir) !== outputDir) throw new Error('Output directory must not contain symlinks');

  const path = join(outputDir, '.entities.json');
  let entities = new Map();
  let pages = new Map();
  const status = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (status) {
    if (!status.isFile() || status.isSymbolicLink()) throw new Error('Entity catalog must be a regular file');
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (!object(data) || data.version !== 1 || !Array.isArray(data.entities) || !object(data.pages) ||
          Object.keys(data).some(key => !['version', 'entities', 'pages'].includes(key))) throw new Error('Invalid schema');
      for (const entry of data.entities) {
        if (!object(entry) || Object.keys(entry).sort().join(',') !== 'createdAt,id,name,updatedAt' ||
            entityId(entry.id) !== entry.id || entityName(entry.name) !== entry.name ||
            !timestamp(entry.createdAt) || !timestamp(entry.updatedAt) || entities.has(entry.id)) throw new Error('Invalid entity');
        entities.set(entry.id, { ...entry });
      }
      for (const [filename, id] of Object.entries(data.pages)) {
        pageFilename(filename);
        entityId(id);
        if (!entities.has(id)) throw new Error('Unknown entity in page mapping');
        pages.set(filename, id);
      }
    } catch (error) {
      throw new Error(`Malformed entity catalog: ${error.message}`, { cause: error });
    }
  }

  let queue = Promise.resolve();
  async function persist(nextEntities, nextPages) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, entities: [...nextEntities.values()], pages: Object.fromEntries(nextPages) }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
      // Publish at the commit point; cleanup must not fail an already committed write.
      entities = nextEntities;
      pages = nextPages;
    } finally {
      await rm(temporary, { force: true }).catch(error => console.error('Catalog temporary cleanup failed', error));
    }
  }

  return {
    run(operation) {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    },
    entity(id) {
      entityId(id);
      const found = entities.get(id);
      if (!found) throw new ApiError(404, 'Entity not found');
      return { ...found };
    },
    entities() { return [...entities.values()].map(entry => ({ ...entry })); },
    assignment(filename) { return pages.get(filename) ?? null; },
    async create(id, name) {
      entityId(id);
      name = entityName(name);
      if (entities.has(id)) throw new ApiError(409, 'Entity already exists');
      const now = new Date().toISOString();
      const entry = { id, name, createdAt: now, updatedAt: now };
      const next = new Map(entities);
      next.set(id, entry);
      await persist(next, pages);
      return { ...entry };
    },
    async rename(id, name) {
      const entry = this.entity(id);
      name = entityName(name);
      const renamed = { ...entry, name, updatedAt: new Date().toISOString() };
      const next = new Map(entities);
      next.set(id, renamed);
      await persist(next, pages);
      return { ...renamed };
    },
    async remove(id, actualPages) {
      this.entity(id);
      if (actualPages.some(page => page.entityId === id)) throw new ApiError(409, 'Entity still contains diagrams');
      const nextEntities = new Map(entities);
      nextEntities.delete(id);
      const nextPages = new Map([...pages].filter(([, assigned]) => assigned !== id));
      await persist(nextEntities, nextPages);
    },
    async assign(filename, id) {
      pageFilename(filename);
      if (id !== null) this.entity(id);
      if ((pages.get(filename) ?? null) === id) return;
      const next = new Map(pages);
      if (id === null) next.delete(filename);
      else next.set(filename, id);
      await persist(entities, next);
    },
  };
}
