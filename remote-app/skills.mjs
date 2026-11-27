import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ApiError } from './catalog.mjs';

const execute = promisify(execFile);

const GIT_AUTHOR_NAME = 'Visual Explainer';
const GIT_AUTHOR_EMAIL = 'skills@visual-explainer.local';

const SKILL_KEY_ID_RE = /^sk_[0-9a-f]{16}$/;
const SKILL_KEY_SECRET_RE = /^ve_sk_[A-Za-z0-9_-]{43}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const EXPLAINER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9/-]{0,80}$/;
const TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEMPLATE_DOC_RE = /^templates\/[a-z0-9][a-z0-9-]{0,63}\.md$/;
const RESERVED_TEMPLATE_SLUGS = new Set(['html', 'source', 'thumb', 'anchors']);
const MAX_KEY_NAME_LEN = 64;
const MAX_TITLE_LEN = 160;
const MAX_SUMMARY_LEN = 400;
const MAX_DOC_BYTES = 2 * 1024 * 1024;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIsoTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function validateTemplateId(slug) {
  if (typeof slug !== 'string' || !TEMPLATE_SLUG_RE.test(slug)) {
    throw new ApiError(400, 'Invalid template id (expected 1-64 lowercase alphanumeric or hyphen characters)');
  }
  if (RESERVED_TEMPLATE_SLUGS.has(slug)) {
    throw new ApiError(400, 'Template id must not use reserved names: html, source, thumb');
  }
  return slug;
}

export function templateSlugFromDocId(docId) {
  if (typeof docId !== 'string' || !TEMPLATE_DOC_RE.test(docId)) return null;
  return docId.slice('templates/'.length, -'.md'.length);
}

export function parseTemplateFrontmatter(slug, markdown) {
  const text = typeof markdown === 'string' ? markdown : '';
  let title = '';
  let whenToUse = '';
  let body = text;
  const fmMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (fmMatch) {
    body = text.slice(fmMatch[0].length);
    for (const rawLine of fmMatch[1].split(/\r?\n/)) {
      const idx = rawLine.indexOf(':');
      if (idx <= 0) continue;
      const key = rawLine.slice(0, idx).trim();
      let val = rawLine.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        if (val.length >= 2) val = val.slice(1, -1).trim();
      }
      if (key === 'title' && val) title = val;
      else if ((key === 'whenToUse' || key === 'when_to_use') && val) whenToUse = val;
    }
  }
  const cleanMeta = (val, max) => String(val || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  if (!whenToUse) {
    let inFence = false;
    for (const rawLine of body.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (trimmed.startsWith('#') || /^[-*_]{3,}$/.test(trimmed)) continue;
      whenToUse = trimmed;
      break;
    }
  }
  return {
    title: cleanMeta(title, MAX_TITLE_LEN) || slug,
    whenToUse: cleanMeta(whenToUse, MAX_SUMMARY_LEN),
  };
}

export function validateDocIdSyntax(id) {
  if (typeof id !== 'string' || !id || !id.isWellFormed() || id.includes('\\') || /\p{Cc}/u.test(id)) {
    throw new ApiError(400, 'Invalid skill document id');
  }
  if (id === 'SKILL.md' || id === 'webui/bootstrap-prompt.md') return id;
  if (/^(?:references|commands)\/[a-z0-9-]+\.md$/.test(id)) return id;
  if (TEMPLATE_DOC_RE.test(id)) {
    validateTemplateId(id.slice('templates/'.length, -'.md'.length));
    return id;
  }
  throw new ApiError(400, 'Invalid skill document id');
}

export function docCategory(id) {
  validateDocIdSyntax(id);
  if (id === 'SKILL.md') return 'core';
  if (id.startsWith('references/')) return 'reference';
  if (id.startsWith('commands/')) return 'command';
  if (id.startsWith('webui/')) return 'webui';
  if (id.startsWith('templates/')) return 'template';
  throw new ApiError(400, 'Invalid skill document id');
}

export function docIdFromUri(uri) {
  if (typeof uri !== 'string') return null;
  if (uri === 'visual-explainer://skill/SKILL.md') return 'SKILL.md';
  const match = /^visual-explainer:\/\/((?:references|commands)\/[a-z0-9-]+\.md)$/.exec(uri);
  if (match) return match[1];
  const tplMatch = /^visual-explainer:\/\/(templates\/[a-z0-9][a-z0-9-]{0,63}\.md)$/.exec(uri);
  if (tplMatch) {
    const slug = tplMatch[1].slice('templates/'.length, -'.md'.length);
    if (!RESERVED_TEMPLATE_SLUGS.has(slug)) return tplMatch[1];
  }
  return null;
}

export function validateExplainerId(id) {
  if (typeof id !== 'string' || !EXPLAINER_ID_RE.test(id) || id.endsWith('/') || id.includes('//')) {
    throw new ApiError(400, 'Invalid explainer id');
  }
  const segments = id.split('/');
  if (segments.some(seg => !seg || seg === '.' || seg === '..')) {
    throw new ApiError(400, 'Invalid explainer id');
  }
  const tail = segments.at(-1);
  if (segments.length > 1 && ['html', 'source', 'thumb', 'anchors'].includes(tail)) {
    throw new ApiError(400, 'Explainer id must not end with reserved sub-route segment');
  }
  return id;
}

export function safeThumbId(explainerId) {
  validateExplainerId(explainerId);
  return explainerId.replaceAll('/', '__');
}

function cleanKeyName(value) {
  if (value === undefined || value === null || value === '') return 'Skill Editor';
  if (typeof value !== 'string' || !value.isWellFormed()) throw new ApiError(400, 'Key name must be a string');
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > MAX_KEY_NAME_LEN || /\p{Cc}/u.test(trimmed)) {
    throw new ApiError(400, `Key name must contain 1–${MAX_KEY_NAME_LEN} printable characters`);
  }
  return trimmed;
}

function cleanSingleLine(value, field, max, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !value.isWellFormed()) throw new ApiError(400, `${field} must be a string`);
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim();
  if ([...cleaned].length > max) throw new ApiError(400, `${field} exceeds ${max} characters`);
  return cleaned || fallback;
}

function cleanLayer(value, fallback = 1) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = typeof value === 'number' ? value : (/^\d+$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN);
  if (!Number.isInteger(num) || num < 0 || num > 9) throw new ApiError(400, 'layer must be an integer between 0 and 9');
  return num;
}

function cleanParentId(value, selfId = null) {
  if (value === undefined || value === null || value === '') return null;
  const parentId = validateExplainerId(String(value).trim());
  if (selfId && parentId === selfId) throw new ApiError(400, 'parentId must not equal explainer id');
  return parentId;
}

function cleanNoteText(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(400, 'Invalid note');
  }
  const trimmed = value.trim();
  if ([...trimmed].length > 500) throw new ApiError(400, 'Note exceeds 500 characters');
  return trimmed;
}

function makeQueue() {
  let queue = Promise.resolve();
  return operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
}

async function statOrNull(path) {
  return lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function writeAtomicJson(path, payload, label) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => console.error(`${label} temporary cleanup failed`));
  }
}

async function writeAtomicBytes(path, bytes, label) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => console.error(`${label} temporary cleanup failed`));
  }
}

async function assertNoSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Skills metadata directory must not contain symlinks');
    if (entry.isDirectory()) await assertNoSymlinks(join(directory, entry.name));
  }
}

function validateKeyEntry(entry) {
  return isObject(entry) &&
    typeof entry.id === 'string' && SKILL_KEY_ID_RE.test(entry.id) &&
    typeof entry.name === 'string' && entry.name.trim() === entry.name && entry.name.length > 0 && [...entry.name].length <= MAX_KEY_NAME_LEN &&
    typeof entry.prefix === 'string' && entry.prefix.startsWith('ve_sk_') && entry.prefix.length <= 20 &&
    typeof entry.hash === 'string' && HEX_SHA256_RE.test(entry.hash) &&
    isIsoTimestamp(entry.createdAt) &&
    typeof entry.createdBy === 'string' && entry.createdBy.length > 0 && entry.createdBy.length <= 80 &&
    (entry.lastUsedAt === null || isIsoTimestamp(entry.lastUsedAt));
}

function validateConflictEntry(entry) {
  return isObject(entry) &&
    typeof entry.base === 'string' &&
    typeof entry.ours === 'string' &&
    typeof entry.theirs === 'string' &&
    (entry.mergedMarkers === undefined || typeof entry.mergedMarkers === 'string') &&
    typeof entry.upstreamVersion === 'string' &&
    typeof entry.upstreamRevision === 'string' &&
    isIsoTimestamp(entry.detectedAt);
}

const publicKeyMetadata = ({ id, name, prefix, createdAt, createdBy, lastUsedAt }) => ({
  id, name, prefix, createdAt, createdBy, lastUsedAt,
});

function normalizeUpstreamDocs(input) {
  const map = new Map();
  if (input instanceof Map) {
    for (const [id, value] of input.entries()) {
      validateDocIdSyntax(id);
      const content = typeof value === 'string' ? value : value?.content;
      if (typeof content !== 'string') throw new Error(`Skill doc ${id} must have string content`);
      map.set(id, content);
    }
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!isObject(item)) throw new Error('Invalid upstreamDocs entry');
      validateDocIdSyntax(item.id);
      if (typeof item.content !== 'string') throw new Error(`Skill doc ${item.id} must have string content`);
      map.set(item.id, item.content);
    }
  } else if (isObject(input)) {
    for (const [id, content] of Object.entries(input)) {
      validateDocIdSyntax(id);
      if (typeof content !== 'string') throw new Error(`Skill doc ${id} must have string content`);
      map.set(id, content);
    }
  } else {
    throw new Error('upstreamDocs is required');
  }
  return new Map([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function assertContainedPath(rootDir, targetPath) {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('Built-in skill file path escapes builtinDir');
  }
  return resolvedTarget;
}

async function loadBuiltinResources(builtinDir, explicitExplainers = null) {
  let bootstrapPrompt = null;
  const templates = new Map();
  const explainers = [];
  if (builtinDir) {
    const promptPath = join(builtinDir, 'bootstrap-prompt.md');
    const promptStat = await statOrNull(promptPath);
    if (promptStat) {
      if (!promptStat.isFile() || promptStat.isSymbolicLink()) throw new Error('Built-in bootstrap-prompt.md must be a regular file');
      bootstrapPrompt = await readFile(promptPath, 'utf8');
    }
    const templatesDir = join(builtinDir, 'templates');
    const templatesStat = await statOrNull(templatesDir);
    if (templatesStat) {
      if (!templatesStat.isDirectory() || templatesStat.isSymbolicLink()) {
        throw new Error('Built-in templates directory must be a regular directory');
      }
      const entries = (await readdir(templatesDir, { withFileTypes: true }))
        .filter(entry => entry.name.endsWith('.md'))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error(`Built-in template ${entry.name} must be a regular file`);
        }
        const docId = validateDocIdSyntax(`templates/${entry.name}`);
        const tplPath = assertContainedPath(builtinDir, join(templatesDir, entry.name));
        templates.set(docId, await readFile(tplPath, 'utf8'));
      }
    }
  }
  if (Array.isArray(explicitExplainers)) {
    for (const item of explicitExplainers) {
      validateExplainerId(item.id);
      if (typeof item.html !== 'string') throw new Error(`Built-in explainer ${item.id} requires html`);
      explainers.push({
        id: item.id,
        title: cleanSingleLine(item.title, 'title', MAX_TITLE_LEN, item.id),
        summary: cleanSingleLine(item.summary, 'summary', MAX_SUMMARY_LEN, ''),
        layer: cleanLayer(item.layer, item.covers?.length === 1 && item.covers[0] === '*' ? 0 : 1),
        parentId: cleanParentId(item.parentId, item.id),
        covers: Array.isArray(item.covers) ? [...item.covers] : [],
        skillHash: typeof item.skillHash === 'string' ? item.skillHash : '',
        updatedAt: isIsoTimestamp(item.updatedAt) ? item.updatedAt : new Date().toISOString(),
        html: item.html,
        sourceHtml: typeof item.sourceHtml === 'string' ? item.sourceHtml : item.html,
      });
    }
    return { bootstrapPrompt, templates, explainers };
  }
  if (builtinDir) {
    const manifestPath = join(builtinDir, 'manifest.json');
    const manifestStat = await statOrNull(manifestPath);
    if (manifestStat) {
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('Built-in manifest.json must be a regular file');
      const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!isObject(raw) || !Array.isArray(raw.explainers)) throw new Error('Malformed built-in skills manifest.json');
      for (const entry of raw.explainers) {
        if (!isObject(entry)) throw new Error('Malformed built-in explainer entry');
        const id = validateExplainerId(entry.id);
        const htmlRel = typeof entry.htmlFile === 'string' ? entry.htmlFile : join('explainers', `${id}.html`);
        const srcRel = typeof entry.sourceFile === 'string' ? entry.sourceFile : join('explainers', `${id}.src.html`);
        const htmlPath = assertContainedPath(builtinDir, join(builtinDir, htmlRel));
        const srcPath = assertContainedPath(builtinDir, join(builtinDir, srcRel));
        const html = await readFile(htmlPath, 'utf8');
        const srcStat = await statOrNull(srcPath);
        const sourceHtml = srcStat && srcStat.isFile() && !srcStat.isSymbolicLink() ? await readFile(srcPath, 'utf8') : html;
        explainers.push({
          id,
          title: cleanSingleLine(entry.title, 'title', MAX_TITLE_LEN, id),
          summary: cleanSingleLine(entry.summary, 'summary', MAX_SUMMARY_LEN, ''),
          layer: cleanLayer(entry.layer, entry.covers?.length === 1 && entry.covers[0] === '*' ? 0 : 1),
          parentId: cleanParentId(entry.parentId, id),
          covers: Array.isArray(entry.covers) ? [...entry.covers] : [],
          skillHash: typeof entry.skillHash === 'string' ? entry.skillHash : '',
          updatedAt: isIsoTimestamp(entry.updatedAt) ? entry.updatedAt : new Date().toISOString(),
          html,
          sourceHtml,
        });
      }
    }
  }
  return { bootstrapPrompt, templates, explainers };
}

function normalizeExplainerEntry(entry) {
  const id = validateExplainerId(entry.id);
  const covers = Array.isArray(entry.covers) ? [...entry.covers] : [];
  return {
    id,
    title: cleanSingleLine(entry.title, 'title', MAX_TITLE_LEN, id),
    summary: cleanSingleLine(entry.summary, 'summary', MAX_SUMMARY_LEN, ''),
    layer: cleanLayer(entry.layer, covers.length === 1 && covers[0] === '*' ? 0 : (id.includes('/') ? 2 : 1)),
    parentId: cleanParentId(entry.parentId, id),
    covers,
    skillHash: typeof entry.skillHash === 'string' ? entry.skillHash : '',
    updatedAt: isIsoTimestamp(entry.updatedAt) ? entry.updatedAt : new Date().toISOString(),
  };
}

export async function createSkills(outputDir, {
  upstreamDocs,
  upstreamMeta = {},
  builtinDir = null,
  builtinExplainers = null,
} = {}) {
  const resolvedOutput = resolve(outputDir);
  const gitDir = join(resolvedOutput, '.skills-git');
  const statePath = join(resolvedOutput, '.skills-state.json');
  const thumbsDir = join(resolvedOutput, '.skills-thumbs');

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
    GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: GIT_AUTHOR_EMAIL,
  });
  const gitConfigArgs = [
    '-c', `user.name=${GIT_AUTHOR_NAME}`,
    '-c', `user.email=${GIT_AUTHOR_EMAIL}`,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false',
    '-c', 'protocol.allow=never',
  ];

  async function git(args, { input, index, allowed = [0], timeout = 30000, bare = true } = {}) {
    const prefix = bare ? [`--git-dir=${gitDir}`, ...gitConfigArgs] : gitConfigArgs;
    const pending = execute('git', [...prefix, ...args], {
      cwd: resolvedOutput,
      env: index ? { ...env, GIT_INDEX_FILE: index } : env,
      shell: false,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    pending.child.stdin.on('error', () => {});
    pending.child.stdin.end(input);
    try {
      const result = await pending;
      return { code: 0, stdout: result.stdout };
    } catch (error) {
      if (allowed.includes(error.code)) return { code: error.code, stdout: error.stdout ?? '' };
      throw error;
    }
  }

  async function mergeFile3Way(oursText, baseText, theirsText) {
    const tempDir = await mkdtemp(join(tmpdir(), 've-skills-merge-'));
    try {
      const oursPath = join(tempDir, 'ours.md');
      const basePath = join(tempDir, 'base.md');
      const theirsPath = join(tempDir, 'theirs.md');
      await Promise.all([
        writeFile(oursPath, oursText, { mode: 0o600 }),
        writeFile(basePath, baseText, { mode: 0o600 }),
        writeFile(theirsPath, theirsText, { mode: 0o600 }),
      ]);
      const pending = execute('git', [
        ...gitConfigArgs,
        'merge-file', '-p',
        '-L', 'active',
        '-L', 'base',
        '-L', 'upstream',
        oursPath, basePath, theirsPath,
      ], {
        cwd: tempDir,
        env,
        shell: false,
        timeout: 30000,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      });
      try {
        const result = await pending;
        return { clean: true, content: result.stdout };
      } catch (error) {
        if (typeof error.code === 'number' && error.code > 0 && error.code < 128) {
          return { clean: false, conflicts: error.code, mergedMarkers: error.stdout ?? '' };
        }
        throw error;
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function revParse(ref) {
    const res = await git(['rev-parse', '--verify', '--quiet', ref], { allowed: [0, 1] });
    return res.code === 0 ? res.stdout.trim() : null;
  }

  async function readTreeOids(refOrRev) {
    const map = new Map();
    const out = (await git(['ls-tree', '-rz', '--full-tree', refOrRev])).stdout;
    for (const entry of out.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const match = entry.slice(0, tab).match(/^100(?:644|755) blob ([0-9a-f]+)$/);
      if (match) map.set(entry.slice(tab + 1), match[1]);
    }
    return map;
  }

  async function readTreeContents(refOrRev) {
    const oids = await readTreeOids(refOrRev);
    const files = new Map();
    for (const [path, oid] of oids.entries()) {
      files.set(path, (await git(['cat-file', 'blob', oid])).stdout);
    }
    return files;
  }

  async function writeTreeFromFiles(filesMap) {
    const tempDir = await mkdtemp(join(tmpdir(), 've-skills-idx-'));
    try {
      const index = join(tempDir, 'index');
      await git(['read-tree', '--empty'], { index });
      const entries = [];
      const sorted = [...filesMap.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [path, content] of sorted) {
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
        const oid = (await git(['hash-object', '-w', '--stdin'], { input: bytes })).stdout.trim();
        entries.push(Buffer.from(`100644 ${oid}\t${path}\0`));
      }
      if (entries.length) {
        await git(['update-index', '-z', '--index-info'], { index, input: Buffer.concat(entries) });
      }
      return (await git(['write-tree'], { index })).stdout.trim();
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function commitTree(treeOid, parents, message) {
    const args = ['commit-tree', treeOid];
    for (const parent of parents) {
      if (parent) args.push('-p', parent);
    }
    return (await git(args, { input: `${message.trim()}\n` })).stdout.trim();
  }

  async function updateRef(ref, nextOid, oldOid = null) {
    const args = ['update-ref', ref, nextOid];
    if (oldOid !== null) args.push(oldOid);
    await git(args);
  }

  // Initialize or validate .skills-git bare repository
  const gitStat = await statOrNull(gitDir);
  if (gitStat) {
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink() || await realpath(gitDir) !== gitDir) {
      throw new Error('Skills Git store must be a local directory, not a symlink');
    }
    await assertNoSymlinks(gitDir);
    if (await statOrNull(join(gitDir, 'objects/info/alternates')) || await statOrNull(join(gitDir, 'commondir'))) {
      throw new Error('Skills Git repository must not share external objects or commondir');
    }
    await git(['config', 'core.bare', 'true']);
  } else {
    await git(['init', '--bare', '--initial-branch=upstream', '--template=', gitDir], { bare: false });
  }

  // Load or initialize .skills-state.json
  let state = { version: 1, editEnabled: false, defaultTemplate: 'default', keys: [], conflicts: {} };
  const stateStat = await statOrNull(statePath);
  if (stateStat) {
    if (!stateStat.isFile() || stateStat.isSymbolicLink()) {
      throw new Error('Skills state store must be a regular private file');
    }
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    if (!isObject(raw) || raw.version !== 1 || typeof raw.editEnabled !== 'boolean' ||
        !Array.isArray(raw.keys) || !isObject(raw.conflicts)) {
      throw new Error('Malformed skills state store');
    }
    if (raw.defaultTemplate !== undefined && (typeof raw.defaultTemplate !== 'string' || !TEMPLATE_SLUG_RE.test(raw.defaultTemplate) || RESERVED_TEMPLATE_SLUGS.has(raw.defaultTemplate))) {
      throw new Error('Malformed defaultTemplate in skills state store');
    }
    const seenKeyIds = new Set();
    for (const entry of raw.keys) {
      if (!validateKeyEntry(entry) || seenKeyIds.has(entry.id)) {
        throw new Error('Malformed skill key entry');
      }
      seenKeyIds.add(entry.id);
    }
    const conflicts = {};
    for (const [docId, conflict] of Object.entries(raw.conflicts)) {
      validateDocIdSyntax(docId);
      if (!validateConflictEntry(conflict)) throw new Error(`Malformed conflict entry for ${docId}`);
      conflicts[docId] = { ...conflict };
    }
    state = {
      version: 1,
      editEnabled: raw.editEnabled,
      defaultTemplate: typeof raw.defaultTemplate === 'string' ? raw.defaultTemplate : 'default',
      keys: raw.keys.map(entry => ({ ...entry })),
      conflicts,
    };
    await chmod(statePath, 0o600);
  }

  async function persistState(nextState) {
    await writeAtomicJson(statePath, nextState, 'Skills state');
    state = nextState;
  }

  const enqueue = makeQueue();

  // In-memory state mirrors of active & upstream branches (refreshed on every commit)
  let currentUpstreamMeta = { upstreamVersion: '', upstreamRevision: '', builtinHash: '' };
  let upstreamDocsMap = new Map();
  let activeDocsMap = new Map();
  let upstreamExplainers = [];
  let activeExplainers = [];
  let upstreamExplainerFiles = new Map(); // id -> { html, sourceHtml }
  let activeExplainerFiles = new Map();   // id -> { html, sourceHtml }
  let activeFilesCache = new Map();       // full tree path -> string
  let activeHistoryCache = [];            // oldest-first [{ version, label, revision, date, message, files }]

  function parseManifestFromFiles(filesMap) {
    const raw = filesMap.get('explainers/manifest.json');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!isObject(parsed) || !Array.isArray(parsed.explainers)) return [];
    return parsed.explainers.map(normalizeExplainerEntry);
  }

  function extractExplainerFiles(filesMap, entries) {
    const map = new Map();
    for (const entry of entries) {
      const html = filesMap.get(`explainers/${entry.id}.html`) ?? '';
      const sourceHtml = filesMap.get(`explainers/${entry.id}.src.html`) ?? html;
      map.set(entry.id, { html, sourceHtml });
    }
    return map;
  }

  async function refreshHistoryCache() {
    const activeHead = await revParse('refs/heads/active');
    if (!activeHead) {
      activeHistoryCache = [];
      return;
    }
    const raw = (await git([
      'log', '--first-parent', '--diff-merges=first-parent', '--root',
      '--no-renames', '--name-only',
      '--format=%x1e%H%x1f%cI%x1f%s',
      'refs/heads/active',
    ])).stdout;
    const records = [];
    for (const block of raw.split('\x1e')) {
      if (!block.trim()) continue;
      const lines = block.split('\n');
      const header = lines[0];
      const [revision, date, ...subjectParts] = header.split('\x1f');
      if (!revision) continue;
      const message = subjectParts.join('\x1f');
      const files = lines.slice(1).map(line => line.trim()).filter(Boolean);
      records.push({ revision, date, message, files });
    }
    // Reverse to oldest-first to assign sequential v1, v2, ...
    records.reverse();
    activeHistoryCache = records.map((rec, index) => ({
      version: index + 1,
      label: `v${index + 1}`,
      revision: rec.revision,
      date: rec.date,
      message: rec.message,
      files: rec.files,
    }));
  }

  async function refreshCaches() {
    const [upFiles, actFiles] = await Promise.all([
      readTreeContents('refs/heads/upstream'),
      readTreeContents('refs/heads/active'),
    ]);
    const metaRaw = upFiles.get('meta.json');
    currentUpstreamMeta = metaRaw ? JSON.parse(metaRaw) : { upstreamVersion: '', upstreamRevision: '', builtinHash: '' };

    const upDocs = new Map();
    const actDocs = new Map();
    for (const [path, content] of upFiles.entries()) {
      if (path.startsWith('docs/')) upDocs.set(path.slice(5), content);
    }
    for (const [path, content] of actFiles.entries()) {
      if (path.startsWith('docs/')) actDocs.set(path.slice(5), content);
    }
    upstreamDocsMap = new Map([...upDocs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    activeDocsMap = new Map([...actDocs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    upstreamExplainers = parseManifestFromFiles(upFiles);
    activeExplainers = parseManifestFromFiles(actFiles);
    upstreamExplainerFiles = extractExplainerFiles(upFiles, upstreamExplainers);
    activeExplainerFiles = extractExplainerFiles(actFiles, activeExplainers);
    activeFilesCache = actFiles;
    await refreshHistoryCache();
  }

  function requireManagedDoc(docId) {
    validateDocIdSyntax(docId);
    if (!activeDocsMap.has(docId) && !upstreamDocsMap.has(docId)) {
      throw new ApiError(404, `Skill document not found: ${docId}`);
    }
    return docId;
  }

  function managedDocIdsSorted() {
    return [...activeDocsMap.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  function normalizeCovers(covers) {
    if (!Array.isArray(covers) || covers.length === 0) {
      throw new ApiError(400, 'Explainer covers must be a non-empty list of managed doc ids or ["*"]');
    }
    const cleaned = covers.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
    if (cleaned.length === 0) {
      throw new ApiError(400, 'Explainer covers must not be empty');
    }
    if (cleaned.includes('*')) {
      if (cleaned.length !== 1) throw new ApiError(400, 'Wildcard "*" cover must be used alone as ["*"]');
      return ['*'];
    }
    const unique = [];
    const seen = new Set();
    for (const id of cleaned) {
      requireManagedDoc(id);
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    return unique;
  }

  function inferCovers(explainerId) {
    validateExplainerId(explainerId);
    const existing = activeExplainers.find(entry => entry.id === explainerId);
    if (existing) return [...existing.covers];
    if (explainerId === 'overview') return ['*'];
    if (explainerId === 'SKILL' && activeDocsMap.has('SKILL.md')) return ['SKILL.md'];
    if (explainerId === 'bootstrap-prompt' && activeDocsMap.has('webui/bootstrap-prompt.md')) return ['webui/bootstrap-prompt.md'];
    if (activeDocsMap.has(`${explainerId}.md`)) return [`${explainerId}.md`];
    if (!explainerId.includes('/') && activeDocsMap.has(`references/${explainerId}.md`)) return [`references/${explainerId}.md`];
    if (!explainerId.includes('/') && activeDocsMap.has(`commands/${explainerId}.md`)) return [`commands/${explainerId}.md`];
    throw new ApiError(400, `Cannot infer covers for new explainer "${explainerId}"; provide X-VE-Covers header`);
  }

  function parseCoversInput(explainerId, rawCovers) {
    if (rawCovers === undefined || rawCovers === null || rawCovers === '') {
      return inferCovers(explainerId);
    }
    if (Array.isArray(rawCovers)) return normalizeCovers(rawCovers);
    if (typeof rawCovers === 'string') {
      return normalizeCovers(rawCovers.split(',').map(part => part.trim()).filter(Boolean));
    }
    throw new ApiError(400, 'Invalid covers specification');
  }

  function expectedSkillHash(covers, docsMap = activeDocsMap) {
    const normalized = Array.isArray(covers) ? covers : [];
    if (normalized.length === 1 && normalized[0] !== '*') {
      const content = docsMap.get(normalized[0]);
      if (content === undefined) throw new ApiError(404, `Skill document not found: ${normalized[0]}`);
      return sha256Hex(content);
    }
    const resolvedIds = normalized.length === 1 && normalized[0] === '*'
      ? [...docsMap.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : [...new Set(normalized)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const pairs = resolvedIds.map(id => {
      const content = docsMap.get(id);
      if (content === undefined) throw new ApiError(404, `Skill document not found: ${id}`);
      return [id, sha256Hex(content)];
    });
    return sha256Hex(JSON.stringify(pairs));
  }

  function formatExplainer(entry) {
    const expected = expectedSkillHash(entry.covers);
    const synced = Boolean(entry.skillHash && entry.skillHash === expected);
    return {
      ...entry,
      covers: [...entry.covers],
      expectedSkillHash: expected,
      synced,
    };
  }

  function findExplainerForDoc(docId, explainersList = activeExplainers) {
    const dedicated = explainersList.find(entry => entry.covers.length === 1 && entry.covers[0] === docId);
    if (dedicated) return dedicated;
    const grouped = explainersList.find(entry => !(entry.covers.length === 1 && entry.covers[0] === '*') && entry.covers.includes(docId));
    return grouped ?? null;
  }

  function formatDocSummary(docId) {
    requireManagedDoc(docId);
    const content = activeDocsMap.get(docId) ?? '';
    const isCustom = !upstreamDocsMap.has(docId);
    const upstreamContent = isCustom ? null : upstreamDocsMap.get(docId);
    const sha256 = sha256Hex(content);
    const upstreamSha256 = isCustom ? null : sha256Hex(upstreamContent);
    const hasConflict = Boolean(state.conflicts[docId]);
    const status = hasConflict ? 'conflict' : (isCustom ? 'custom' : (sha256 !== upstreamSha256 ? 'overridden' : 'upstream'));
    const explainer = findExplainerForDoc(docId);
    const explainerMeta = explainer ? formatExplainer(explainer) : null;
    return {
      id: docId,
      category: docCategory(docId),
      status,
      sha256,
      upstreamSha256,
      bytes: Buffer.byteLength(content, 'utf8'),
      explainerId: explainerMeta?.id ?? null,
      explainerSynced: Boolean(explainerMeta?.synced),
      hasConflict,
    };
  }

  function templateSlugsInDocsMap(docsMap = activeDocsMap) {
    const slugs = [];
    for (const docId of docsMap.keys()) {
      const slug = templateSlugFromDocId(docId);
      if (slug) slugs.push(slug);
    }
    return slugs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  function resolveDefaultTemplateId(docsMap = activeDocsMap) {
    const slugs = templateSlugsInDocsMap(docsMap);
    if (!slugs.length) return null;
    if (state.defaultTemplate && slugs.includes(state.defaultTemplate)) return state.defaultTemplate;
    if (slugs.includes('default')) return 'default';
    return slugs[0];
  }

  function formatTemplateSummary(slug) {
    validateTemplateId(slug);
    const docId = `templates/${slug}.md`;
    if (!activeDocsMap.has(docId)) throw new ApiError(404, `Template not found: ${slug}`);
    const content = activeDocsMap.get(docId);
    const meta = parseTemplateFrontmatter(slug, content);
    const summary = formatDocSummary(docId);
    const currentDefault = resolveDefaultTemplateId();
    return {
      id: slug,
      docId,
      title: meta.title,
      whenToUse: meta.whenToUse,
      isDefault: slug === currentDefault,
      builtIn: upstreamDocsMap.has(docId),
      status: summary.status,
      sha256: summary.sha256,
      explainerId: summary.explainerId,
      explainerSynced: summary.explainerSynced,
    };
  }

  function listTemplates() {
    const slugs = templateSlugsInDocsMap(activeDocsMap);
    const items = slugs.map(formatTemplateSummary);
    return items.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      if (a.id === 'default') return -1;
      if (b.id === 'default') return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  function latestVersionSummary() {
    const latest = activeHistoryCache.at(-1);
    return latest ? { ...latest, files: [...latest.files] } : null;
  }

  function resolveHistoryEntry(versionOrRev) {
    if (versionOrRev === undefined || versionOrRev === null || versionOrRev === '') {
      throw new ApiError(400, 'Expected a version label (e.g. v1) or commit revision');
    }
    const raw = typeof versionOrRev === 'number' ? String(versionOrRev) : String(versionOrRev).trim();
    const vMatch = /^v?(\d+)$/i.exec(raw);
    if (vMatch) {
      const num = Number(vMatch[1]);
      if (!Number.isInteger(num) || num < 1) throw new ApiError(400, 'Version must be a positive integer');
      const found = activeHistoryCache.find(entry => entry.version === num);
      if (!found) throw new ApiError(404, `Skill version v${num} not found`);
      return found;
    }
    if (/^[0-9a-f]{7,64}$/i.test(raw)) {
      const lower = raw.toLowerCase();
      const matches = activeHistoryCache.filter(entry => entry.revision.startsWith(lower));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new ApiError(400, 'Ambiguous commit revision prefix');
      throw new ApiError(404, 'Skill revision not found');
    }
    throw new ApiError(400, 'Expected a version label (e.g. v1) or commit revision');
  }

  function thumbFilePath(explainerId, theme = 'light') {
    const safe = safeThumbId(explainerId);
    return join(thumbsDir, theme === 'dark' ? `${safe}.thumb-dark.png` : `${safe}.thumb.png`);
  }

  async function ensureThumbsDir() {
    const info = await statOrNull(thumbsDir);
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Skills thumbnails directory must be a regular directory, not a symlink');
      }
      return;
    }
    await mkdir(thumbsDir, { recursive: true, mode: 0o700 });
  }

  async function removeThumbFiles(explainerId) {
    for (const theme of ['light', 'dark']) {
      const path = thumbFilePath(explainerId, theme);
      const info = await statOrNull(path);
      if (info && info.isFile() && !info.isSymbolicLink()) {
        await rm(path, { force: true }).catch(() => {});
      }
    }
  }

  async function clearAllThumbs() {
    const info = await statOrNull(thumbsDir);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) return;
    for (const entry of await readdir(thumbsDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.thumb(?:-dark)?\.png$/i.test(entry.name)) {
        await rm(join(thumbsDir, entry.name), { force: true }).catch(() => {});
      }
    }
  }

  async function syncUpstreamInternal({
    upstreamDocs: nextUpstreamDocsInput,
    upstreamMeta: nextMetaInput = {},
    builtinDir: nextBuiltinDir = builtinDir,
    builtinExplainers: nextBuiltinExplainers = null,
  }) {
    const nextDocs = normalizeUpstreamDocs(nextUpstreamDocsInput);
    const builtIn = await loadBuiltinResources(nextBuiltinDir, nextBuiltinExplainers);
    if (!nextDocs.has('webui/bootstrap-prompt.md') && builtIn.bootstrapPrompt !== null) {
      nextDocs.set('webui/bootstrap-prompt.md', builtIn.bootstrapPrompt);
    }
    for (const [docId, tplContent] of builtIn.templates.entries()) {
      if (!nextDocs.has(docId)) nextDocs.set(docId, tplContent);
    }
    const sortedDocs = new Map([...nextDocs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

    // Build next upstream tree files
    const contentFiles = new Map();
    for (const [docId, text] of sortedDocs.entries()) {
      contentFiles.set(`docs/${docId}`, text);
    }
    const manifestEntries = builtIn.explainers.map(item => {
      const covers = item.covers.length ? item.covers : ['*'];
      // Verify covers exist in sortedDocs
      if (!(covers.length === 1 && covers[0] === '*')) {
        for (const docId of covers) {
          if (!sortedDocs.has(docId)) throw new Error(`Built-in explainer ${item.id} covers unknown doc ${docId}`);
        }
      }
      const computedHash = item.skillHash || expectedSkillHash(covers, sortedDocs);
      return {
        id: item.id,
        title: item.title,
        summary: item.summary,
        layer: item.layer,
        parentId: item.parentId,
        covers,
        skillHash: computedHash,
        updatedAt: item.updatedAt,
      };
    });
    contentFiles.set('explainers/manifest.json', JSON.stringify({ explainers: manifestEntries }, null, 2) + '\n');
    for (const item of builtIn.explainers) {
      contentFiles.set(`explainers/${item.id}.html`, item.html);
      contentFiles.set(`explainers/${item.id}.src.html`, item.sourceHtml);
    }

    const builtinHash = sha256Hex(JSON.stringify(
      [...contentFiles.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ));
    const meta = {
      upstreamVersion: String(nextMetaInput.version ?? nextMetaInput.upstreamVersion ?? '0.0.0'),
      upstreamRevision: String(nextMetaInput.revision ?? nextMetaInput.upstreamRevision ?? ''),
      builtinHash,
    };
    const nextUpstreamFiles = new Map(contentFiles);
    nextUpstreamFiles.set('meta.json', JSON.stringify(meta, null, 2) + '\n');

    const nextUpstreamTree = await writeTreeFromFiles(nextUpstreamFiles);
    const oldUpstreamHead = await revParse('refs/heads/upstream');
    const oldActiveHead = await revParse('refs/heads/active');

    // Case 1: Fresh repository init
    if (!oldUpstreamHead) {
      const commit = await commitTree(nextUpstreamTree, [], `Initialize upstream skills (${meta.upstreamVersion})`);
      await updateRef('refs/heads/upstream', commit);
      await updateRef('refs/heads/active', commit);
      if (!(await statOrNull(statePath))) {
        await persistState(state);
      }
      await refreshCaches();
      return {
        action: 'initialized',
        upstreamRevision: commit,
        activeRevision: commit,
        mergedDocs: [],
        fastForwardedDocs: [...sortedDocs.keys()],
        conflictedDocs: [],
      };
    }

    const oldUpstreamTree = (await git(['rev-parse', `${oldUpstreamHead}^{tree}`])).stdout.trim();
    if (!oldActiveHead) {
      await updateRef('refs/heads/active', oldUpstreamHead);
    }

    // Case 2: No upstream change
    if (nextUpstreamTree === oldUpstreamTree) {
      if (!(await statOrNull(statePath))) {
        await persistState(state);
      }
      await refreshCaches();
      return {
        action: 'noop',
        upstreamRevision: oldUpstreamHead,
        activeRevision: await revParse('refs/heads/active'),
        mergedDocs: [],
        fastForwardedDocs: [],
        conflictedDocs: Object.keys(state.conflicts),
      };
    }

    // Case 3: Upstream changed -> commit new baseline on upstream branch
    const currentActiveHead = await revParse('refs/heads/active');
    const [oldUpstreamFiles, activeFiles] = await Promise.all([
      readTreeContents(oldUpstreamHead),
      readTreeContents(currentActiveHead),
    ]);

    const newUpstreamHead = await commitTree(
      nextUpstreamTree,
      [oldUpstreamHead],
      `Sync upstream skills (${meta.upstreamVersion}${meta.upstreamRevision ? ` @ ${meta.upstreamRevision.slice(0, 8)}` : ''})`,
    );
    await updateRef('refs/heads/upstream', newUpstreamHead, oldUpstreamHead);

    // Determine whether active has any customizations vs old upstream
    const withoutMeta = map => [...map.entries()]
      .filter(([path]) => path !== 'meta.json')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const activeMatchesOldUpstream = Object.keys(state.conflicts).length === 0 &&
      JSON.stringify(withoutMeta(activeFiles)) === JSON.stringify(withoutMeta(oldUpstreamFiles));

    if (activeMatchesOldUpstream) {
      let nextActiveHead;
      if (currentActiveHead === oldUpstreamHead) {
        await updateRef('refs/heads/active', newUpstreamHead, currentActiveHead);
        nextActiveHead = newUpstreamHead;
      } else {
        nextActiveHead = await commitTree(
          nextUpstreamTree,
          [currentActiveHead, newUpstreamHead],
          `Fast-forward active skills to upstream (${meta.upstreamVersion})`,
        );
        await updateRef('refs/heads/active', nextActiveHead, currentActiveHead);
      }
      await clearAllThumbs();
      await refreshCaches();
      return {
        action: 'fast-forward',
        upstreamRevision: newUpstreamHead,
        activeRevision: nextActiveHead,
        mergedDocs: [],
        fastForwardedDocs: [...sortedDocs.keys()],
        conflictedDocs: [],
      };
    }

    // Case 4: Real per-file 3-way merge without breaking live active branch
    const nextActiveFiles = new Map();
    nextActiveFiles.set('meta.json', nextUpstreamFiles.get('meta.json'));

    const nextConflicts = {};
    const mergedDocs = [];
    const fastForwardedDocs = [];
    const conflictedDocs = [];

    for (const [docId, theirs] of sortedDocs.entries()) {
      const path = `docs/${docId}`;
      const ours = activeFiles.get(path);
      const oldBase = oldUpstreamFiles.get(path);
      const prevConflict = state.conflicts[docId];

      if (ours === undefined) {
        nextActiveFiles.set(path, theirs);
        fastForwardedDocs.push(docId);
        continue;
      }

      const base = prevConflict ? prevConflict.base : (oldBase ?? theirs);
      if (ours === theirs) {
        nextActiveFiles.set(path, theirs);
        continue;
      }
      if (ours === base) {
        nextActiveFiles.set(path, theirs);
        fastForwardedDocs.push(docId);
        continue;
      }
      if (theirs === base) {
        nextActiveFiles.set(path, ours);
        continue;
      }

      // Genuine divergence: run real git merge-file 3-way merge
      const merged = await mergeFile3Way(ours, base, theirs);
      if (merged.clean) {
        nextActiveFiles.set(path, merged.content);
        mergedDocs.push(docId);
      } else {
        // Keep last known good active content untouched (zero production outage!)
        nextActiveFiles.set(path, ours);
        nextConflicts[docId] = {
          base,
          ours,
          theirs,
          mergedMarkers: merged.mergedMarkers,
          upstreamVersion: meta.upstreamVersion,
          upstreamRevision: meta.upstreamRevision,
          detectedAt: new Date().toISOString(),
        };
        conflictedDocs.push(docId);
      }
    }

    // Preserve runtime-created custom templates (and locally modified templates removed upstream) on active branch
    for (const [path, ours] of activeFiles.entries()) {
      if (!path.startsWith('docs/templates/')) continue;
      const docId = path.slice(5);
      if (sortedDocs.has(docId)) continue;
      const oldBase = oldUpstreamFiles.get(path);
      if (oldBase !== undefined && ours === oldBase) continue;
      nextActiveFiles.set(path, ours);
    }

    // Merge explainers: take upstream updates if active did not customize that explainer; keep customized/custom active explainers
    const oldUpManifest = parseManifestFromFiles(oldUpstreamFiles);
    const nextUpManifest = parseManifestFromFiles(nextUpstreamFiles);
    const actManifest = parseManifestFromFiles(activeFiles);
    const oldUpMap = new Map(oldUpManifest.map(entry => [entry.id, entry]));
    const actMap = new Map(actManifest.map(entry => [entry.id, entry]));

    const nextActiveExplainers = [];
    const handledExplainers = new Set();
    const changedThumbIds = [];

    for (const nextEntry of nextUpManifest) {
      const id = nextEntry.id;
      handledExplainers.add(id);
      const oldEntry = oldUpMap.get(id);
      const actEntry = actMap.get(id);
      const oldHtml = oldUpstreamFiles.get(`explainers/${id}.html`);
      const oldSrc = oldUpstreamFiles.get(`explainers/${id}.src.html`);
      const actHtml = activeFiles.get(`explainers/${id}.html`);
      const actSrc = activeFiles.get(`explainers/${id}.src.html`);
      const nextHtml = nextUpstreamFiles.get(`explainers/${id}.html`) ?? '';
      const nextSrc = nextUpstreamFiles.get(`explainers/${id}.src.html`) ?? nextHtml;

      const activeCustomized = Boolean(actEntry) && (
        !oldEntry ||
        JSON.stringify(actEntry) !== JSON.stringify(oldEntry) ||
        actHtml !== oldHtml ||
        actSrc !== oldSrc
      );

      if (!activeCustomized) {
        nextActiveExplainers.push(nextEntry);
        nextActiveFiles.set(`explainers/${id}.html`, nextHtml);
        nextActiveFiles.set(`explainers/${id}.src.html`, nextSrc);
        if (actHtml !== nextHtml) changedThumbIds.push(id);
      } else {
        nextActiveExplainers.push(actEntry);
        if (actHtml !== undefined) nextActiveFiles.set(`explainers/${id}.html`, actHtml);
        if (actSrc !== undefined) nextActiveFiles.set(`explainers/${id}.src.html`, actSrc);
      }
    }

    for (const actEntry of actManifest) {
      const id = actEntry.id;
      if (handledExplainers.has(id)) continue;
      const oldEntry = oldUpMap.get(id);
      const actHtml = activeFiles.get(`explainers/${id}.html`);
      const actSrc = activeFiles.get(`explainers/${id}.src.html`);
      if (oldEntry) {
        const oldHtml = oldUpstreamFiles.get(`explainers/${id}.html`);
        const oldSrc = oldUpstreamFiles.get(`explainers/${id}.src.html`);
        const activeCustomized = JSON.stringify(actEntry) !== JSON.stringify(oldEntry) || actHtml !== oldHtml || actSrc !== oldSrc;
        if (!activeCustomized) {
          changedThumbIds.push(id);
          continue; // Upstream removed it and active hadn't customized it
        }
      }
      nextActiveExplainers.push(actEntry);
      if (actHtml !== undefined) nextActiveFiles.set(`explainers/${id}.html`, actHtml);
      if (actSrc !== undefined) nextActiveFiles.set(`explainers/${id}.src.html`, actSrc);
    }

    nextActiveFiles.set('explainers/manifest.json', JSON.stringify({ explainers: nextActiveExplainers }, null, 2) + '\n');

    const nextActiveTree = await writeTreeFromFiles(nextActiveFiles);
    const currentActiveTree = (await git(['rev-parse', `${currentActiveHead}^{tree}`])).stdout.trim();
    let finalActiveHead = currentActiveHead;
    if (nextActiveTree !== currentActiveTree) {
      const parents = conflictedDocs.length === 0 ? [currentActiveHead, newUpstreamHead] : [currentActiveHead];
      const summaryParts = [];
      if (fastForwardedDocs.length) summaryParts.push(`${fastForwardedDocs.length} ff`);
      if (mergedDocs.length) summaryParts.push(`${mergedDocs.length} merged`);
      if (conflictedDocs.length) summaryParts.push(`${conflictedDocs.length} conflicts kept active`);
      const message = `Merge upstream skills (${meta.upstreamVersion}${summaryParts.length ? `: ${summaryParts.join(', ')}` : ''})`;
      finalActiveHead = await commitTree(nextActiveTree, parents, message);
      await updateRef('refs/heads/active', finalActiveHead, currentActiveHead);
    }

    const nextActiveTemplateSlugs = [];
    for (const path of nextActiveFiles.keys()) {
      if (!path.startsWith('docs/')) continue;
      const slug = templateSlugFromDocId(path.slice(5));
      if (slug) nextActiveTemplateSlugs.push(slug);
    }
    nextActiveTemplateSlugs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const nextDefaultTemplate = nextActiveTemplateSlugs.includes(state.defaultTemplate)
      ? state.defaultTemplate
      : (nextActiveTemplateSlugs.includes('default') ? 'default' : (nextActiveTemplateSlugs[0] ?? 'default'));

    await persistState({
      ...state,
      defaultTemplate: nextDefaultTemplate,
      conflicts: nextConflicts,
    });
    for (const id of changedThumbIds) await removeThumbFiles(id);
    await refreshCaches();

    return {
      action: 'merged',
      upstreamRevision: newUpstreamHead,
      activeRevision: finalActiveHead,
      mergedDocs,
      fastForwardedDocs,
      conflictedDocs,
    };
  }

  // Run initial baseline & upstream sync on creation
  const initialSync = await enqueue(() => syncUpstreamInternal({
    upstreamDocs,
    upstreamMeta,
    builtinDir,
    builtinExplainers,
  }));

  return {
    initialSync,
    docIdFromUri,
    validateDocId: requireManagedDoc,
    validateExplainerId,
    validateTemplateId,
    isEditEnabled() { return state.editEnabled; },
    defaultTemplate() { return resolveDefaultTemplateId(); },
    upstreamInfo() {
      return {
        version: currentUpstreamMeta.upstreamVersion,
        revision: currentUpstreamMeta.upstreamRevision,
        builtinHash: currentUpstreamMeta.builtinHash,
      };
    },
    hasDoc(docId) {
      return activeDocsMap.has(docId);
    },
    getEffectiveDoc(docId) {
      requireManagedDoc(docId);
      return activeDocsMap.get(docId);
    },
    getUpstreamDoc(docId) {
      requireManagedDoc(docId);
      return upstreamDocsMap.get(docId) ?? null;
    },
    expectedSkillHash(covers) {
      const normalized = normalizeCovers(covers);
      return expectedSkillHash(normalized);
    },
    verifyExplainerHash(explainerId, { covers, skillHash } = {}) {
      validateExplainerId(explainerId);
      const resolvedCovers = parseCoversInput(explainerId, covers);
      const expected = expectedSkillHash(resolvedCovers);
      const provided = typeof skillHash === 'string' ? skillHash.trim() : null;
      if (!provided || provided !== expected) {
        throw new ApiError(409, 'Explainer skillHash does not match current effective skill content', {
          expectedSkillHash: expected,
          providedSkillHash: provided,
          covers: resolvedCovers,
        });
      }
      return { expectedSkillHash: expected, covers: resolvedCovers };
    },
    listTemplates,
    listDocs() {
      return managedDocIdsSorted().map(formatDocSummary);
    },
    listExplainers() {
      return activeExplainers.map(formatExplainer);
    },
    getExplainer(explainerId) {
      validateExplainerId(explainerId);
      const entry = activeExplainers.find(item => item.id === explainerId);
      if (!entry) throw new ApiError(404, `Explainer not found: ${explainerId}`);
      return formatExplainer(entry);
    },
    getExplainerHtml(explainerId) {
      validateExplainerId(explainerId);
      const files = activeExplainerFiles.get(explainerId);
      if (!files) throw new ApiError(404, `Explainer not found: ${explainerId}`);
      return files.html;
    },
    getExplainerSource(explainerId) {
      validateExplainerId(explainerId);
      const files = activeExplainerFiles.get(explainerId);
      if (!files) throw new ApiError(404, `Explainer not found: ${explainerId}`);
      return files.sourceHtml;
    },
    conflicts() {
      const out = {};
      for (const [docId, entry] of Object.entries(state.conflicts)) {
        out[docId] = { ...entry };
      }
      return out;
    },
    overview() {
      const latest = latestVersionSummary();
      return {
        editEnabled: state.editEnabled,
        defaultTemplate: resolveDefaultTemplateId(),
        upstream: {
          version: currentUpstreamMeta.upstreamVersion,
          revision: currentUpstreamMeta.upstreamRevision,
        },
        templates: listTemplates(),
        docs: managedDocIdsSorted().map(formatDocSummary),
        explainers: activeExplainers.map(formatExplainer),
        conflicts: this.conflicts(),
        versionCount: activeHistoryCache.length,
        latestVersion: latest,
        keysCount: state.keys.length,
      };
    },
    async diffDoc(docId) {
      requireManagedDoc(docId);
      const res = await git(['diff', 'refs/heads/upstream..refs/heads/active', '--', `docs/${docId}`]);
      return res.stdout;
    },
    async getDoc(docId) {
      const summary = formatDocSummary(docId);
      const content = activeDocsMap.get(docId);
      const upstreamContent = upstreamDocsMap.get(docId) ?? null;
      const diff = await this.diffDoc(docId);
      const conflict = state.conflicts[docId] ? { ...state.conflicts[docId] } : null;
      return {
        ...summary,
        content,
        upstreamContent,
        diff,
        conflict,
      };
    },
    versions(docId = null) {
      let list = activeHistoryCache;
      if (docId !== null && docId !== undefined && docId !== '') {
        requireManagedDoc(docId);
        const target = `docs/${docId}`;
        list = list.filter(entry => entry.files.includes(target));
      }
      return [...list].reverse().map(entry => ({ ...entry, files: [...entry.files] }));
    },
    async versionDiff(revOrVersion) {
      const target = resolveHistoryEntry(revOrVersion);
      const diff = (await git([
        'show', '--first-parent', '--diff-merges=first-parent', '--root', '--format=', '--patch', target.revision,
      ])).stdout;
      return {
        version: target.version,
        label: target.label,
        revision: target.revision,
        date: target.date,
        message: target.message,
        files: [...target.files],
        diff,
      };
    },
    async setEditEnabled(enabled) {
      return enqueue(async () => {
        if (typeof enabled !== 'boolean') throw new ApiError(400, 'editEnabled must be a boolean');
        if (state.editEnabled === enabled) return state.editEnabled;
        await persistState({ ...state, editEnabled: enabled });
        return state.editEnabled;
      });
    },
    listKeys() {
      return state.keys.map(publicKeyMetadata);
    },
    async createKey({ name, createdBy = 'Owner' } = {}) {
      return enqueue(async () => {
        const cleanName = cleanKeyName(name);
        const creator = cleanSingleLine(createdBy, 'createdBy', 80, 'Owner');
        let id;
        do { id = `sk_${randomBytes(8).toString('hex')}`; } while (state.keys.some(entry => entry.id === id));
        const secret = `ve_sk_${randomBytes(32).toString('base64url')}`;
        const entry = {
          id,
          name: cleanName,
          prefix: secret.slice(0, 12),
          hash: sha256Hex(secret),
          createdAt: new Date().toISOString(),
          createdBy: creator,
          lastUsedAt: null,
        };
        await persistState({ ...state, keys: [...state.keys, entry] });
        return { key: publicKeyMetadata(entry), secret };
      });
    },
    async revokeKey(id) {
      return enqueue(async () => {
        if (typeof id !== 'string' || !SKILL_KEY_ID_RE.test(id)) throw new ApiError(404, 'Skill key not found');
        if (!state.keys.some(entry => entry.id === id)) throw new ApiError(404, 'Skill key not found');
        await persistState({ ...state, keys: state.keys.filter(entry => entry.id !== id) });
      });
    },
    authenticateKey(secret) {
      if (typeof secret !== 'string' || !SKILL_KEY_SECRET_RE.test(secret)) return null;
      const hash = Buffer.from(sha256Hex(secret), 'hex');
      let matched = null;
      for (const entry of state.keys) {
        if (timingSafeEqual(hash, Buffer.from(entry.hash, 'hex'))) {
          matched = entry;
        }
      }
      if (!matched) return null;
      const now = new Date().toISOString();
      const prevUsed = matched.lastUsedAt;
      matched.lastUsedAt = now;
      // Persist lastUsedAt asynchronously in queue if first use or > 60s old
      if (!prevUsed || (Date.parse(now) - Date.parse(prevUsed)) >= 60000) {
        const matchedId = matched.id;
        void enqueue(async () => {
          if (!state.keys.some(entry => entry.id === matchedId)) return;
          const nextKeys = state.keys.map(entry => entry.id === matchedId ? { ...entry, lastUsedAt: now } : entry);
          await persistState({ ...state, keys: nextKeys });
        }).catch(() => {});
      }
      return { role: 'skill-editor', keyId: matched.id, name: matched.name, bearer: true };
    },
    async updateDoc(docId, content, { note = '', actor = 'Owner' } = {}) {
      return enqueue(async () => {
        requireManagedDoc(docId);
        if (typeof content !== 'string' || !content.isWellFormed()) {
          throw new ApiError(400, 'Skill document content must be a valid UTF-8 string');
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) {
          throw new ApiError(413, 'Skill document exceeds 2 MiB limit');
        }
        const cleanNote = cleanNoteText(note);
        const cleanActor = cleanSingleLine(actor, 'actor', 80, 'Owner');
        const nextFiles = new Map(activeFilesCache);
        const previousContent = nextFiles.get(`docs/${docId}`);
        nextFiles.set(`docs/${docId}`, content);

        const hadConflict = Boolean(state.conflicts[docId]);
        if (hadConflict) {
          const nextConflicts = { ...state.conflicts };
          delete nextConflicts[docId];
          await persistState({ ...state, conflicts: nextConflicts });
        }

        if (previousContent !== content) {
          const currentHead = await revParse('refs/heads/active');
          const nextTree = await writeTreeFromFiles(nextFiles);
          const msg = `Update ${docId}${cleanNote ? `: ${cleanNote}` : ''} (by ${cleanActor})`;
          const nextHead = await commitTree(nextTree, [currentHead], msg);
          await updateRef('refs/heads/active', nextHead, currentHead);
          await refreshCaches();
        } else if (hadConflict) {
          // Even when resolving a conflict by accepting active content, record an explicit resolution commit.
          const currentHead = await revParse('refs/heads/active');
          const currentTree = (await git(['rev-parse', `${currentHead}^{tree}`])).stdout.trim();
          const msg = `Resolve conflict on ${docId}${cleanNote ? `: ${cleanNote}` : ''} (by ${cleanActor})`;
          const nextHead = await commitTree(currentTree, [currentHead], msg);
          await updateRef('refs/heads/active', nextHead, currentHead);
          await refreshCaches();
        }

        const affectedExplainers = activeExplainers
          .filter(entry => (entry.covers.length === 1 && entry.covers[0] === '*') || entry.covers.includes(docId))
          .map(formatExplainer)
          .filter(entry => !entry.synced)
          .map(({ id, title, covers, skillHash, expectedSkillHash: expected, synced }) => ({
            id, title, covers, skillHash, expectedSkillHash: expected, synced,
          }));

        return {
          doc: formatDocSummary(docId),
          version: latestVersionSummary(),
          skillHash: sha256Hex(content),
          affectedExplainers,
        };
      });
    },
    async updateExplainer(explainerId, {
      html,
      sourceHtml,
      title,
      summary,
      layer,
      parentId,
      covers,
      skillHash,
      note = '',
      actor = 'Owner',
    } = {}) {
      return enqueue(async () => {
        validateExplainerId(explainerId);
        if (typeof html !== 'string' || !html.length) throw new ApiError(400, 'Rendered explainer html is required');
        const src = typeof sourceHtml === 'string' && sourceHtml.length ? sourceHtml : html;
        const resolvedCovers = parseCoversInput(explainerId, covers);
        const expected = expectedSkillHash(resolvedCovers);
        const provided = typeof skillHash === 'string' ? skillHash.trim() : null;
        if (!provided || provided !== expected) {
          throw new ApiError(409, 'Explainer skillHash does not match current effective skill content', {
            expectedSkillHash: expected,
            providedSkillHash: provided,
            covers: resolvedCovers,
          });
        }

        const existing = activeExplainers.find(item => item.id === explainerId);
        const cleanNote = cleanNoteText(note);
        const cleanActor = cleanSingleLine(actor, 'actor', 80, 'Owner');
        const now = new Date().toISOString();
        const nextEntry = {
          id: explainerId,
          title: cleanSingleLine(title, 'title', MAX_TITLE_LEN, existing?.title ?? explainerId),
          summary: cleanSingleLine(summary, 'summary', MAX_SUMMARY_LEN, existing?.summary ?? ''),
          layer: cleanLayer(layer, existing?.layer ?? (resolvedCovers.length === 1 && resolvedCovers[0] === '*' ? 0 : (explainerId.includes('/') ? 2 : 1))),
          parentId: parentId !== undefined ? cleanParentId(parentId, explainerId) : (existing?.parentId ?? null),
          covers: resolvedCovers,
          skillHash: expected,
          updatedAt: now,
        };

        const nextExplainers = existing
          ? activeExplainers.map(item => (item.id === explainerId ? nextEntry : item))
          : [...activeExplainers, nextEntry];

        const nextFiles = new Map(activeFilesCache);
        nextFiles.set(`explainers/${explainerId}.html`, html);
        nextFiles.set(`explainers/${explainerId}.src.html`, src);
        nextFiles.set('explainers/manifest.json', JSON.stringify({ explainers: nextExplainers }, null, 2) + '\n');

        const currentHead = await revParse('refs/heads/active');
        const nextTree = await writeTreeFromFiles(nextFiles);
        const msg = `Update explainer ${explainerId}${cleanNote ? `: ${cleanNote}` : ''} (by ${cleanActor})`;
        const nextHead = await commitTree(nextTree, [currentHead], msg);
        await updateRef('refs/heads/active', nextHead, currentHead);
        await refreshCaches();

        return {
          explainer: formatExplainer(nextEntry),
          version: latestVersionSummary(),
          synced: true,
        };
      });
    },
    async createTemplate(slug, content, { note = '', actor = 'Owner' } = {}) {
      return enqueue(async () => {
        validateTemplateId(slug);
        if (typeof content !== 'string' || !content.isWellFormed() || !content.trim()) {
          throw new ApiError(400, 'Template content must be a non-empty UTF-8 string');
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) {
          throw new ApiError(413, 'Template document exceeds 2 MiB limit');
        }
        const docId = `templates/${slug}.md`;
        if (activeDocsMap.has(docId)) {
          throw new ApiError(409, `Template already exists: ${slug}`);
        }
        const cleanNote = cleanNoteText(note);
        const cleanActor = cleanSingleLine(actor, 'actor', 80, 'Owner');
        const nextFiles = new Map(activeFilesCache);
        nextFiles.set(`docs/${docId}`, content);

        const currentHead = await revParse('refs/heads/active');
        const nextTree = await writeTreeFromFiles(nextFiles);
        const msg = `Create template ${slug}${cleanNote ? `: ${cleanNote}` : ''} (by ${cleanActor})`;
        const nextHead = await commitTree(nextTree, [currentHead], msg);
        await updateRef('refs/heads/active', nextHead, currentHead);
        await refreshCaches();

        const affectedExplainers = activeExplainers
          .filter(entry => entry.covers.length === 1 && entry.covers[0] === '*')
          .map(formatExplainer)
          .filter(entry => !entry.synced)
          .map(({ id, title, covers, skillHash, expectedSkillHash: expected, synced }) => ({
            id, title, covers, skillHash, expectedSkillHash: expected, synced,
          }));

        return {
          template: formatTemplateSummary(slug),
          doc: formatDocSummary(docId),
          version: latestVersionSummary(),
          skillHash: sha256Hex(content),
          affectedExplainers,
        };
      });
    },
    async deleteTemplate(slug, { note = '', actor = 'Owner' } = {}) {
      return enqueue(async () => {
        validateTemplateId(slug);
        const docId = `templates/${slug}.md`;
        if (!activeDocsMap.has(docId)) {
          throw new ApiError(404, `Template not found: ${slug}`);
        }
        if (upstreamDocsMap.has(docId)) {
          throw new ApiError(409, 'Cannot delete built-in template; reset to upstream instead');
        }
        if (resolveDefaultTemplateId() === slug) {
          throw new ApiError(409, 'Set another default template before deleting');
        }
        const cleanNote = cleanNoteText(note);
        const cleanActor = cleanSingleLine(actor, 'actor', 80, 'Owner');
        const nextFiles = new Map(activeFilesCache);
        nextFiles.delete(`docs/${docId}`);

        const dedicatedId = `templates/${slug}`;
        const deletedExplainerIds = [];
        const nextExplainers = [];
        let manifestChanged = false;
        for (const entry of activeExplainers) {
          const isDedicated = entry.id === dedicatedId || (entry.covers.length === 1 && entry.covers[0] === docId);
          if (isDedicated) {
            deletedExplainerIds.push(entry.id);
            nextFiles.delete(`explainers/${entry.id}.html`);
            nextFiles.delete(`explainers/${entry.id}.src.html`);
            manifestChanged = true;
            continue;
          }
          if (!(entry.covers.length === 1 && entry.covers[0] === '*') && entry.covers.includes(docId)) {
            const remaining = entry.covers.filter(item => item !== docId);
            if (!remaining.length) {
              deletedExplainerIds.push(entry.id);
              nextFiles.delete(`explainers/${entry.id}.html`);
              nextFiles.delete(`explainers/${entry.id}.src.html`);
            } else {
              nextExplainers.push({ ...entry, covers: remaining });
            }
            manifestChanged = true;
            continue;
          }
          nextExplainers.push(entry);
        }
        if (manifestChanged) {
          nextFiles.set('explainers/manifest.json', JSON.stringify({ explainers: nextExplainers }, null, 2) + '\n');
        }

        if (state.conflicts[docId]) {
          const nextConflicts = { ...state.conflicts };
          delete nextConflicts[docId];
          await persistState({ ...state, conflicts: nextConflicts });
        }

        const currentHead = await revParse('refs/heads/active');
        const nextTree = await writeTreeFromFiles(nextFiles);
        const msg = `Delete template ${slug}${cleanNote ? `: ${cleanNote}` : ''} (by ${cleanActor})`;
        const nextHead = await commitTree(nextTree, [currentHead], msg);
        await updateRef('refs/heads/active', nextHead, currentHead);
        for (const expId of deletedExplainerIds) await removeThumbFiles(expId);
        await refreshCaches();

        return {
          deleted: true,
          id: slug,
          docId,
          deletedExplainerIds,
          version: latestVersionSummary(),
          defaultTemplate: resolveDefaultTemplateId(),
          templates: listTemplates(),
        };
      });
    },
    async setDefaultTemplate(slug) {
      return enqueue(async () => {
        validateTemplateId(slug);
        const docId = `templates/${slug}.md`;
        if (!activeDocsMap.has(docId)) {
          throw new ApiError(404, `Template not found: ${slug}`);
        }
        if (state.defaultTemplate !== slug) {
          await persistState({ ...state, defaultTemplate: slug });
        }
        return {
          defaultTemplate: resolveDefaultTemplateId(),
          template: formatTemplateSummary(slug),
          templates: listTemplates(),
        };
      });
    },
    async resetDoc(docId, { note = '', actor = 'Owner' } = {}) {
      return enqueue(async () => {
        requireManagedDoc(docId);
        if (!upstreamDocsMap.has(docId)) {
          throw new ApiError(409, 'Cannot reset custom template; it has no upstream version');
        }
        const cleanNote = cleanNoteText(note);
        const cleanActor = cleanSingleLine(actor, 'actor', 80, 'Owner');
        const upstreamContent = upstreamDocsMap.get(docId);
        const upstreamSha = sha256Hex(upstreamContent);

        const nextFiles = new Map(activeFilesCache);
        let changed = nextFiles.get(`docs/${docId}`) !== upstreamContent;
        nextFiles.set(`docs/${docId}`, upstreamContent);

        // If a matching built-in explainer on upstream covers only [docId] and its hash matches upstream, restore it too!
        let resetExplainerId = null;
        const upExplainer = upstreamExplainers.find(entry => entry.covers.length === 1 && entry.covers[0] === docId && entry.skillHash === upstreamSha);
        if (upExplainer) {
          const upFiles = upstreamExplainerFiles.get(upExplainer.id);
          if (upFiles) {
            const existsInActive = activeExplainers.some(entry => entry.id === upExplainer.id);
            const nextExplainers = existsInActive
              ? activeExplainers.map(entry => (entry.id === upExplainer.id ? { ...upExplainer } : entry))
              : [...activeExplainers, { ...upExplainer }];
            const manifestJson = JSON.stringify({ explainers: nextExplainers }, null, 2) + '\n';
            if (nextFiles.get(`explainers/${upExplainer.id}.html`) !== upFiles.html ||
                nextFiles.get(`explainers/${upExplainer.id}.src.html`) !== upFiles.sourceHtml ||
                nextFiles.get('explainers/manifest.json') !== manifestJson) {
              changed = true;
            }
            nextFiles.set(`explainers/${upExplainer.id}.html`, upFiles.html);
            nextFiles.set(`explainers/${upExplainer.id}.src.html`, upFiles.sourceHtml);
            nextFiles.set('explainers/manifest.json', manifestJson);
            resetExplainerId = upExplainer.id;
          }
        }

        const hadConflict = Boolean(state.conflicts[docId]);
        if (hadConflict) {
          const nextConflicts = { ...state.conflicts };
          delete nextConflicts[docId];
          await persistState({ ...state, conflicts: nextConflicts });
        }

        if (changed || hadConflict) {
          const currentHead = await revParse('refs/heads/active');
          const nextTree = await writeTreeFromFiles(nextFiles);
          const msg = `Reset ${docId} to upstream${cleanNote ? `: ${cleanNote}` : ''} (by ${cleanActor})`;
          const nextHead = await commitTree(nextTree, [currentHead], msg);
          await updateRef('refs/heads/active', nextHead, currentHead);
          if (resetExplainerId) await removeThumbFiles(resetExplainerId);
          await refreshCaches();
        }

        return {
          doc: formatDocSummary(docId),
          version: latestVersionSummary(),
          resetExplainerId,
        };
      });
    },
    async rollback(versionOrRev, { note = '', actor = 'Owner' } = {}) {
      return enqueue(async () => {
        const target = resolveHistoryEntry(versionOrRev);
        const cleanNote = cleanNoteText(note);
        const cleanActor = cleanSingleLine(actor, 'actor', 80, 'Owner');
        const targetFiles = await readTreeContents(target.revision);
        const nextFiles = new Map();
        // Preserve current upstream meta.json while restoring BOTH docs/ and explainers/ in lockstep
        const currentMeta = activeFilesCache.get('meta.json');
        if (currentMeta !== undefined) nextFiles.set('meta.json', currentMeta);
        for (const [path, content] of targetFiles.entries()) {
          if (path.startsWith('docs/') || path.startsWith('explainers/')) {
            nextFiles.set(path, content);
          }
        }
        // Keep any newly-added upstream docs that did not exist in the historical commit so registry remains complete
        for (const [docId, upContent] of upstreamDocsMap.entries()) {
          if (!nextFiles.has(`docs/${docId}`)) nextFiles.set(`docs/${docId}`, upContent);
        }
        if (!nextFiles.has('explainers/manifest.json')) {
          nextFiles.set('explainers/manifest.json', JSON.stringify({ explainers: [] }, null, 2) + '\n');
        }

        const currentHead = await revParse('refs/heads/active');
        const nextTree = await writeTreeFromFiles(nextFiles);
        const msg = `Rollback skills to ${target.label}${cleanNote ? `: ${cleanNote}` : ''} (by ${cleanActor})`;
        const nextHead = await commitTree(nextTree, [currentHead], msg);
        await updateRef('refs/heads/active', nextHead, currentHead);

        // Clear any conflicts whose restored doc now matches upstream or no longer exists,
        // and safely reset defaultTemplate if the previous default does not exist in this snapshot.
        let stateChanged = false;
        const nextConflicts = { ...state.conflicts };
        for (const docId of Object.keys(nextConflicts)) {
          if (!nextFiles.has(`docs/${docId}`) || nextFiles.get(`docs/${docId}`) === upstreamDocsMap.get(docId)) {
            delete nextConflicts[docId];
            stateChanged = true;
          }
        }
        const restoredTemplateSlugs = [];
        for (const path of nextFiles.keys()) {
          if (!path.startsWith('docs/')) continue;
          const slug = templateSlugFromDocId(path.slice(5));
          if (slug) restoredTemplateSlugs.push(slug);
        }
        restoredTemplateSlugs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        let nextDefaultTemplate = state.defaultTemplate;
        if (!restoredTemplateSlugs.includes(nextDefaultTemplate)) {
          nextDefaultTemplate = restoredTemplateSlugs.includes('default')
            ? 'default'
            : (restoredTemplateSlugs[0] ?? 'default');
          if (nextDefaultTemplate !== state.defaultTemplate) stateChanged = true;
        }
        if (stateChanged) {
          await persistState({ ...state, defaultTemplate: nextDefaultTemplate, conflicts: nextConflicts });
        }

        await clearAllThumbs();
        await refreshCaches();

        return {
          version: latestVersionSummary(),
          rolledBackTo: { version: target.version, label: target.label, revision: target.revision },
          defaultTemplate: resolveDefaultTemplateId(),
          templates: listTemplates(),
          docs: managedDocIdsSorted().map(formatDocSummary),
          explainers: activeExplainers.map(formatExplainer),
        };
      });
    },
    async syncUpstream(options) {
      return enqueue(() => syncUpstreamInternal(options));
    },
    async saveThumbs(explainerId, lightPng, darkPng) {
      validateExplainerId(explainerId);
      await ensureThumbsDir();
      if (lightPng) await writeAtomicBytes(thumbFilePath(explainerId, 'light'), lightPng, 'Skill light thumb');
      if (darkPng) await writeAtomicBytes(thumbFilePath(explainerId, 'dark'), darkPng, 'Skill dark thumb');
    },
    async readThumb(explainerId, theme = 'light') {
      validateExplainerId(explainerId);
      let handle;
      try {
        handle = await open(thumbFilePath(explainerId, theme), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (!(await handle.stat()).isFile()) return null;
        return await handle.readFile();
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        if (error.code === 'ELOOP') throw new ApiError(409, 'Skill thumbnail must not be a symlink');
        throw error;
      } finally {
        await handle?.close();
      }
    },
    removeThumbs: removeThumbFiles,
    clearAllThumbs,
  };
}
