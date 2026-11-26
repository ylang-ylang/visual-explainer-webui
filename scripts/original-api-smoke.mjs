// Run only in a disposable localhost container (original-api-check.sh / check-image.sh).
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'node-html-parser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

assert.equal(process.env.VE_ORIGINAL_API_SMOKE, '1', 'Use scripts/original-api-check.sh');
const base = new URL(process.env.PUBLIC_URL);
assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const prefix = '/api/visual-explainer';
const token = (await readFile(process.env.TOKEN_FILE, 'utf8')).trim();
const dataDir = process.env.VISUAL_EXPLAINER_OUTPUT_DIR;
const upstreamDir = process.env.UPSTREAM_DIR ?? '/opt/bridge/node_modules/visual-explainer';
const skillDir = join(upstreamDir, 'plugins/visual-explainer');
const evidence = '/tmp/ve-original-api-evidence';
await mkdir(evidence, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function treeDigest(dir) {
  const files = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name), info = await lstat(path);
    files.push([name, info.isDirectory() ? await treeDigest(path) : info.isSymbolicLink() ? 'symlink' : sha(await readFile(path))]);
  }
  return sha(JSON.stringify(files));
}
const dependencyBefore = await treeDigest(upstreamDir);
const official = new Client({ name: 'original-http-equivalence', version: '1.0.0' });
await official.connect(new StdioClientTransport({
  command: process.execPath, args: [join(skillDir, 'mcp/server.mjs')], cwd: upstreamDir,
  env: { PATH: process.env.PATH, HOME: '/tmp', VISUAL_EXPLAINER_OUTPUT_DIR: dataDir }, stderr: 'pipe',
}));
let key;
async function request(path, { auth = key ?? token, method = 'GET', body, raw, headers = {}, status = 200 } = {}) {
  const target = new URL(path, base);
  assert.equal(target.origin, base.origin);
  const response = await fetch(target, { method,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual', signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, status, `${method} ${target.pathname}: expected ${status}, got ${response.status}`);
  if (status >= 400) assert.ok((await response.clone().json()).error, 'Errors must be explicit JSON, not empty fallback');
  return response;
}
async function json(path, options) { return (await request(path, options)).json(); }
const post = (body, extra = {}) => ({ method: 'POST', body, ...extra });
async function rawPath(path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base, { path, headers: { Authorization: `Bearer ${key}` } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}
async function readonlySnapshot() {
  const entries = [];
  for (const name of (await readdir(dataDir)).sort()) {
    if ((await lstat(join(dataDir, name))).isFile()) entries.push([name, sha(await readFile(join(dataDir, name)))]);
  }
  return entries;
}
function renderEvidence(result) {
  // Signed page URLs are capabilities too; never put them in shared evidence.
  return JSON.stringify(result, null, 2).replace(/https?:\/\/[^\s"\\]+\/pages\/[a-f0-9]{64}\/[^\s"\\]+/g, '[signed page URL]');
}
async function sheets(result, phase) {
  const images = result.render.content.filter(item => item.type === 'image');
  assert.ok(images.length > 0, 'Official kit renderer must attach actual checksheet images');
  for (const [i, image] of images.entries()) {
    assert.equal(image.mimeType, 'image/png');
    const bytes = Buffer.from(image.data, 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await writeFile(join(evidence, `${phase}-sheet-${i + 1}.png`), bytes);
  }
  await writeFile(join(evidence, `${phase}-render.json`), renderEvidence(result));
}
try {
  const own = (await json('/api/entities', post({ id: 'original-http-own', name: 'Original HTTP fixture' }, { auth: token, status: 201 }))).entity;
  const other = (await json('/api/entities', post({ id: 'original-http-other', name: 'Other private fixture' }, { auth: token, status: 201 }))).entity;
  const issued = await json(`/api/entities/${own.id}/tokens`, post({ expiresIn: 604800 }, { auth: token, status: 201 }));
  key = issued.secret;
  const privatePage = await json(`/api/entities/${other.id}/files/private.html`, {
    auth: token, method: 'PUT', raw: '<!doctype html><html><head><title>Private canary</title></head><body>OTHER_FOLDER_CANARY</body></html>',
    headers: { 'Content-Type': 'text/html' }, status: 201,
  });
  await symlink(process.env.TOKEN_FILE, join(dataDir, 'SKILL.md'));
  const beforeReads = await readonlySnapshot();
  const index = await json(prefix);
  const [resources, prompts, tools] = await Promise.all([official.listResources(), official.listPrompts(), official.listTools()]);
  const installed = JSON.parse(await readFile(join(upstreamDir, 'package.json'), 'utf8'));
  const wrapper = JSON.parse(await readFile('/opt/bridge/package.json', 'utf8'));
  assert.deepEqual(index.package, { name: installed.name, version: installed.version,
    revision: wrapper.dependencies['visual-explainer'].split('/').at(-1), source: wrapper.dependencies['visual-explainer'] });
  assert.deepEqual(index.tools, tools.tools, 'Original tool schemas must be unchanged');
  assert.deepEqual(index.prompts.map(({ url, ...p }) => p), prompts.prompts);
  assert.deepEqual(index.resources.map(({ url, ...r }) => r), resources.resources);
  const hashes = [];
  for (const resource of index.resources) {
    const response = await request(resource.url);
    const bytes = Buffer.from(await response.arrayBuffer());
    const original = await official.readResource({ uri: resource.uri });
    assert.deepEqual(bytes, Buffer.from(original.contents[0].text), `${resource.uri}: MCP text equivalence`);
    const relative = resource.uri.replace('visual-explainer://', '').replace(/^skill\//, '');
    assert.deepEqual(bytes, await readFile(join(skillDir, relative)), `${resource.uri}: installed file byte equivalence`);
    assert.ok(response.headers.get('content-type').startsWith(resource.mimeType));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    hashes.push({ uri: resource.uri, bytes: bytes.length, sha256: sha(bytes) });
  }
  const args = { topic: ' Folder-key boundaries ', goal: ' Explain shared rules and scoped publishing ', audience: ' working agents ', files: [' no-server-project-read.ts ', ''] };
  const prepared = await json(`${prefix}/prepare`, post(args));
  assert.deepEqual(prepared, await official.callTool({ name: 'visual_explainer_prepare', arguments: args }));
  assert.deepEqual(prepared.structuredContent.files, ['no-server-project-read.ts']);
  const failedArgs = { topic: '   ' };
  const failed = await json(`${prefix}/prepare`, post(failedArgs));
  assert.equal(failed.isError, true);
  assert.deepEqual(failed, await official.callTool({ name: 'visual_explainer_prepare', arguments: failedArgs }));
  const promptArgs = { request: 'Explain how shared original rules leave a folder key scoped.' };
  for (const prompt of index.prompts) {
    assert.deepEqual(await json(prompt.url, post(promptArgs)), await official.getPrompt({ name: prompt.name, arguments: promptArgs }));
  }
  assert.deepEqual(await json(`${prefix}/prepare`, post({ topic: 42 })),
    await official.callTool({ name: 'visual_explainer_prepare', arguments: { topic: 42 } }), 'Original validation failures remain tool results, not invented HTTP errors');
  await request(`${prefix}/prompts/generate-web-diagram`, post({ request: 42 }, { status: 502 }));
  await request(`${prefix}/prepare`, { method: 'POST', raw: '{', status: 400 });
  for (const path of ['/package-lock.json', '/README.md', '/references/not-registered.md', '/commands/not-registered.md', '/SKILL.md/extra', '/references/SKILL.md']) {
    await request(prefix + path, { status: 404 });
  }
  await request(`${prefix}/prompts/not-registered`, post({}, { status: 404 }));
  for (const path of [`${prefix}/../tree`, `${prefix}/references/%2e%2e/SKILL.md`, `${prefix}/references/a%2fb.md`, `${prefix}/references/a%5cb.md`, `${prefix}/references/%00.md`]) {
    const r = await rawPath(path);
    assert.equal(r.status, 400, `Reject raw traversal/separator/control path ${path}`);
    assert.ok(JSON.parse(r.body).error);
  }
  await request(`${prefix}/references/%252e%252e.md`, { status: 404 });
  for (const path of [prefix, `${prefix}/SKILL.md`]) {
    await request(path, { auth: null, status: 401 });
    await request(path, { auth: 'invalid-key', status: 401 });
    await request(path, { headers: { Origin: 'https://other.invalid' }, status: 403 });
  }
  await request(`${prefix}/prepare`, post(args, { auth: null, status: 401 }));
  await request(`${prefix}/prompts/generate-web-diagram`, post(promptArgs, { auth: null, status: 401 }));
  await request(`${prefix}/prepare`, post(args, { headers: { Origin: 'https://other.invalid' }, status: 403 }));
  await request(`${prefix}/prompts/generate-web-diagram`, post(promptArgs, { headers: { Origin: 'https://other.invalid' }, status: 403 }));
  for (const path of ['/api/tree', '/api/entities', `/api/entities/${other.id}/tree`, `/api/entities/${other.id}/files/private.html`, `/api/entities/${own.id}/tokens`, `/api/pages/${privatePage.page.filename}/versions`]) {
    await request(path, { status: 403 });
  }
  await request('/mcp', post({}, { status: 403 }));
  await request(`${prefix}/render`, post({}, { status: 403 }));
  const access = createHmac('sha256', token).update('viewer-access').digest('hex');
  const viewer = await request(`/?access=${access}`, { auth: null, status: 303 });
  const cookie = viewer.headers.get('set-cookie').split(';')[0];
  const asViewer = { auth: null, headers: { Cookie: cookie } };
  await request(`${prefix}/SKILL.md`, asViewer);
  assert.deepEqual(await json(`${prefix}/prepare`, post(args, asViewer)), prepared);
  assert.deepEqual(await json(`${prefix}/prompts/generate-web-diagram`, post(promptArgs, asViewer)), await official.getPrompt({ name: 'generate-web-diagram', arguments: promptArgs }));
  await request(`/api/entities/${own.id}/files/no.html`, { ...asViewer, method: 'PUT', raw: '<html></html>', status: 401 });
  await request('/mcp', post({}, { ...asViewer, status: 401 }));
  const login = await request('/api/login', { auth: null, method: 'POST', raw: new URLSearchParams({ key: token }).toString(), headers: { Origin: base.origin } });
  const adminCookie = login.headers.get('set-cookie').split(';')[0];
  await request(`${prefix}/prepare`, post(args, { auth: null, headers: { Cookie: adminCookie } }));
  await request('/api/entities', post({ name: 'Forbidden missing Origin' }, { auth: null, headers: { Cookie: adminCookie }, status: 403 }));
  assert.deepEqual(await readonlySnapshot(), beforeReads, 'Common resource/prepare/prompt calls must not change library or credentials');
  const mcp = await json('/mcp', post({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} }, {
    auth: token, headers: { Accept: 'application/json, text/event-stream' },
  }));
  assert.deepEqual(mcp.result, resources, 'Existing MCP resource forwarding remains available to service key');
  console.log(`PASS ${hashes.length} original installed resource bytes + v${installed.version}/${index.package.revision}; original prepare and ${index.prompts.length} getPrompt results; readonly/scoped/auth/Origin/traversal boundaries`);

  // Agent-facing path: obtain instructions/prompts ONLY over HTTP, not local skill paths.
  const skill = await (await request(`${prefix}/SKILL.md`)).text();
  const style = await (await request(new URL('references/style-guide.md', `${base.origin}${prefix}/SKILL.md`))).text();
  const kit = await (await request(`${prefix}/references/kit.md`)).text();
  const diagrams = await (await request(`${prefix}/references/diagrams.md`)).text();
  const rawIndexText = await (await request(prefix)).text();
  const bundleRes = await request(`${prefix}/bundle?refs=kit,diagrams`);
  assert.ok(bundleRes.headers.get('content-type').startsWith('text/plain'));
  const bundleText = await bundleRes.text();
  assert.ok(bundleText.includes(rawIndexText), 'Bundle must include verbatim compact official index JSON');
  assert.ok(bundleText.includes(skill), 'Bundle must include verbatim SKILL.md');
  assert.ok(bundleText.includes(style), 'Bundle must include verbatim references/style-guide.md');
  assert.ok(bundleText.includes(kit) && bundleText.includes(diagrams), 'Bundle must include requested ?refs=kit,diagrams verbatim');
  await request(`${prefix}/bundle?refs=unknown-ref`, { status: 404 });
  await request(`${prefix}/bundle?refs=../SKILL`, { status: 400 });
  await request(`${prefix}/bundle?refs=a,b,c,d,e,f,g,h,i`, { status: 400 });
  await request(`${prefix}/bundle`, { auth: null, status: 401 });
  await request(`${prefix}/bundle`, { headers: { Origin: 'https://other.invalid' }, status: 403 });
  const flowPrepared = await json(`${prefix}/prepare`, post(args));
  assert.equal(flowPrepared.structuredContent.topic, args.topic.trim());
  const taskPrompt = await json(`${prefix}/prompts/generate-web-diagram`, post(promptArgs));
  assert.ok(skill.includes('Before delivery') && style.includes('Blueprint') && kit.includes('<ve-flow') && diagrams.length > 1000);
  assert.ok(taskPrompt.messages[0].content.text.includes(promptArgs.request));
  const route = `/api/entities/${own.id}/files/boundaries.html`;
  let source = `<!doctype html>
<html lang="en" data-register="blueprint"><head><title>Shared rules leave writes scoped</title><link rel="stylesheet" href="kit.css" data-ve-kit></head>
<body><main><header><p class="eyebrow">Folder-key boundary</p><h1>Shared rules leave writes scoped</h1></header>
<figure><ve-flow label="The agent reads shared original rules and writes only its own folder."><ve-node id="agent" at="1 1" key>Agent</ve-node><ve-node id="rules" at="2 1">Rules</ve-node><ve-node id="own" at="1 2">Own folder</ve-node><ve-edge from="agent" to="rules" label="reads rules"/><ve-edge from="agent" to="own" label="PUT source" hot/></ve-flow></figure>
</main></body></html>
`;
  await writeFile(join(evidence, 'diagram.src.html'), source);
  const first = await json(route, { method: 'PUT', raw: source, headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 201 });
  assert.equal(first.render.isError, undefined);
  assert.equal(first.render.structuredContent.report.figures, 1);
  assert.equal(first.render.structuredContent.report.uncaptioned, 1, 'Initial report must expose the missing caption');
  await sheets(first, 'first');
  assert.equal(await (await request(route)).text(), source);
  // Correct the specific report finding with one source edit, not a regenerated page.
  source = source.replace('</ve-flow></figure>', '</ve-flow><figcaption>A folder key reads the original shared rules but publishes only inside its own folder.</figcaption></figure>');
  await writeFile(join(evidence, 'diagram.src.html'), source);
  const final = await json(route, { method: 'PUT', raw: source, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  assert.equal(final.page.filename, first.page.filename);
  assert.equal(final.page.url, first.page.url);
  assert.notEqual(final.revision, first.revision);
  assert.equal(final.render.structuredContent.report.uncaptioned, 0);
  const diagnostics = final.render.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.ok(!diagnostics.includes('✗'), diagnostics);
  await sheets(final, 'final');
  assert.equal(await (await request(route)).text(), source, 'Scoped GET must return exact editable source');
  const rendered = await (await request(final.page.url, { auth: null })).text();
  const compiled = parse(rendered);
  assert.equal(compiled.querySelectorAll('ve-flow').length, 0, 'Source tags must be compiled, not passed through');
  assert.equal(compiled.querySelectorAll('svg.ve-flow').length, 1, 'Original flow SVG must be present');
  assert.equal(compiled.querySelectorAll('style[data-ve-kit]').length, 1, 'Original kit is embedded by the renderer');
  assert.equal(compiled.querySelectorAll('link[data-ve-kit]').length, 0);
  await request(route, { method: 'PUT', raw: source, headers: { 'Content-Type': 'text/html', Origin: 'https://other.invalid' }, status: 403 });
  await request(`/api/entities/${other.id}/files/boundaries.html`, { method: 'PUT', raw: source, headers: { 'Content-Type': 'text/html' }, status: 403 });
  const versions = await json(`/api/pages/${final.page.filename}/versions`);
  assert.ok(versions.versions.some(version => version.revision === first.revision));
  await request(`/api/entities/${own.id}/tokens/${issued.token.id}`, { auth: token, method: 'DELETE', status: 204 });
  await request(`${prefix}/SKILL.md`, { status: 401 });
  await request(`${prefix}/prepare`, post(args, { status: 401 }));
  assert.equal(await treeDigest(upstreamDir), dependencyBefore, 'Official installed package must remain byte-identical');
  await writeFile(join(evidence, 'equivalence.json'), JSON.stringify({ package: index.package, resources: hashes,
    promptsEquivalent: index.prompts.length, prepareEquivalent: true, originalDependencySha256: dependencyBefore,
    dependencyUnchanged: true, firstReport: first.render.structuredContent.report, finalReport: final.render.structuredContent.report,
    diagnostics: diagnostics.replaceAll(final.page.url, '[signed page URL]') }, null, 2));
  console.log('PASS HTTP-only original bootstrap → prepare/prompt → kit source → scoped PUT → original report/PNG checksheet → caption correction → same-path republish; raw HTML compatibility; dependency unchanged');
} finally { await official.close(); }
