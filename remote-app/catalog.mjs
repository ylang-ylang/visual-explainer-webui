import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function pageFilename(filename) {
  if (typeof filename !== 'string' || !filename || basename(filename) !== filename ||
      !filename.isWellFormed() || filename.includes('\\') || filename.includes('..') || /\p{Cc}/u.test(filename) ||
      !/\.html?$/i.test(filename) || /\.src\.html?$/i.test(filename)) {
    throw new ApiError(400, 'Expected a regular HTML basename, not a source file');
  }
  return filename;
}

export function canonicalFilename(filename) {
  pageFilename(filename);
  if (filename.trim() !== filename || filename.startsWith('@') || filename.startsWith('.')) {
    throw new ApiError(400, 'filename must not require renderer normalization');
  }
  return filename;
}

export function logicalPath(value, file = false) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value !== value.normalize('NFC') ||
      Buffer.byteLength(value) > 1024 || value.includes('\\') || /\p{Cc}/u.test(value)) {
    throw new ApiError(400, 'Invalid logical path');
  }
  const parts = value.split('/');
  if (parts.length > 32 || parts.some(part => !part || part.startsWith('.') || part !== part.trim() ||
      Buffer.byteLength(part) > 255 || /\.src\.html?$/i.test(part))) {
    throw new ApiError(400, 'Invalid logical path segment');
  }
  if (file && !/\.html?$/i.test(parts.at(-1))) throw new ApiError(400, 'File path must end in .html or .htm');
  return value;
}

export function sourceFilename(filename) { return filename.replace(/(\.html?)$/i, '.src$1'); }

export function sourcePairs(filenames) {
  const compiled = new Map(), pairs = new Map();
  for (const name of filenames) {
    const match = /^(.*)(\.html?)$/is.exec(name);
    if (!match || /\.src\.html?$/i.test(name)) continue;
    const entries = compiled.get(match[1]) ?? [];
    entries.push({ name, extension: match[2].toLowerCase() });
    compiled.set(match[1], entries);
  }
  for (const name of filenames) {
    const match = /^(.*)\.src(\.html?)$/is.exec(name);
    if (!match) continue;
    const candidates = compiled.get(match[1]) ?? [];
    const page = candidates.find(candidate => sourceFilename(candidate.name) === name) ??
      candidates.find(candidate => candidate.extension === match[2].toLowerCase()) ?? candidates[0];
    if (!page) continue;
    const sources = pairs.get(page.name) ?? [];
    sources.push(name);
    pairs.set(page.name, sources);
  }
  for (const [page, sources] of pairs) {
    const preferred = sourceFilename(page), extension = page.match(/\.html?$/i)[0].toLowerCase();
    const rank = name => name === preferred ? 0 : name.toLowerCase().endsWith(extension) ? 1 : 2;
    sources.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  }
  return pairs;
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
  if (!name || !name.isWellFormed() || [...name].length > 120 || /\p{Cc}/u.test(name)) throw new ApiError(400, 'name must contain 1–120 characters');
  return name;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const parents = path => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));

export async function createCatalog(outputDir) {
  let existing = outputDir;
  while (!(await lstat(existing).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })) && dirname(existing) !== existing) existing = dirname(existing);
  if (join(await realpath(existing), relative(existing, outputDir)) !== outputDir) throw new Error('Output directory must not contain symlinks');
  await mkdir(outputDir, { recursive: true });
  if (await realpath(outputDir) !== outputDir) throw new Error('Output directory must not contain symlinks');
  const path = join(outputDir, '.entities.json');
  let entities = new Map(), pages = new Map(), directories = new Map();
  let migration = false;

  function check(nextPages, nextDirectories) {
    for (const id of entities.keys()) {
      const files = new Set();
      const occupied = new Set(nextDirectories.get(id) ?? []);
      for (const entry of nextPages.values()) {
        if (entry.entityId !== id) continue;
        if (files.has(entry.path) || occupied.has(entry.path) || parents(entry.path).some(parent => files.has(parent))) {
          throw new ApiError(409, 'Path already exists');
        }
        files.add(entry.path);
      }
      for (const file of files) {
        if ([...files, ...occupied].some(other => other.startsWith(`${file}/`)) ||
            [...files].some(other => other === sourceFilename(file))) throw new ApiError(409, 'File and folder paths collide');
      }
    }
  }

  const status = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (status) {
    if (!status.isFile() || status.isSymbolicLink()) throw new Error('Entity catalog must be a regular file');
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (!object(data) || ![1, 2].includes(data.version) || !Array.isArray(data.entities) || !object(data.pages) ||
          Object.keys(data).some(key => !['version', 'entities', 'pages', ...(data.version === 2 ? ['folders'] : [])].includes(key)) ||
          (data.version === 2 && !object(data.folders))) throw new Error('Invalid schema');
      for (const entry of data.entities) {
        if (!object(entry) || Object.keys(entry).sort().join(',') !== 'createdAt,id,name,updatedAt' ||
            entityId(entry.id) !== entry.id || entityName(entry.name) !== entry.name ||
            !timestamp(entry.createdAt) || !timestamp(entry.updatedAt) || entities.has(entry.id)) throw new Error('Invalid entity');
        entities.set(entry.id, { ...entry });
        directories.set(entry.id, new Set());
      }
      for (const [filename, value] of Object.entries(data.pages)) {
        pageFilename(filename);
        const entry = data.version === 1 ? { entityId: value, path: filename.normalize('NFC') } : value;
        if (!object(entry) || Object.keys(entry).sort().join(',') !== 'entityId,path' ||
            !entities.has(entityId(entry.entityId))) throw new Error('Invalid page mapping');
        logicalPath(entry.path, true);
        pages.set(filename, { ...entry });
      }
      if (data.version === 2) {
        for (const [id, paths] of Object.entries(data.folders)) {
          if (!entities.has(id) || !Array.isArray(paths) || new Set(paths).size !== paths.length) throw new Error('Invalid folders');
          directories.set(id, new Set(paths.map(value => logicalPath(value))));
        }
      }
      for (const entry of pages.values()) for (const parent of parents(entry.path)) directories.get(entry.entityId).add(parent);
      for (const paths of directories.values()) for (const folder of [...paths]) for (const parent of parents(folder)) paths.add(parent);
      check(pages, directories);
      migration = data.version === 1;
    } catch (error) { throw new Error(`Malformed entity catalog: ${error.message}`, { cause: error }); }
  }

  let queue = Promise.resolve();
  async function persist(nextEntities, nextPages, nextDirectories) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({
        version: 2, entities: [...nextEntities.values()], pages: Object.fromEntries(nextPages),
        folders: Object.fromEntries([...nextDirectories].map(([id, paths]) => [id, [...paths].sort()])),
      }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
      entities = nextEntities; pages = nextPages; directories = nextDirectories;
    } finally { await rm(temporary, { force: true }).catch(() => console.error('Catalog temporary cleanup failed')); }
  }
  if (migration) await persist(entities, pages, directories);
  const copyDirectories = () => new Map([...directories].map(([id, paths]) => [id, new Set(paths)]));
  const addParents = (next, id, path) => { for (const parent of parents(path)) next.get(id).add(parent); };

  return {
    run(operation) { const result = queue.then(operation); queue = result.catch(() => {}); return result; },
    entity(id) {
      entityId(id);
      const found = entities.get(id);
      if (!found) throw new ApiError(404, 'Entity not found');
      return { ...found };
    },
    entities() { return [...entities.values()].map(entry => ({ ...entry })); },
    assignment(filename) { return pages.get(filename)?.entityId ?? null; },
    location(filename) { return pages.has(filename) ? { ...pages.get(filename) } : { entityId: null, path: filename }; },
    folders(id) { this.entity(id); return [...directories.get(id)].sort().map(path => ({ path })); },
    find(id, path) {
      this.entity(id); logicalPath(path, true);
      return [...pages].find(([, entry]) => entry.entityId === id && entry.path === path)?.[0] ?? null;
    },
    validateLocation(filename, id, path) {
      pageFilename(filename);
      if (id === null) return;
      this.entity(id); logicalPath(path, true);
      const nextPages = new Map(pages), nextDirectories = copyDirectories();
      nextPages.set(filename, { entityId: id, path });
      addParents(nextDirectories, id, path);
      check(nextPages, nextDirectories);
    },
    async create(id = randomUUID(), name) {
      entityId(id); name = entityName(name);
      if (entities.has(id)) throw new ApiError(409, 'Entity already exists');
      const now = new Date().toISOString(), entry = { id, name, createdAt: now, updatedAt: now };
      const next = new Map(entities), folders = copyDirectories();
      next.set(id, entry); folders.set(id, new Set());
      await persist(next, pages, folders);
      return { ...entry };
    },
    async rename(id, name) {
      const entry = this.entity(id); name = entityName(name);
      if (entry.name === name) return entry;
      const renamed = { ...entry, name, updatedAt: new Date().toISOString() }, next = new Map(entities);
      next.set(id, renamed); await persist(next, pages, directories); return { ...renamed };
    },
    async remove(id, actualPages) {
      this.entity(id);
      if (actualPages.some(page => page.entityId === id) || directories.get(id).size) throw new ApiError(409, 'Entity is not empty');
      const nextEntities = new Map(entities), nextDirectories = copyDirectories();
      nextEntities.delete(id); nextDirectories.delete(id);
      await persist(nextEntities, new Map([...pages].filter(([, entry]) => entry.entityId !== id)), nextDirectories);
    },
    async assign(filename, id, path = this.location(filename).path) {
      this.validateLocation(filename, id, path);
      const old = pages.get(filename);
      if ((old?.entityId ?? null) === id && (id === null || old.path === path)) return;
      const next = new Map(pages), folders = copyDirectories();
      if (id === null) next.delete(filename);
      else { next.set(filename, { entityId: id, path }); addParents(folders, id, path); }
      await persist(entities, next, folders);
    },
    async createFolder(id, path) {
      this.entity(id); logicalPath(path);
      if (directories.get(id).has(path)) throw new ApiError(409, 'Folder already exists');
      const next = copyDirectories(); next.get(id).add(path); addParents(next, id, path);
      check(pages, next); await persist(entities, pages, next); return { path };
    },
    async moveFolder(id, path, newPath) {
      this.entity(id); logicalPath(path); logicalPath(newPath);
      if (!directories.get(id).has(path)) throw new ApiError(404, 'Folder not found');
      if (path === newPath) return { path };
      if (newPath.startsWith(`${path}/`)) throw new ApiError(409, 'Cannot move a folder into itself');
      if (directories.get(id).has(newPath)) throw new ApiError(409, 'Destination already exists');
      const moved = value => value === path || value.startsWith(`${path}/`);
      const replace = value => newPath + value.slice(path.length);
      const nextPages = new Map([...pages].map(([filename, entry]) =>
        [filename, entry.entityId === id && moved(entry.path) ? { ...entry, path: replace(entry.path) } : entry]));
      const next = copyDirectories();
      next.set(id, new Set([...next.get(id)].map(value => moved(value) ? replace(value) : value)));
      addParents(next, id, newPath);
      check(nextPages, next); await persist(entities, nextPages, next); return { path: newPath };
    },
    async removeFolder(id, path) {
      this.entity(id); logicalPath(path);
      if (!directories.get(id).has(path)) throw new ApiError(404, 'Folder not found');
      if ([...directories.get(id)].some(value => value.startsWith(`${path}/`)) ||
          [...pages.values()].some(entry => entry.entityId === id && entry.path.startsWith(`${path}/`))) throw new ApiError(409, 'Folder is not empty');
      const next = copyDirectories(); next.get(id).delete(path); await persist(entities, pages, next);
    },
  };
}
