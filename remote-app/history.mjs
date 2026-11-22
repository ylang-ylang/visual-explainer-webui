import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { ApiError } from './catalog.mjs';

const execute = promisify(execFile);
const author = 'Visual Explainer';
const email = 'visual-explainer@localhost';
const managed = name => name === '.entities.json' || (!name.includes('/') && /\.html?$/i.test(name));
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
export async function createHistory(outputDir) {
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
    const pending = execute('git', [...config, ...args], {
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

    const gitDir = join(outputDir, '.git');
    const status = await exists(gitDir);
    if (status && (!status.isDirectory() || status.isSymbolicLink() || await realpath(gitDir) !== gitDir)) {
      throw new Error('Page Git metadata must be a local directory, not a symlink or worktree pointer');
    }
    if (status) await localMetadata(gitDir);
    if (await exists(join(gitDir, 'objects/info/alternates')) || await exists(join(gitDir, 'commondir'))) {
      throw new Error('Page Git repository must not share external metadata or objects');
    }
    if (!status) await git(['init', '--initial-branch=main', '--template=', '.']);
    const root = (await git(['rev-parse', '--show-toplevel'])).stdout.trimEnd();
    const actualGitDir = (await git(['rev-parse', '--absolute-git-dir'])).stdout.trimEnd();
    const common = (await git(['rev-parse', '--git-common-dir'])).stdout.trimEnd();
    if (root !== outputDir || actualGitDir !== gitDir || resolve(outputDir, common) !== gitDir) {
      throw new Error('Page Git repository must be rooted exactly at the output directory');
    }
    if ((await git(['symbolic-ref', 'HEAD'])).stdout.trimEnd() !== 'refs/heads/main') {
      throw new Error('Page Git history must use the main branch');
    }
    const current = await git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { allowed: [0, 1] });
    if (current.code === 0) {
      const tracked = (await git(['ls-tree', '-rz', '--full-tree', current.stdout.trim()])).stdout;
      for (const entry of tracked.split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        if (!/^100(?:644|755) blob [0-9a-f]+$/.test(entry.slice(0, tab)) || !managed(entry.slice(tab + 1))) {
          throw new Error('Existing page history must contain only managed regular files');
        }
      }
    }
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
        const filenames = new Set();
        for (const entry of await readdir(outputDir, { withFileTypes: true })) {
          if (!entry.isFile() || !managed(entry.name)) continue;
          const file = await open(join(outputDir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let bytes;
          try {
            if (!(await file.stat()).isFile()) throw new Error('Page snapshot requires regular files');
            bytes = await file.readFile();
          } finally {
            await file.close();
          }
          const oid = (await git(['hash-object', '-w', '--stdin'], { input: bytes })).stdout.trim();
          entries.push(Buffer.from(`100644 ${oid}\t${entry.name}\0`));
          filenames.add(entry.name);
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
        // Keep native Git status coherent without disturbing unrelated staged files.
        const staged = (await git(['ls-files', '-z'])).stdout.split('\0').filter(name => name && managed(name));
        const removed = staged.filter(name => !filenames.has(name))
          .map(name => Buffer.from(`0 ${'0'.repeat(tree.length)}\t${name}\0`));
        if (entries.length || removed.length) {
          await git(['update-index', '-z', '--index-info'], { input: Buffer.concat([...removed, ...entries]) });
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
