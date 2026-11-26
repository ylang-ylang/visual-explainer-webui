import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

export class ApiError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    if (details && typeof details === 'object') this.details = details;
  }
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
const combine = (...parts) => parts.filter(Boolean).join('/');
const inside = (value, path) => value === path || value.startsWith(path + '/');
const pageStem = value => value.replace(/\.html?$/i, '');
const copyEntity = entry => ({ ...entry, parent: entry.parent ? { ...entry.parent } : null });

// A stable scope anchor can have a visual parent without changing its namespace.
// Also used against historical metadata: old ancestry never substitutes for the
// server's separate CURRENT-membership gate.
export function scopePath(entries, scope, id, path = '') {
  const entities = entries instanceof Map ? entries : new Map(entries.map(entry => [entry.id, entry]));
  const visited = new Set();
  while (id !== scope) {
    if (id === null || visited.has(id)) return null;
    visited.add(id);
    const entry = entities.get(id);
    if (!entry?.parent) return null;
    path = combine(entry.parent.path, entry.name, path);
    id = entry.parent.entityId;
  }
  return path;
}

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
  let migrationBytes;

  function check(nextEntities, nextPages, nextDirectories) {
    for (const entry of nextEntities.values()) {
      const visited = new Set([entry.id]);
      let parent = entry.parent;
      while (parent) {
        if (!nextEntities.has(parent.entityId) || visited.has(parent.entityId)) throw new ApiError(409, 'Cannot move a folder into itself or its descendants');
        visited.add(parent.entityId);
        parent = nextEntities.get(parent.entityId).parent;
      }
      if (entry.parent) {
        logicalPath(entry.name);
        if (entry.name.includes('/')) throw new ApiError(400, 'Folder name must be a single path segment');
        if (entry.parent.path && !nextDirectories.get(entry.parent.entityId).has(entry.parent.path)) throw new ApiError(404, 'Parent folder not found');
      }
    }
    for (const id of [null, ...nextEntities.keys()]) {
      const files = new Set(), occupied = new Set(nextDirectories.get(id) ?? []);
      for (const child of nextEntities.values()) {
        if (child.parent?.entityId !== id) continue;
        const name = combine(child.parent.path, child.name);
        if (occupied.has(name)) throw new ApiError(409, 'Destination already exists');
        occupied.add(name);
      }
      for (const entry of nextPages.values()) {
        if (entry.entityId !== id) continue;
        if (files.has(entry.path) || occupied.has(entry.path)) throw new ApiError(409, 'Path already exists');
        files.add(entry.path);
      }
      for (const file of files) {
        if ([...files, ...occupied].some(other => other.startsWith(`${file}/`)) ||
            [...files].some(other => other === sourceFilename(file))) throw new ApiError(409, 'File and folder paths collide');
      }
      // Every ancestor API must still be able to address the complete subtree.
      if (id !== null) for (const scope of nextEntities.keys()) {
        if (scope === id) continue;
        const prefix = scopePath(nextEntities, scope, id);
        if (prefix === null) continue;
        logicalPath(prefix);
        for (const value of [...files, ...(nextDirectories.get(id) ?? [])]) logicalPath(combine(prefix, value));
      }
      // No local path may shadow or pass through a child anchor.
      for (const child of nextEntities.values()) {
        if (child.parent?.entityId !== id) continue;
        const root = combine(child.parent.path, child.name);
        if ([...files, ...(nextDirectories.get(id) ?? [])].some(value => inside(value, root))) throw new ApiError(409, 'Path collides with a folder');
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
      const bytes = await readFile(path, 'utf8');
      const data = JSON.parse(bytes);
      if (!object(data) || ![1, 2, 3].includes(data.version) || !Array.isArray(data.entities) || !object(data.pages) ||
          Object.keys(data).some(key => !['version', 'entities', 'pages', ...(data.version >= 2 ? ['folders'] : [])].includes(key)) ||
          (data.version >= 2 && !object(data.folders))) throw new Error('Invalid schema');
      for (const entry of data.entities) {
        if (!object(entry) || Object.keys(entry).sort().join(',') !== (data.version === 3 ? 'createdAt,id,name,parent,updatedAt' : 'createdAt,id,name,updatedAt') ||
            entityId(entry.id) !== entry.id || entityName(entry.name) !== entry.name ||
            !timestamp(entry.createdAt) || !timestamp(entry.updatedAt) || entities.has(entry.id)) throw new Error('Invalid entity');
        const parent = data.version === 3 ? entry.parent : null;
        if (parent !== null && (!object(parent) || Object.keys(parent).sort().join(',') !== 'entityId,path' ||
            entityId(parent.entityId) !== parent.entityId || (parent.path !== '' && logicalPath(parent.path) !== parent.path))) throw new Error('Invalid parent');
        entities.set(entry.id, { ...entry, parent });
        directories.set(entry.id, new Set());
      }
      for (const [filename, value] of Object.entries(data.pages)) {
        pageFilename(filename);
        const entry = data.version === 1 ? { entityId: value, path: filename.normalize('NFC') } : value;
        if (!object(entry) || Object.keys(entry).sort().join(',') !== 'entityId,path' ||
            !(data.version === 3 && entry.entityId === null) && !entities.has(entityId(entry.entityId))) throw new Error('Invalid page mapping');
        if (entry.entityId === null && entry.path === filename) pageFilename(entry.path);
        else logicalPath(entry.path, true);
        if (entry.entityId === null && entry.path.includes('/')) throw new Error('Root page must have a basename');
        pages.set(filename, { ...entry });
      }
      if (data.version >= 2) {
        for (const [id, paths] of Object.entries(data.folders)) {
          if (!entities.has(id) || !Array.isArray(paths) || new Set(paths).size !== paths.length) throw new Error('Invalid folders');
          directories.set(id, new Set(paths.map(value => logicalPath(value))));
        }
      }
      for (const entry of pages.values()) if (entry.entityId !== null) for (const parent of parents(entry.path)) directories.get(entry.entityId).add(parent);
      for (const paths of directories.values()) for (const folder of [...paths]) for (const parent of parents(folder)) paths.add(parent);
      check(entities, pages, directories);
      migration = data.version !== 3;
      if (migration) migrationBytes = bytes;
    } catch (error) { throw new Error(`Malformed entity catalog: ${error.message}`, { cause: error }); }
  }

  // Include existing unassigned serving files in collision checks, while keeping
  // their physical identities and legacy basenames unchanged.
  for (const entry of await readdir(outputDir, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith('__skill-render-') && /\.html?$/i.test(entry.name) && !/\.src\.html?$/i.test(entry.name) && !pages.has(entry.name)) {
      pageFilename(entry.name);
      pages.set(entry.name, { entityId: null, path: entry.name });
    }
  }
  let queue = Promise.resolve();
  async function persist(nextEntities, nextPages, nextDirectories) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({
        version: 3, entities: [...nextEntities.values()], pages: Object.fromEntries(nextPages),
        folders: Object.fromEntries([...nextDirectories].map(([id, paths]) => [id, [...paths].sort()])),
      }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
      entities = nextEntities; pages = nextPages; directories = nextDirectories;
    } finally { await rm(temporary, { force: true }).catch(() => console.error('Catalog temporary cleanup failed')); }
  }
  if (migration) {
    await writeFile(join(outputDir, `.entities.pre-v3.${randomUUID()}.backup.json`), migrationBytes, { flag: 'wx', mode: 0o600 });
    await persist(entities, pages, directories);
  }
  const copyDirectories = () => new Map([...directories].map(([id, paths]) => [id, new Set(paths)]));
  const addParents = (next, id, path) => { if (id !== null) for (const parent of parents(path)) next.get(id).add(parent); };
  function rootCollision(name, except = null) {
    if ([...entities.values()].some(entry => !entry.parent && entry.name === name && entry.id !== except) ||
        [...pages.values()].some(entry => entry.entityId === null && entry.path === name)) throw new ApiError(409, 'Destination already exists');
  }

  return {
    run(operation) { const result = queue.then(operation); queue = result.catch(() => {}); return result; },
    entity(id) {
      entityId(id);
      const found = entities.get(id);
      if (!found) throw new ApiError(404, 'Entity not found');
      return copyEntity(found);
    },
    entities() { return [...entities.values()].map(copyEntity); },
    assignment(filename) { return pages.get(filename)?.entityId ?? null; },
    location(filename) { return pages.has(filename) ? { ...pages.get(filename) } : { entityId: null, path: filename }; },
    inScope(scope, id) { return scopePath(entities, scope, id) !== null; },
    relative(scope, id, path = '') { return scopePath(entities, scope, id, path); },
    folders(id) { this.entity(id); return [...directories.get(id)].sort().map(path => ({ path })); },
    scopeFolders(id) {
      this.entity(id);
      const result = [];
      for (const entry of entities.values()) {
        const prefix = this.relative(id, entry.id);
        if (prefix === null) continue;
        if (prefix) result.push({ path: prefix });
        for (const path of directories.get(entry.id)) result.push({ path: combine(prefix, path) });
      }
      return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    },
    resolve(id, path = '') {
      this.entity(id);
      if (path !== '') logicalPath(path);
      let child;
      while ((child = [...entities.values()].find(entry => entry.parent?.entityId === id && inside(path, combine(entry.parent.path, entry.name))))) {
        path = path.slice(combine(child.parent.path, child.name).length).replace(/^\//, '');
        id = child.id;
      }
      return { entityId: id, path };
    },
    fileLocation(id, path) {
      logicalPath(path, true);
      const found = this.resolve(id, path);
      if (!found.path) throw new ApiError(409, 'Path is a folder');
      return found;
    },
    find(id, path) {
      const found = this.fileLocation(id, path);
      return [...pages].find(([, entry]) => entry.entityId === found.entityId && entry.path === found.path)?.[0] ?? null;
    },
    validateLocation(filename, id, path) {
      pageFilename(filename);
      if (id !== null) this.entity(id);
      if (id === null && path === filename) pageFilename(path);
      else logicalPath(path, true);
      if (id === null && path.includes('/')) throw new ApiError(400, 'Root page must have a basename');
      const nextPages = new Map(pages), nextDirectories = copyDirectories();
      nextPages.set(filename, { entityId: id, path });
      if (id === null && [...entities.values()].some(entry => !entry.parent && entry.name === path)) throw new ApiError(409, 'Path is a folder');
      addParents(nextDirectories, id, path);
      check(entities, nextPages, nextDirectories);
    },
    async create(id = randomUUID(), name) {
      entityId(id); name = entityName(name);
      if (entities.has(id)) throw new ApiError(409, 'Entity already exists');
      rootCollision(name);
      const now = new Date().toISOString(), entry = { id, name, parent: null, createdAt: now, updatedAt: now };
      const next = new Map(entities), folders = copyDirectories();
      next.set(id, entry); folders.set(id, new Set());
      await persist(next, pages, folders);
      return copyEntity(entry);
    },
    async rename(id, name) {
      const entry = this.entity(id); name = entityName(name);
      if (entry.name === name) return entry;
      if (!entry.parent) rootCollision(name, id);
      const renamed = { ...entry, name, updatedAt: new Date().toISOString() }, next = new Map(entities);
      next.set(id, renamed); check(next, pages, directories);
      await persist(next, pages, directories); return copyEntity(renamed);
    },
    async remove(id, actualPages) {
      this.entity(id);
      if (actualPages.some(page => this.inScope(id, page.entityId)) || directories.get(id).size ||
          [...entities.values()].some(entry => entry.parent?.entityId === id)) throw new ApiError(409, 'Entity is not empty');
      const nextEntities = new Map(entities), nextDirectories = copyDirectories();
      nextEntities.delete(id); nextDirectories.delete(id);
      await persist(nextEntities, new Map([...pages].filter(([, entry]) => entry.entityId !== id)), nextDirectories);
    },
    async assign(filename, id, path = id === null && this.assignment(filename) !== null ? filename : this.location(filename).path) {
      this.validateLocation(filename, id, path);
      const old = this.location(filename);
      if (old.entityId === id && old.path === path && pages.has(filename)) return;
      const next = new Map(pages), folders = copyDirectories();
      next.set(filename, { entityId: id, path }); addParents(folders, id, path);
      await persist(entities, next, folders);
    },
    async movePage(filename, targetEntityId, targetPath, scope = undefined) {
      pageFilename(filename);
      const old = this.location(filename);
      if (targetEntityId !== null) this.entity(targetEntityId);
      if (targetEntityId === null && targetPath === filename) pageFilename(targetPath);
      else logicalPath(targetPath, true);
      if (targetEntityId === null && targetPath.includes('/')) throw new ApiError(400, 'Root page must have a basename');
      if (scope !== undefined && (!this.inScope(scope, old.entityId) || !this.inScope(scope, targetEntityId))) {
        throw new ApiError(403, 'Move is outside folder scope');
      }
      if (old.entityId === targetEntityId && old.path === targetPath && pages.has(filename)) {
        return { moved: false, filename, entityId: targetEntityId, path: targetPath };
      }
      const fromStem = pageStem(old.path);
      const hasWikiChildren = old.entityId !== null && (
        directories.get(old.entityId).has(fromStem) ||
        [...directories.get(old.entityId)].some(folder => folder.startsWith(fromStem + '/')) ||
        [...pages.entries()].some(([name, entry]) => name !== filename && entry.entityId === old.entityId && entry.path.startsWith(fromStem + '/')) ||
        [...entities.values()].some(entry => entry.parent?.entityId === old.entityId && inside(entry.parent.path, fromStem))
      );
      if (!hasWikiChildren) {
        await this.assign(filename, targetEntityId, targetPath);
        return { moved: true, filename, entityId: targetEntityId, path: targetPath };
      }
      if (targetEntityId === null) {
        throw new ApiError(409, 'Cannot move a page with child diagrams to Root; move it into a folder instead');
      }
      const toStem = logicalPath(pageStem(targetPath));
      if (old.entityId === targetEntityId && fromStem === toStem) {
        await this.assign(filename, targetEntityId, targetPath);
        return { moved: true, filename, entityId: targetEntityId, path: targetPath };
      }
      const relTarget = this.relative(old.entityId, targetEntityId, toStem);
      if (relTarget !== null && inside(relTarget, fromStem)) {
        throw new ApiError(409, 'Cannot move a page into its own child diagram');
      }
      if (directories.get(targetEntityId).has(toStem) ||
          [...entities.values()].some(entry => entry.parent?.entityId === targetEntityId && combine(entry.parent.path, entry.name) === toStem)) {
        throw new ApiError(409, 'Destination already exists');
      }
      const nextEntities = new Map(entities);
      const nextPages = new Map(pages);
      const nextDirectories = copyDirectories();
      const replace = value => combine(toStem, value.slice(fromStem.length).replace(/^\//, ''));
      nextPages.set(filename, { entityId: targetEntityId, path: targetPath });
      addParents(nextDirectories, targetEntityId, targetPath);
      for (const [childFilename, entry] of pages) {
        if (childFilename !== filename && entry.entityId === old.entityId && entry.path.startsWith(fromStem + '/')) {
          const replaced = logicalPath(replace(entry.path), true);
          nextPages.set(childFilename, { entityId: targetEntityId, path: replaced });
          addParents(nextDirectories, targetEntityId, replaced);
        }
      }
      for (const folder of directories.get(old.entityId)) {
        if (inside(folder, fromStem)) {
          nextDirectories.get(old.entityId).delete(folder);
          const replaced = replace(folder);
          if (replaced) nextDirectories.get(targetEntityId).add(logicalPath(replaced));
        }
      }
      for (const entry of entities.values()) {
        if (entry.parent?.entityId === old.entityId && inside(entry.parent.path, fromStem)) {
          const replacedParentPath = replace(entry.parent.path);
          if (replacedParentPath) logicalPath(replacedParentPath);
          nextEntities.set(entry.id, {
            ...entry,
            parent: { entityId: targetEntityId, path: replacedParentPath },
            updatedAt: new Date().toISOString(),
          });
          if (replacedParentPath) {
            nextDirectories.get(targetEntityId).add(replacedParentPath);
            addParents(nextDirectories, targetEntityId, replacedParentPath);
          }
        }
      }
      check(nextEntities, nextPages, nextDirectories);
      await persist(nextEntities, nextPages, nextDirectories);
      return { moved: true, filename, entityId: targetEntityId, path: targetPath };
    },
    async forgetPage(filename) {
      pageFilename(filename);
      const next = new Map(pages);
      next.delete(filename);
      // Removing a diagram never removes its containing folders or scope anchor.
      await persist(entities, next, directories);
    },
    async createFolder(id, path) {
      const requestedPath = path;
      const target = this.resolve(id, logicalPath(path));
      id = target.entityId; path = target.path;
      if (!path || directories.get(id).has(path)) throw new ApiError(409, 'Folder already exists');
      const next = copyDirectories(); next.get(id).add(path); addParents(next, id, path);
      check(entities, pages, next); await persist(entities, pages, next); return { path: requestedPath };
    },
    // The complete transformation is preflighted on copies and written with one
    // atomic catalog rename. No HTML/source files or credentials are rewritten.
    async moveFolder(id, path, newPath) {
      logicalPath(path); logicalPath(newPath);
      const source = this.resolve(id, path);
      const target = this.resolve(id, newPath.split('/').slice(0, -1).join('/'));
      return this.move({ ...source, kind: 'folder' }, target, newPath.split('/').at(-1), id, true);
    },
    async move(source, destination, name, scope, createParents = false) {
      if (!object(source) || !object(destination) || !['page', 'folder'].includes(source.kind)) throw new ApiError(400, 'Invalid move');
      if (name !== undefined && (typeof name !== 'string' || name.includes('/'))) throw new ApiError(400, 'Name must be a single path segment');
      let target = destination.entityId === null ? { entityId: null, path: '' } : this.resolve(destination.entityId, destination.path);
      if (destination.entityId === null && destination.path !== '') throw new ApiError(400, 'Root has no relative path');
      if (!createParents && target.entityId !== null && target.path && !directories.get(target.entityId).has(target.path)) throw new ApiError(404, 'Destination folder not found');
      if (source.kind === 'page') {
        pageFilename(source.filename);
        const old = this.location(source.filename);
        name ??= old.path.split('/').at(-1);
        const path = logicalPath(combine(target.path, name), true);
        return this.movePage(source.filename, target.entityId, path, scope);
      }
      const from = this.resolve(source.entityId, source.path);
      if (from.path && !directories.get(from.entityId).has(from.path)) throw new ApiError(404, 'Folder not found');
      const anchor = from.path === '' ? this.entity(from.entityId) : null;
      name ??= anchor ? anchor.name : from.path.split('/').at(-1);
      logicalPath(name);
      if (name.includes('/')) throw new ApiError(400, 'Folder name must be a single path segment');
      if (scope !== undefined && (!this.inScope(scope, from.entityId) || !this.inScope(scope, target.entityId) || anchor?.id === scope)) throw new ApiError(403, 'Move is outside folder scope');
      const targetPath = this.relative(from.entityId, target.entityId, target.path);
      if (targetPath !== null && (anchor || inside(targetPath, from.path))) {
        throw new ApiError(409, 'Cannot move a folder into itself or its descendants');
      }
      const newPath = combine(target.path, name);
      const oldParent = anchor ? anchor.parent ?? { entityId: null, path: '' }
        : { entityId: from.entityId, path: from.path.split('/').slice(0, -1).join('/') };
      if (oldParent.entityId === target.entityId && oldParent.path === target.path && (anchor ? anchor.name : from.path.split('/').at(-1)) === name) {
        return { moved: false, entityId: anchor?.id ?? from.entityId, path: anchor ? '' : from.path };
      }
      const nextEntities = new Map(entities), nextPages = new Map(pages), nextDirectories = copyDirectories();
      if (createParents && target.entityId !== null && target.path) {
        nextDirectories.get(target.entityId).add(target.path);
        addParents(nextDirectories, target.entityId, target.path);
      }
      if (target.entityId === null) rootCollision(name, anchor?.id);
      if (anchor) {
        nextEntities.set(anchor.id, { ...anchor, name, parent: target.entityId === null ? null : { ...target }, updatedAt: new Date().toISOString() });
      } else {
        if (target.entityId !== null && (directories.get(target.entityId).has(newPath) || [...entities.values()].some(entry => entry.parent?.entityId === target.entityId && combine(entry.parent.path, entry.name) === newPath))) throw new ApiError(409, 'Destination already exists');
        if (target.entityId === null) {
          const now = new Date().toISOString(), id = randomUUID();
          nextEntities.set(id, { id, name: entityName(name), parent: null, createdAt: now, updatedAt: now });
          nextDirectories.set(id, new Set());
          target = { entityId: id, path: '' };
        } else target = { entityId: target.entityId, path: newPath };
        const replace = value => combine(target.path, value.slice(from.path.length).replace(/^\//, ''));
        for (const [filename, entry] of pages) if (entry.entityId === from.entityId && inside(entry.path, from.path)) {
          nextPages.set(filename, { entityId: target.entityId, path: replace(entry.path) });
        }
        for (const folder of directories.get(from.entityId)) if (inside(folder, from.path)) {
          nextDirectories.get(from.entityId).delete(folder);
          const replaced = replace(folder);
          if (replaced) nextDirectories.get(target.entityId).add(replaced);
        }
        for (const entry of entities.values()) if (entry.parent?.entityId === from.entityId && inside(entry.parent.path, from.path)) {
          nextEntities.set(entry.id, { ...entry, parent: { entityId: target.entityId, path: replace(entry.parent.path) }, updatedAt: new Date().toISOString() });
        }
      }
      check(nextEntities, nextPages, nextDirectories);
      await persist(nextEntities, nextPages, nextDirectories);
      return { moved: true, entityId: anchor?.id ?? target.entityId, path: anchor ? '' : target.path };
    },
    async removeFolder(id, path) {
      const found = this.resolve(id, logicalPath(path));
      id = found.entityId; path = found.path;
      if (!path) throw new ApiError(409, 'Anchored folders must be deleted by an administrator');
      if (!directories.get(id).has(path)) throw new ApiError(404, 'Folder not found');
      if ([...directories.get(id)].some(value => value.startsWith(`${path}/`)) ||
          [...pages.values()].some(entry => entry.entityId === id && entry.path.startsWith(`${path}/`)) ||
          [...entities.values()].some(entry => entry.parent?.entityId === id && inside(entry.parent.path, path))) throw new ApiError(409, 'Folder is not empty');
      const next = copyDirectories(); next.get(id).delete(path); await persist(entities, pages, next);
    },
  };
}
