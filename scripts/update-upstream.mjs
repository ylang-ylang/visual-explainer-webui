#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('../remote-app/', import.meta.url));
const packagePath = new URL('../remote-app/package.json', import.meta.url);
const lockPath = new URL('../remote-app/package-lock.json', import.meta.url);
const archivePrefix = 'https://codeload.github.com/nicobailon/visual-explainer/tar.gz/';

function revision(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{40}$/i.test(value)) {
    throw new Error('Upstream revision must be a full 40-character Git commit SHA');
  }
  return value.toLowerCase();
}

async function latestRevision() {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch('https://api.github.com/repos/nicobailon/visual-explainer/commits/main', {
    headers, signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub upstream lookup failed (HTTP ${response.status})`);
  return revision((await response.json()).sha);
}

async function main() {
  let check = false;
  let requestedRevision;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--check' && !check) check = true;
    else if (args[index] === '--revision' && requestedRevision === undefined) {
      requestedRevision = revision(args[++index]);
    } else throw new Error('Usage: node scripts/update-upstream.mjs [--check | --revision <40-character SHA>]');
  }
  if (check && requestedRevision !== undefined) throw new Error('--check always reads the latest upstream revision; do not combine with --revision');

  const originalPackage = await readFile(packagePath, 'utf8');
  const currentUrl = JSON.parse(originalPackage).dependencies?.['visual-explainer'];
  if (typeof currentUrl !== 'string' || !currentUrl.startsWith(archivePrefix)) {
    throw new Error('visual-explainer must use the canonical official codeload archive URL');
  }
  const currentRevision = revision(currentUrl.slice(archivePrefix.length));
  if (currentUrl !== archivePrefix + currentRevision) throw new Error('visual-explainer archive URL is not canonical');
  const targetRevision = requestedRevision ?? await latestRevision();
  const changed = currentRevision !== targetRevision;
  if (check) {
    console.log(JSON.stringify({ currentRevision, latestRevision: targetRevision, updateAvailable: changed }));
    return;
  }
  if (changed) {
    const originalLock = await readFile(lockPath, 'utf8');
    const quotedUrl = JSON.stringify(currentUrl);
    if (originalPackage.split(quotedUrl).length !== 2) throw new Error('Expected exactly one upstream dependency URL');
    await writeFile(packagePath, originalPackage.replace(quotedUrl, JSON.stringify(archivePrefix + targetRevision)));
    try {
      execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], {
        cwd: appDir, stdio: ['ignore', 2, 2],
      });
    } catch {
      await writeFile(packagePath, originalPackage);
      await writeFile(lockPath, originalLock);
      throw new Error('npm lockfile refresh failed; package manifest and lockfile restored');
    }
  }
  console.log(JSON.stringify({ previousRevision: currentRevision, revision: targetRevision, changed }));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
