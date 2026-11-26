import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { ApiError, entityId, logicalPath, pageFilename, scopePath, sourceFilename, sourcePairs } from './catalog.mjs';

const execute = promisify(execFile);
const author = 'Visual Explainer';
const email = 'visual-explainer@localhost';
const managed = name => name === '.entities.json' || (!name.includes('/') && /\.html?$/i.test(name));
const source = name => /\.src\.html?$/i.test(name);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function exists(path) {
  return lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

// Callers serialize snapshot with the catalog's existing mutation queue.
// A private index built from regular-file blobs never reads the user's index,
// applies clean filters, or includes any unrelated staged files.
export async function createHistory(outputDir, catalog) {
  const gitDir = join(outputDir, '.git');
  let phase = 'initialize';
  const remote = process.env.GIT_HISTORY_REMOTE || null;
  const key = process.env.GIT_HISTORY_SSH_KEY || null;
  const knownHosts = process.env.GIT_HISTORY_KNOWN_HOSTS || null;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: email,
  });
  const config = [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.ssh.allow=always',
    '-c', 'protocol.file.allow=always',
  ];

  function unavailable(error) {
    // Git stderr can contain credentials, file contents, or remote hook output.
    // Log only operational metadata, never the child process's raw error.
    console.error('Page Git history failed', {
      phase,
      code: typeof error.code === 'number' || /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : undefined,
      signal: error.signal,
      timedOut: error.killed === true,
    });
    return new ApiError(503, phase === 'push'
      ? 'Content may already be saved. Git push failed; local commits are preserved. Retry the operation to publish pending history.'
      : 'Content may already be saved, but Git history could not be recorded. Existing local commits are preserved.');
  }

  async function git(args, { input, index, allowed = [0], timeout = 30000 } = {}) {
    const pending = execute('git', [`--git-dir=${gitDir}`, ...config, ...args], {
      cwd: outputDir,
      env: index ? { ...env, GIT_INDEX_FILE: index } : env,
      shell: false,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
    pending.child.stdin.on('error', () => {}); // Early child exit is reported by execFile.
    pending.child.stdin.end(input);
    try {
      const result = await pending;
      return { code: 0, stdout: result.stdout };
    } catch (error) {
      if (allowed.includes(error.code)) return { code: error.code, stdout: error.stdout };
      throw error;
    }
  }

  async function credentialPath(path) {
    if (!isAbsolute(path)) throw new Error('SSH credential paths must be absolute');
    const status = await lstat(path);
    const actual = await realpath(path);
    const inside = relative(outputDir, actual);
    if (!status.isFile() || status.isSymbolicLink() || inside === '' ||
        (inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside))) {
      throw new Error('SSH credentials must be regular files outside the page directory');
    }
    return actual;
  }

  async function localMetadata(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Page Git metadata must not contain symlinks');
      if (entry.isDirectory()) await localMetadata(join(directory, entry.name));
    }
  }

  try {
    if (Boolean(key) !== Boolean(knownHosts)) throw new Error('Both SSH credential paths are required');
    if (remote && !isAbsolute(remote) && !/^git@[a-zA-Z0-9.-]+:[^\s]+$/.test(remote) && !/^ssh:\/\/git@[a-zA-Z0-9.-]+(?::\d+)?\/[^\s]+$/.test(remote)) {
      throw new Error('History remote must be an absolute local path or a credential-free Git SSH URL');
    }
    if (remote && !isAbsolute(remote) && !key) throw new Error('SSH history requires a dedicated key and known hosts file');
    // Set this even for local-only history, so repository config cannot supply an SSH command.
    env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ConnectionAttempts=1';
    env.GIT_SSH_VARIANT = 'ssh';
    if (key) {
      const identity = await credentialPath(key);
      const hosts = await credentialPath(knownHosts);
      env.GIT_SSH_COMMAND += ` -i ${quote(identity)} -o ${quote(`UserKnownHostsFile=${hosts}`)} -o GlobalKnownHostsFile=/dev/null`;
    }

    const status = await exists(gitDir);
    if (status && (!status.isDirectory() || status.isSymbolicLink() || await realpath(gitDir) !== gitDir)) {
      throw new Error('Page Git metadata must be a local directory, not a symlink or worktree pointer');
    }
    if (status) await localMetadata(gitDir);
    if (await exists(join(gitDir, 'objects/info/alternates')) || await exists(join(gitDir, 'commondir'))) {
      throw new Error('Page Git repository must not share external metadata or objects');
    }
    if (!status) await git(['init', '--bare', '--initial-branch=main', '--template=', gitDir]);
    const actualGitDir = (await git(['rev-parse', '--absolute-git-dir'])).stdout.trimEnd();
    const common = (await git(['rev-parse', '--git-common-dir'])).stdout.trimEnd();
    if (actualGitDir !== gitDir || resolve(outputDir, common) !== gitDir) {
      throw new Error('Page Git repository must be rooted exactly at the output directory');
    }
    const bare = (await git(['rev-parse', '--is-bare-repository'])).stdout.trim() === 'true';
    const worktree = await git(['config', '--get', 'core.worktree'], { allowed: [0, 1] });
    if ((worktree.code === 0 && resolve(gitDir, worktree.stdout.trimEnd()) !== outputDir) ||
        (!bare && (await git(['rev-parse', '--show-toplevel'])).stdout.trimEnd() !== outputDir)) {
      throw new Error('Page Git worktree must not point outside the output directory');
    }
    if ((await git(['symbolic-ref', 'HEAD'])).stdout.trimEnd() !== 'refs/heads/main') {
      throw new Error('Page Git history must use the main branch');
    }
    const current = await git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { allowed: [0, 1] });
    if (current.code === 0) {
      const tracked = (await git(['ls-tree', '-rz', '--full-tree', current.stdout.trim()])).stdout;
      for (const entry of tracked.split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t'), header = entry.slice(0, tab), name = entry.slice(tab + 1);
        if (!/^100(?:644|755) blob [0-9a-f]+$/.test(header)) throw new Error('Existing page history must contain only regular files');
        if (name === '.entities.json' || managed(name)) continue;
        const [root, ...parts] = name.split('/');
        if (root !== '_unassigned') entityId(root);
        if (!parts.length) throw new Error('Invalid projected history path');
        const leaf = parts.at(-1);
        if (leaf === '.gitkeep') {
          if (parts.length > 1) logicalPath(parts.slice(0, -1).join('/'));
          const empty = (await git(['hash-object', '--stdin'], { input: '' })).stdout.trim();
          if (header !== `100644 blob ${empty}`) throw new Error('Directory markers must be empty regular files');
        } else if (parts.length !== 1 || !managed(leaf)) {
          const logical = parts.join('/').replace(/\.src(\.html?)$/i, '$1');
          logicalPath(logical, true);
        }
      }
    }
    // Convert in place: retain all objects, refs, reflogs and the user's index.
    // No Git command may interpret the flat serving directory as this tree's worktree.
    await git(['config', 'core.bare', 'true']);
    if (worktree.code === 0) await git(['config', '--unset-all', 'core.worktree']);
  } catch (error) {
    throw unavailable(error);
  }

  const records = new Map();
  async function record(revision) {
    if (records.has(revision)) return records.get(revision);
    const tree = new Map();
    for (const entry of (await git(['ls-tree', '-rz', '--full-tree', revision])).stdout.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t'), match = entry.slice(0, tab).match(/^100(?:644|755) blob ([0-9a-f]+)$/);
      if (match) tree.set(entry.slice(tab + 1), match[1]);
    }
    let metadata = null;
    if (tree.has('.entities.json')) {
      metadata = JSON.parse((await git(['cat-file', 'blob', tree.get('.entities.json')])).stdout);
      if (![1, 2, 3].includes(metadata?.version) || !metadata.pages || typeof metadata.pages !== 'object') throw new Error('Invalid historical catalog');
    }
    const info = (await git(['show', '-s', '--format=%P%x00%cI%x00%s', revision])).stdout.trimEnd().split('\0');
    const result = { tree, metadata, parent: info[0].split(' ')[0] || null, createdAt: info[1], message: info.slice(2).join('\0') };
    // Bound retained metadata, not the available history.
    if (records.size >= 256) records.delete(records.keys().next().value);
    records.set(revision, result);
    return result;
  }
  const fingerprint = version => JSON.stringify([version.path, version.entityId, version.blob, version.sourceBlob, version.ancestry]);

  async function locate(filename, revision) {
    pageFilename(filename);
    const saved = await record(revision), value = saved.metadata?.pages?.[filename];
    let entity = null, path = filename;
    if (value !== undefined) {
      entity = saved.metadata.version === 1 ? value : value.entityId;
      path = saved.metadata.version === 1 ? filename.normalize('NFC') : value.path;
      if (entity !== null) entityId(entity);
      if (entity === null && path === filename) pageFilename(path);
      else logicalPath(path, true);
    }
    const projected = `${entity ?? '_unassigned'}/${saved.metadata?.version === 1 ? filename : path}`;
    // Stable physical identity comes from this revision's catalog, never a
    // current logical path which could have belonged to a different page.
    const storedPath = saved.tree.has(projected) ? projected : saved.tree.has(filename) ? filename : null;
    if (!storedPath) throw new ApiError(404, 'Page version not found');
    const sourcePath = sourcePairs([...saved.tree.keys()]).get(storedPath)?.[0] ?? sourceFilename(storedPath);
    const ancestry = [];
    let anchor = saved.metadata?.entities.find(entry => entry.id === entity);
    while (anchor?.parent) {
      if (ancestry.some(entry => entry[0] === anchor.id)) throw new Error('Invalid historical hierarchy');
      ancestry.push([anchor.id, anchor.parent.entityId, anchor.parent.path, anchor.name]);
      anchor = saved.metadata.entities.find(entry => entry.id === anchor.parent.entityId);
    }
    return {
      revision, createdAt: saved.createdAt, message: saved.message, path, entityId: entity, ancestry,
      sourceAvailable: saved.tree.has(sourcePath), storedPath,
      blob: saved.tree.get(storedPath), sourceBlob: saved.tree.get(sourcePath) ?? null,
    };
  }

  async function reachable(revision) {
    if (typeof revision !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) throw new ApiError(400, 'Expected a full commit revision');
    const type = await git(['cat-file', '-t', revision], { allowed: [0, 128] });
    if (type.code !== 0 || type.stdout.trim() !== 'commit' ||
        (await git(['merge-base', '--is-ancestor', revision, 'refs/heads/main'], { allowed: [0, 1, 128] })).code !== 0) {
      throw new ApiError(404, 'Revision not found');
    }
  }
  const publicVersion = ({ storedPath, blob, sourceBlob, ancestry, ...version }) => version;
  function extractNote(message) {
    if (typeof message !== 'string') return '';
    const match = message.match(/^(?:Publish|Restore) page [^:]+:\s*(.+)$/);
    return match ? match[1].trim() : '';
  }
  async function historicalScope(scope, version) {
    const saved = await record(version.revision);
    return scopePath(saved.metadata?.entities ?? [], scope, version.entityId) !== null;
  }

  async function allSnapshots(filename) {
    const revisions = (await git(['rev-list', 'refs/heads/main'])).stdout.trim().split('\n').filter(Boolean);
    const snapshots = [];
    let previous = null;
    let number = 0;
    // Walk oldest first to attribute a snapshot to the commit which changed
    // this identity, not the newest unrelated catalog mutation.
    for (const revision of revisions.reverse()) {
      let version;
      try { version = await locate(filename, revision); }
      catch (error) { if (error instanceof ApiError && error.status === 404) { previous = null; continue; } throw error; }
      const current = fingerprint(version);
      if (current !== previous) {
        number += 1;
        snapshots.push({ ...version, version: number, label: `v${number}`, note: extractNote(version.message) });
      }
      previous = current;
    }
    return snapshots;
  }

  return {
    async versions(filename, entity = undefined) {
      try {
        phase = 'read';
        const snapshots = await allSnapshots(filename);
        const visible = [];
        for (const version of snapshots) {
          if (entity === undefined || await historicalScope(entity, version)) visible.push(publicVersion(version));
        }
        return visible.reverse().slice(0, 50);
      } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(error); }
    },
    async latestVersion(filename) {
      try {
        phase = 'read';
        const snapshots = await allSnapshots(filename);
        const latest = snapshots.at(-1);
        return latest ? publicVersion(latest) : null;
      } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(error); }
    },
    async version(filename, revisionOrVersion, entity = undefined) {
      try {
        phase = 'read';
        let revision = revisionOrVersion;
        let numbered = null;
        const versionMatch = typeof revisionOrVersion === 'number'
          ? [null, String(revisionOrVersion)]
          : typeof revisionOrVersion === 'string' ? revisionOrVersion.trim().match(/^v?(\d+)$/i) : null;
        if (versionMatch) {
          const target = Number(versionMatch[1]);
          if (!Number.isInteger(target) || target < 1) throw new ApiError(400, 'Expected a valid version number or full commit revision');
          const snapshots = await allSnapshots(filename);
          const found = snapshots.find(item => item.version === target);
          if (!found) throw new ApiError(404, `Version v${target} not found`);
          revision = found.revision;
          numbered = found;
        }
        await reachable(revision);
        const version = numbered ?? await locate(filename, revision);
        if (entity !== undefined && !await historicalScope(entity, version)) throw new ApiError(403, 'Version is outside folder scope');
        if (!numbered) {
          const parent = (await record(revision)).parent;
          if (parent) {
            let previous;
            try { previous = await locate(filename, parent); }
            catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
            if (previous && fingerprint(previous) === fingerprint(version)) throw new ApiError(404, 'Page did not change in this revision');
          }
          const snapshots = await allSnapshots(filename);
          const match = snapshots.find(item => item.revision === revision);
          if (match) {
            version.version = match.version;
            version.label = match.label;
            version.note = match.note;
          } else {
            version.note = extractNote(version.message);
          }
        }
        return {
          version: publicVersion(version),
          html: (await git(['cat-file', 'blob', version.sourceBlob ?? version.blob])).stdout,
          rendered: (await git(['cat-file', 'blob', version.blob])).stdout,
        };
      } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(error); }
    },
    async snapshot(message) {
      let temporary;
      try {
        phase = 'snapshot';
        temporary = await mkdtemp(join(tmpdir(), 've-history-'));
        const index = join(temporary, 'index');
        await git(['read-tree', '--empty'], { index });
        const entries = [], paths = new Set();
        const folders = new Set(['_unassigned', ...catalog.entities().map(entity => entity.id)]);
        for (const entity of catalog.entities()) for (const folder of catalog.folders(entity.id)) folders.add(`${entity.id}/${folder.path}`);
        const filenames = (await readdir(outputDir, { withFileTypes: true }))
          .filter(entry => entry.isFile() && managed(entry.name)).map(entry => entry.name).sort();
        const pairs = sourcePairs(filenames), owners = new Map();
        for (const [page, sources] of pairs) for (const name of sources) owners.set(name, page);
        for (const name of filenames) {
          let path = name;
          if (name !== '.entities.json') {
            const page = source(name) ? owners.get(name) : name;
            const location = page ? catalog.location(page) : { entityId: null, path: name.replace(/\.src(\.html?)$/i, '$1') };
            let logical = location.path;
            if (source(name)) {
              const primary = pairs.get(page)?.[0];
              // Unrenamed root files retain legacy source suffixes/case. Only
              // assigned or logically renamed pages use canonical projection;
              // preserve alternate companions without conflating their bytes.
              logical = !page || (!location.entityId && location.path === page) ? name : name === primary ? sourceFilename(location.path) :
                location.path.replace(/\.html?$/i, /\.htm$/i.test(location.path) ? '.src.html' : '.src.htm');
            }
            path = `${location.entityId ?? '_unassigned'}/${logical}`;
          }
          if (paths.has(path)) throw new Error('Duplicate Git projection path');
          paths.add(path);
          const file = await open(join(outputDir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let bytes;
          try {
            if (!(await file.stat()).isFile()) throw new Error('Page snapshot requires regular files');
            bytes = await file.readFile();
          } finally { await file.close(); }
          const oid = (await git(['hash-object', '-w', '--stdin'], { input: bytes })).stdout.trim();
          entries.push(Buffer.from(`100644 ${oid}\t${path}\0`));
        }
        const emptyBlob = (await git(['hash-object', '-w', '--stdin'], { input: '' })).stdout.trim();
        for (const folder of [...folders].sort()) {
          if (![...paths, ...folders].some(path => path.startsWith(`${folder}/`))) entries.push(Buffer.from(`100644 ${emptyBlob}\t${folder}/.gitkeep\0`));
        }
        if (entries.length) await git(['update-index', '-z', '--index-info'], { index, input: Buffer.concat(entries) });
        const tree = (await git(['write-tree'], { index })).stdout.trim();
        const previous = await git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { allowed: [0, 1] });
        let head = previous.code === 0 ? previous.stdout.trim() : null;
        const priorTree = head ? (await git(['rev-parse', `${head}^{tree}`])).stdout.trim() : null;
        if (head ? tree !== priorTree : entries.length > 0) {
          phase = 'commit';
          const args = ['commit-tree', tree];
          if (head) args.push('-p', head);
          const next = (await git(args, { input: `${message}\n` })).stdout.trim();
          await git(['update-ref', '-m', 'Page history snapshot', 'refs/heads/main', next, head ?? '0'.repeat(next.length)]);
          head = next;
        }
        if (remote && head) {
          phase = 'push';
          await git(['-c', 'push.followTags=false', 'push', '--no-verify', '--recurse-submodules=no', '--', remote, 'refs/heads/main:refs/heads/main'], { timeout: 90000 });
        }
        return head;
      } catch (error) { throw unavailable(error); }
      finally { if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => console.error('Page history temporary index cleanup failed')); }
    },
  };
}
