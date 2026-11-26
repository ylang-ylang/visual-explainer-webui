#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRepoDir = resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    repoDir: defaultRepoDir,
    upstreamDir: process.env.UPSTREAM_DIR ?? '',
    image: process.env.VE_VERIFY_IMAGE ?? 'visual-explainer-webui:local-debug',
    inContainer: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) opts.repoDir = resolve(argv[++i]);
    else if (arg === '--upstream-dir' && argv[i + 1]) opts.upstreamDir = resolve(argv[++i]);
    else if (arg === '--image' && argv[i + 1]) opts.image = argv[++i];
    else if (arg === '--in-container') opts.inContainer = true;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const localUpstreamCandidate = join(opts.repoDir, 'remote-app/node_modules/visual-explainer');
const containerUpstreamCandidate = '/opt/bridge/node_modules/visual-explainer';

let upstreamDir = opts.upstreamDir;
if (!upstreamDir) {
  if (existsSync(join(containerUpstreamCandidate, 'plugins/visual-explainer/SKILL.md'))) {
    upstreamDir = containerUpstreamCandidate;
  } else if (existsSync(join(localUpstreamCandidate, 'plugins/visual-explainer/SKILL.md'))) {
    upstreamDir = localUpstreamCandidate;
  }
}

if (!upstreamDir && !opts.inContainer) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  const dockerArgs = [
    'run', '--rm',
    '--user', `${uid}:${gid}`,
    '--entrypoint', 'node',
    '-v', `${opts.repoDir}:/repo:ro`,
    '-w', '/opt/bridge',
    opts.image,
    '/repo/scripts/verify-builtin-skills.mjs',
    '--in-container',
    '--repo', '/repo',
    '--upstream-dir', containerUpstreamCandidate,
  ];
  try {
    const { stdout, stderr } = await execFileAsync('docker', dockerArgs, { maxBuffer: 16 * 1024 * 1024 });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(0);
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    process.exit(typeof error.code === 'number' ? error.code : 1);
  }
}

assert.ok(upstreamDir && existsSync(join(upstreamDir, 'plugins/visual-explainer/SKILL.md')),
  `Unable to locate upstream visual-explainer package (checked ${upstreamDir || 'local & container paths'})`);

const skillsModuleUrl = pathToFileURL(join(opts.repoDir, 'remote-app/skills.mjs')).href;
const { createSkills, docIdFromUri } = await import(skillsModuleUrl);

async function loadUpstreamDocsFromMcp(pkgDir) {
  const sdkIndexCandidates = [
    join(dirname(pkgDir), '@modelcontextprotocol/sdk/dist/esm/client/index.js'),
    '/opt/bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js',
  ];
  const sdkIndex = sdkIndexCandidates.find(p => existsSync(p));
  if (!sdkIndex) return null;
  const sdkStdio = sdkIndex.replace(/index\.js$/, 'stdio.js');
  const { Client } = await import(pathToFileURL(sdkIndex).href);
  const { StdioClientTransport } = await import(pathToFileURL(sdkStdio).href);

  const client = new Client({ name: 'verify-builtin-skills', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(pkgDir, 'plugins/visual-explainer/mcp/server.mjs')],
    cwd: pkgDir,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp',
    },
  });
  try {
    await client.connect(transport);
    const listed = await client.listResources();
    const docs = new Map();
    for (const resource of listed.resources) {
      const docId = docIdFromUri(resource.uri);
      if (!docId) continue;
      const loaded = await client.readResource({ uri: resource.uri });
      assert.equal(loaded.contents.length, 1, `Expected single text document for ${resource.uri}`);
      docs.set(docId, loaded.contents[0].text);
    }
    const version = client.getServerVersion()?.version ?? '0.0.0';
    return { docs, version, source: 'mcp' };
  } finally {
    await client.close().catch(() => {});
  }
}

async function loadUpstreamDocsFromDisk(pkgDir) {
  const root = join(pkgDir, 'plugins/visual-explainer');
  const docs = new Map();
  docs.set('SKILL.md', await readFile(join(root, 'SKILL.md'), 'utf8'));
  for (const folder of ['references', 'commands']) {
    const names = (await readdir(join(root, folder))).filter(name => name.endsWith('.md')).sort();
    for (const name of names) {
      docs.set(`${folder}/${name}`, await readFile(join(root, folder, name), 'utf8'));
    }
  }
  const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  return { docs, version: pkg.version ?? '0.0.0', source: 'disk' };
}

const loaded = (await loadUpstreamDocsFromMcp(upstreamDir)) ?? (await loadUpstreamDocsFromDisk(upstreamDir));
const builtinDir = join(opts.repoDir, 'remote-app/builtin-skills');
const rawManifest = JSON.parse(await readFile(join(builtinDir, 'manifest.json'), 'utf8'));

assert.ok(Array.isArray(rawManifest.explainers), 'manifest.json must contain an explainers array');
assert.equal(rawManifest.explainers.length, 8, `Expected exactly 8 built-in explainers, got ${rawManifest.explainers.length}`);

const expectedIds = [
  'overview',
  'bootstrap-prompt',
  'SKILL',
  'style-guide',
  'kit',
  'diagrams',
  'motion',
  'commands-and-extras',
];
assert.deepEqual(
  rawManifest.explainers.map(item => item.id).sort(),
  [...expectedIds].sort(),
  'manifest.json explainer ids must match the 8 progressive explainers',
);

const scratchOutputDir = await mkdtemp(join(tmpdir(), 've-verify-skills-'));
try {
  const skills = await createSkills(scratchOutputDir, {
    upstreamDocs: loaded.docs,
    upstreamMeta: { version: loaded.version, revision: 'verify-check' },
    builtinDir,
  });

  const overview = skills.overview();
  const docs = overview.docs;
  const explainers = overview.explainers;
  const conflicts = Object.keys(overview.conflicts);

  assert.equal(docs.length, 22, `Expected 22 managed skill docs, got ${docs.length}`);
  assert.equal(explainers.length, 8, `Expected 8 loaded explainers, got ${explainers.length}`);
  assert.equal(conflicts.length, 0, `Expected 0 conflicts, got ${conflicts.length}: ${conflicts.join(', ')}`);

  for (const doc of docs) {
    assert.ok(doc.explainerId !== null, `Managed doc ${doc.id} is not covered by any L1 explainer`);
    assert.equal(doc.explainerSynced, true, `Managed doc ${doc.id} explainer (${doc.explainerId}) is not synced`);
    assert.equal(doc.hasConflict, false, `Managed doc ${doc.id} has unexpected conflict`);
    assert.equal(doc.status, 'upstream', `Managed doc ${doc.id} status should be upstream, got ${doc.status}`);
  }

  const rawById = new Map(rawManifest.explainers.map(entry => [entry.id, entry]));
  for (const exp of explainers) {
    const raw = rawById.get(exp.id);
    assert.ok(raw && typeof raw.skillHash === 'string' && /^[0-9a-f]{64}$/.test(raw.skillHash),
      `manifest.json entry ${exp.id} must specify an explicit 64-hex SHA-256 skillHash`);
    assert.equal(raw.skillHash, exp.expectedSkillHash,
      `manifest.json skillHash mismatch for ${exp.id}: manifest=${raw.skillHash} expected=${exp.expectedSkillHash}`);
    assert.equal(exp.synced, true, `Explainer ${exp.id} is not synced`);

    const html = skills.getExplainerHtml(exp.id);
    const src = skills.getExplainerSource(exp.id);
    assert.ok(html.length > 20000, `Compiled HTML for ${exp.id} looks unexpectedly small (${html.length} bytes)`);
    assert.ok(src.length > 1000, `Source HTML for ${exp.id} looks unexpectedly small (${src.length} bytes)`);
    assert.match(html, /<meta\s+name="description"\s+content="[^"]+"/i, `Compiled ${exp.id}.html missing meta description`);
    assert.doesNotMatch(src, /<!--/, `Source ${exp.id}.src.html must not contain HTML comments`);
    assert.doesNotMatch(src, /<style[^>]*>[\s\S]*?\/\*[\s\S]*?<\/style>/i, `Source ${exp.id}.src.html must not contain CSS comments`);
    assert.doesNotMatch(src, /ve-drill-/, `Source ${exp.id}.src.html must not inject fake portal CSS`);
    assert.match(src, /data-register="blueprint"/, `Source ${exp.id}.src.html must use blueprint register`);
  }

  const overviewHtml = skills.getExplainerHtml('overview');
  for (const childId of expectedIds.filter(id => id !== 'overview')) {
    assert.ok(overviewHtml.includes(`data-ve-child="${childId}"`),
      `overview.html must contain data-ve-child="${childId}" drill-down link`);
  }

  console.log(`PASS verify-builtin-skills (upstream v${loaded.version} via ${loaded.source})`);
  console.log(`  Managed docs: ${docs.length}/22 covered & synced`);
  console.log(`  Explainers:   ${explainers.length}/8 loaded, synced=true, SHA-256 exact match`);
  console.log(`  Conflicts:    ${conflicts.length}`);
  for (const exp of explainers) {
    console.log(`  - [L${exp.layer}] ${exp.id.padEnd(20)} covers=${String(exp.covers.length).padStart(2)} synced=${exp.synced} sha256=${exp.skillHash.slice(0, 12)}…`);
  }
} finally {
  await rm(scratchOutputDir, { recursive: true, force: true }).catch(() => {});
}
