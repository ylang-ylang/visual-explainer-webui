import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { ApiError, entityId } from './catalog.mjs';

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
      maxBuffer: 1024 * 1024,
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
      let legacy = false;
      let projected = false;
      let emptyBlob;
      const folders = new Map();
      for (const entry of tracked.split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        const header = entry.slice(0, tab);
        const name = entry.slice(tab + 1);
        if (!/^100(?:644|755) blob [0-9a-f]+$/.test(header)) {
          throw new Error('Existing page history must contain only managed regular files');
        }
        if (name === '.entities.json') continue;
        if (managed(name)) {
          legacy = true;
          continue;
        }
        const parts = name.split('/');
        if (parts.length !== 2 || (parts[0] !== '_unassigned' && entityId(parts[0]) !== parts[0]) ||
            (parts[1] !== '.gitkeep' && (!managed(parts[1]) || parts[1] === '.entities.json'))) {
          throw new Error('Existing page history must contain only managed paths');
        }
        projected = true;
        const folder = folders.get(parts[0]) ?? { marker: false, files: false };
        if (parts[1] === '.gitkeep') {
          emptyBlob ??= (await git(['hash-object', '--stdin'], { input: '' })).stdout.trim();
          if (header !== `100644 blob ${emptyBlob}`) throw new Error('Directory markers must be empty regular files');
          folder.marker = true;
        } else {
          folder.files = true;
        }
        folders.set(parts[0], folder);
      }
      if ((legacy && projected) || (projected && !folders.has('_unassigned')) ||
          [...folders.values()].some(folder => folder.marker && folder.files)) {
        throw new Error('Existing page history must use a complete legacy or entity-folder layout');
      }
    }
    // Convert in place: retain all objects, refs, reflogs and the user's index.
    // No Git command may interpret the flat serving directory as this tree's worktree.
    await git(['config', 'core.bare', 'true']);
    if (worktree.code === 0) await git(['config', '--unset-all', 'core.worktree']);
  } catch (error) {
    throw unavailable(error);
  }

  return {
    async snapshot(message) {
      let temporary;
      try {
        phase = 'snapshot';
        temporary = await mkdtemp(join(tmpdir(), 've-history-'));
        const index = join(temporary, 'index');
        await git(['read-tree', '--empty'], { index });
        const entries = [];
        const folders = new Map([['_unassigned', 0], ...catalog.entities().map(entity => [entity.id, 0])]);
        const filenames = (await readdir(outputDir, { withFileTypes: true }))
          .filter(entry => entry.isFile() && managed(entry.name)).map(entry => entry.name).sort();
        const compiled = new Map();
        for (const name of filenames) {
          if (name === '.entities.json' || source(name)) continue;
          const [, stem, extension] = name.match(/^(.*)(\.html?)$/is);
          const candidates = compiled.get(stem) ?? [];
          candidates.push({ name, extension: extension.toLowerCase() });
          compiled.set(stem, candidates);
        }
        for (const name of filenames) {
          let path = name;
          if (name !== '.entities.json') {
            let page = name;
            if (source(name)) {
              const [, stem, extension] = name.match(/^(.*)\.src(\.html?)$/is);
              const candidates = compiled.get(stem) ?? [];
              page = (candidates.find(candidate => candidate.extension === extension.toLowerCase()) ?? candidates[0])?.name;
            }
            const folder = (page && catalog.assignment(page)) ?? '_unassigned';
            if (!folders.has(folder)) throw new Error('Page assignment refers to an unknown entity');
            folders.set(folder, folders.get(folder) + 1);
            path = `${folder}/${name}`;
          }
          const file = await open(join(outputDir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let bytes;
          try {
            if (!(await file.stat()).isFile()) throw new Error('Page snapshot requires regular files');
            bytes = await file.readFile();
          } finally {
            await file.close();
          }
          const oid = (await git(['hash-object', '-w', '--stdin'], { input: bytes })).stdout.trim();
          entries.push(Buffer.from(`100644 ${oid}\t${path}\0`));
        }
        if ([...folders.values()].some(count => count === 0)) {
          const emptyBlob = (await git(['hash-object', '-w', '--stdin'], { input: '' })).stdout.trim();
          for (const [folder, count] of folders) {
            if (count === 0) entries.push(Buffer.from(`100644 ${emptyBlob}\t${folder}/.gitkeep\0`));
          }
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
        // Also retry pending local commits when the current mutation changes no bytes.
        if (remote && head) {
          phase = 'push';
          await git(['-c', 'push.followTags=false', 'push', '--no-verify', '--recurse-submodules=no', '--', remote, 'refs/heads/main:refs/heads/main'], { timeout: 90000 });
        }
      } catch (error) {
        throw unavailable(error);
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => console.error('Page history temporary index cleanup failed'));
      }
    },
  };
}
