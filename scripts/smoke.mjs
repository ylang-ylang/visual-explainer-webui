#!/usr/bin/env node
// Destructive only to this suite's namespace. Run against a fresh, isolated localhost
// instance seeded with legacy.html, never against deployed data.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const prefix = 'wrapper-smoke';
const fixture = {
  legacy: 'legacy.html',
  mcp: `${prefix}-mcp.html`,
  api: `${prefix}-api.html`,
  rejected: `${prefix}-rejected.html`,
  a: `${prefix}-a`,
  b: `${prefix}-b`,
  empty: `${prefix}-empty`,
  missing: `${prefix}-missing`,
};
const finalName = 'Wrapper smoke renamed';
const rpcVersion = '2025-03-26';
let protocolVersion = rpcVersion;
let requestId = 0;
let base;
let token;
let viewerKey;

function document(title, marker, kit = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
${kit ? '<link rel="stylesheet" href="kit.css" data-ve-kit>' : ''}
</head><body><main><h1>${marker}</h1>${kit ? `<figure><pre class="mermaid" aria-label="Smoke input becomes rendered output">flowchart LR
  A[Smoke input] --> B[Rendered output]</pre><figcaption>Smoke input becomes rendered output.</figcaption></figure>` : '<p>Real wrapper API compatibility fixture.</p>'}
</main></body></html>`;
}

async function request(path, { method = 'GET', auth = 'service', body, raw, headers = {}, status = 200, render = false } = {}) {
  const target = new URL(path, base);
  assert.equal(target.origin, base.origin, 'Requests must remain on the isolated server');
  const response = await fetch(target, {
    method,
    headers: {
      Accept: 'application/json',
      ...(auth === 'service' ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(render ? 180000 : 30000),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${target.pathname}: expected ${status}, got ${response.status}: ${text.slice(0, 1000)}`);
  let data;
  if (response.headers.get('content-type')?.includes('application/json') && text) data = JSON.parse(text);
  return { response, text, data };
}

async function api(path, options) {
  return (await request(path, options)).data;
}

async function error(path, status, options = {}) {
  const { data } = await request(path, { ...options, status });
  assert.equal(typeof data?.error, 'string', `${path} must return a JSON error`);
  assert.ok(data.error.length > 0, `${path} error must explain the failure`);
}

async function rpc(method, params = {}, { render = false } = {}) {
  const id = ++requestId;
  const { data } = await request('/mcp', {
    method: 'POST',
    headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion },
    body: { jsonrpc: '2.0', id, method, params },
    render,
  });
  assert.equal(data?.jsonrpc, '2.0', `${method}: JSON-RPC response required`);
  assert.equal(data.id, id, `${method}: response ID must match`);
  assert.equal(data.error, undefined, `${method}: ${JSON.stringify(data.error)}`);
  assert.ok(data.result && typeof data.result === 'object', `${method}: result required`);
  return data.result;
}

function textContent(result) {
  return (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
}

async function mcpReadChecks() {
  const initialized = await rpc('initialize', {
    protocolVersion: rpcVersion,
    capabilities: {},
    clientInfo: { name: 'visual-explainer-webui-smoke', version: '1.0.0' },
  });
  assert.equal(typeof initialized.protocolVersion, 'string');
  protocolVersion = initialized.protocolVersion;
  for (const capability of ['tools', 'resources', 'prompts']) {
    assert.ok(initialized.capabilities?.[capability], `MCP must advertise ${capability}`);
  }
  await request('/mcp', {
    method: 'POST', status: 202,
    headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion },
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  const tools = await rpc('tools/list');
  assert.ok(Array.isArray(tools.tools));
  assert.ok(tools.tools.some(tool => tool.name === 'visual_explainer_prepare'));
  const render = tools.tools.find(tool => tool.name === 'visual_explainer_render_html');
  assert.ok(render, 'Official render tool must be exposed');
  assert.deepEqual([...render.inputSchema.required].sort(), ['filename', 'html']);
  assert.ok(render.inputSchema.properties.entityId, 'Wrapper assignment input must be exposed');
  assert.equal(render.inputSchema.properties.path, undefined, 'Remote clients must not submit server paths');
  const resources = await rpc('resources/list');
  assert.ok(Array.isArray(resources.resources));
  const skillUri = 'visual-explainer://skill/SKILL.md';
  assert.ok(resources.resources.some(resource => resource.uri === skillUri));
  assert.ok(resources.resources.some(resource => resource.uri === 'visual-explainer://kit/kit.css'));
  const skill = await rpc('resources/read', { uri: skillUri });
  const skillText = skill.contents?.find(content => content.uri === skillUri);
  assert.equal(skillText?.mimeType, 'text/markdown');
  assert.ok(skillText.text.length > 1000, 'Skill must contain its actual bundled instructions');
  assert.match(skillText.text, /visual.explainer/i);
  const prompts = await rpc('prompts/list');
  assert.ok(prompts.prompts?.some(prompt => prompt.name === 'generate-web-diagram'));
  const promptMarker = 'WRAPPER_SMOKE_PROMPT_ARGUMENT';
  const prompt = await rpc('prompts/get', { name: 'generate-web-diagram', arguments: { request: promptMarker } });
  const message = prompt.messages?.find(item => item.role === 'user' && item.content?.type === 'text');
  assert.ok(message?.content.text.includes(promptMarker), 'Official prompt must substitute the supplied request');
  assert.match(message.content.text, /visual-explainer/);
  assert.ok(!message.content.text.includes('$@'), 'Prompt placeholder must be substituted');
  const prepared = await rpc('tools/call', {
    name: 'visual_explainer_prepare',
    arguments: { topic: ' Wrapper smoke ', goal: ' Verify compatibility ', audience: ' developers ', files: [' README.md ', ''] },
  });
  assert.ok(!prepared.isError, 'Prepare must succeed');
  assert.equal(prepared.structuredContent?.topic, 'Wrapper smoke');
  assert.equal(prepared.structuredContent.goal, 'Verify compatibility');
  assert.equal(prepared.structuredContent.audience, 'developers');
  assert.deepEqual(prepared.structuredContent.files, ['README.md']);
  assert.ok(prepared.structuredContent.recommendedFlow?.length >= 3);
  assert.match(textContent(prepared), /Prepared visual explanation for: Wrapper smoke/);
  assert.ok(textContent(prepared).includes(skillUri), 'Prepare must include remote wrapper instructions');
  console.log('PASS MCP initialization, official tools, skill resource, prompt substitution and prepare results');
}

function validatePage(page, filename, entityId) {
  assert.equal(page?.filename, filename);
  assert.equal(page.entityId, entityId, `${filename}: assignment`);
  assert.ok(Number.isInteger(page.bytes) && page.bytes > 0);
  assert.equal(new Date(page.modified).toISOString(), page.modified);
  const signature = createHmac('sha256', token).update(`page:${filename}`).digest('hex');
  assert.equal(page.url, new URL(`/pages/${signature}/${encodeURIComponent(filename)}`, base).href, 'Stable signed page URL');
  return page;
}

async function page(filename, entityId) {
  return validatePage((await api(`/api/pages/${filename}`)).page, filename, entityId);
}

async function pageBody(metadata, marker) {
  const { text, response } = await request(metadata.url, { auth: 'none' });
  assert.ok(text.length > 0, `${metadata.filename}: published HTML must not be empty`);
  if (marker !== undefined) assert.ok(text.includes(marker), `${metadata.filename}: actual published content must include ${marker}`);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(Buffer.byteLength(text), metadata.bytes, 'Listed bytes must match actual page body');
  return text;
}

async function query(entityId, filenames) {
  const suffix = entityId === undefined ? '' : `?entityId=${encodeURIComponent(entityId ?? '')}`;
  const result = await api(`/api/pages${suffix}`);
  assert.deepEqual(result.pages.map(item => item.filename).sort(), [...filenames].sort(), `Page filter ${entityId ?? 'unassigned'}`);
  return result.pages;
}

async function viewerChecks() {
  await error('/api/entities', 401, { auth: 'none' });
  await error('/api/pages', 401, { auth: 'none' });
  await error('/mcp', 401, { method: 'POST', auth: 'none', body: {} });
  const access = await request(`/?access=${viewerKey}`, { auth: 'none', status: 303 });
  assert.equal(access.response.headers.get('location'), '/');
  const setCookie = access.response.headers.get('set-cookie');
  assert.match(setCookie, /^ve_viewer=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const viewer = { auth: 'none', headers: { Cookie: cookie } };
  const gallery = await request('/', viewer);
  assert.match(gallery.response.headers.get('content-type'), /^text\/html/);
  assert.ok(gallery.text.includes('<html'), 'Viewer must receive the real gallery');
  assert.deepEqual((await api('/api/entities', viewer)), await api('/api/entities'));
  assert.deepEqual((await api('/api/pages', viewer)), await api('/api/pages'));
  await api(`/api/pages/${fixture.legacy}`, viewer);
  for (const [path, method, body] of [
    ['/api/entities', 'POST', { id: `${prefix}-viewer`, name: 'Forbidden' }],
    [`/api/entities/${fixture.b}`, 'PATCH', { name: 'Forbidden' }],
    [`/api/entities/${fixture.b}`, 'DELETE', undefined],
    [`/api/pages/${fixture.legacy}`, 'PATCH', { entityId: null }],
    [`/api/pages/${fixture.legacy}`, 'PUT', { html: document('Forbidden', 'FORBIDDEN') }],
    ['/mcp', 'POST', { jsonrpc: '2.0', id: 999, method: 'tools/list' }],
  ]) await error(path, 401, { ...viewer, method, body });
  await error('/api/entities', 401, { auth: 'none', headers: { Authorization: `Bearer ${viewerKey}` } });
  await error('/api/entities', 401, { auth: 'none', headers: { Cookie: 've_viewer=1.invalid' } });
  await request(`/?access=${'0'.repeat(64)}`, { auth: 'none', status: 403 });
  const login = await request('/api/login', {
    auth: 'none', method: 'POST', raw: new URLSearchParams({ key: viewerKey }).toString(),
    headers: { Origin: base.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(login.text, 'ok');
  assert.match(login.response.headers.get('set-cookie'), /^ve_viewer=/);
  const logout = await request('/api/logout', { ...viewer, method: 'POST', headers: { ...viewer.headers, Origin: base.origin } });
  assert.match(logout.response.headers.get('set-cookie'), /Max-Age=0/);
  await error('/api/entities', 403, { headers: { Origin: 'https://invalid.example' } });
  console.log('PASS viewer key, viewer cookie, read-only authorization, login/logout and origin rejection');
}

function validateRender(result, filename, entityId, kit = false) {
  assert.ok(!result.isError, `Render failed: ${textContent(result)}`);
  assert.ok(result.structuredContent?.path.endsWith(`/${filename}`), 'Official renderer must return the actual output path');
  assert.equal(result.structuredContent.entityId, entityId);
  assert.equal(result.structuredContent.openAttempted, false);
  assert.equal(result.structuredContent.openStatus, 'disabled');
  assert.ok(textContent(result).includes(result.structuredContent.url), 'Result must contain the published URL');
  if (kit) {
    assert.ok(result.structuredContent.source.endsWith(`/${filename.replace(/\.html$/, '.src.html')}`));
    assert.equal(result.structuredContent.report?.figures, 1);
    assert.equal(result.structuredContent.report.uncaptioned, 0);
    const images = result.content.filter(item => item.type === 'image');
    assert.ok(images.length > 0, 'Kit render must include real browser screenshots');
    for (const image of images) {
      assert.equal(image.mimeType, 'image/png');
      const png = Buffer.from(image.data, 'base64');
      assert.ok(png.length > 1000, 'Browser screenshot must not be empty');
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
  }
}

async function finalState() {
  const catalog = await api('/api/entities');
  assert.equal(catalog.totalCount, 3);
  assert.equal(catalog.unassignedCount, 1);
  assert.equal(catalog.entities.length, 1);
  const entity = catalog.entities[0];
  assert.equal(entity.id, fixture.b);
  assert.equal(entity.name, finalName);
  assert.equal(entity.diagramCount, 2);
  assert.equal(new Date(entity.createdAt).toISOString(), entity.createdAt);
  assert.ok(Date.parse(entity.updatedAt) >= Date.parse(entity.createdAt));
  await query(fixture.b, [fixture.mcp, fixture.api]);
  await query(null, [fixture.legacy]);
  await query(undefined, [fixture.legacy, fixture.mcp, fixture.api]);
  const mcp = await page(fixture.mcp, fixture.b);
  const rendered = await pageBody(mcp, 'WRAPPER_SMOKE_MCP_V2');
  assert.match(rendered, /<style data-ve-kit>/);
  assert.match(rendered, /class="ve-mermaid"/);
  assert.match(rendered, /<svg[^>]*class="pele/);
  assert.ok(!/<pre\b[^>]*class="mermaid"/.test(rendered), 'Mermaid source must be expanded to actual SVG');
  await pageBody(await page(fixture.api, fixture.b), 'WRAPPER_SMOKE_API_V3');
  await pageBody(await page(fixture.legacy, null));
  return catalog;
}

async function fullSuite() {
  // Refuse to overwrite a previous run or any non-fixture data. Restart checks use
  // --persistence instead; a fresh full run requires a fresh disposable volume.
  const initial = await api('/api/entities');
  assert.deepEqual(initial.entities, [], 'Fresh isolated data required: no pre-existing entities');
  assert.equal(initial.totalCount, 1, `Seed only ${fixture.legacy} before running this suite`);
  assert.equal(initial.unassignedCount, 1);
  await query(undefined, [fixture.legacy]);
  const legacy = await page(fixture.legacy, null);
  const legacyBody = await pageBody(legacy);
  await mcpReadChecks();

  for (const [id, name] of [[fixture.a, 'Wrapper smoke source'], [fixture.b, 'Wrapper smoke destination'], [fixture.empty, 'Wrapper smoke empty']]) {
    const created = (await api('/api/entities', { method: 'POST', status: 201, body: { id, name } })).entity;
    assert.equal(created.id, id);
    assert.equal(created.name, name);
    assert.equal(created.diagramCount, 0);
    assert.equal(created.updatedAt, created.createdAt);
  }
  const renamed = (await api(`/api/entities/${fixture.b}`, { method: 'PATCH', body: { name: ` ${finalName} ` } })).entity;
  assert.equal(renamed.name, finalName);
  await error('/api/entities', 409, { method: 'POST', body: { id: fixture.a, name: 'Duplicate' } });
  await request(`/api/entities/${fixture.empty}`, { method: 'DELETE', status: 204 });
  assert.ok(!(await api('/api/entities')).entities.some(entity => entity.id === fixture.empty));
  console.log('PASS entity create, rename, duplicate conflict and empty deletion');

  const first = await rpc('tools/call', { name: 'visual_explainer_render_html', arguments: {
    filename: fixture.mcp, html: document('Wrapper MCP V1', 'WRAPPER_SMOKE_MCP_V1', true), entityId: fixture.a,
  } }, { render: true });
  validateRender(first, fixture.mcp, fixture.a, true);
  assert.equal((await page(fixture.mcp, fixture.a)).url, first.structuredContent.url);
  await pageBody(await page(fixture.mcp, fixture.a), 'WRAPPER_SMOKE_MCP_V1');
  const second = await rpc('tools/call', { name: 'visual_explainer_render_html', arguments: {
    filename: fixture.mcp, html: document('Wrapper MCP V2', 'WRAPPER_SMOKE_MCP_V2', true),
  } }, { render: true });
  validateRender(second, fixture.mcp, fixture.a, true);
  assert.equal(second.structuredContent.url, first.structuredContent.url);
  await pageBody(await page(fixture.mcp, fixture.a), 'WRAPPER_SMOKE_MCP_V2');
  console.log('PASS real official kit/Mermaid render, browser screenshots, assignment and MCP omitted-entity preservation');

  const created = await api(`/api/pages/${fixture.api}`, { method: 'PUT', status: 201, render: true,
    body: { html: document('Wrapper API V1', 'WRAPPER_SMOKE_API_V1') } });
  validatePage(created.page, fixture.api, null);
  validateRender(created.render, fixture.api, null);
  await pageBody(created.page, 'WRAPPER_SMOKE_API_V1');
  await query(null, [fixture.legacy, fixture.api]);
  const assigned = await api(`/api/pages/${fixture.api}`, { method: 'PUT', render: true,
    body: { html: document('Wrapper API V2', 'WRAPPER_SMOKE_API_V2'), entityId: fixture.a } });
  validatePage(assigned.page, fixture.api, fixture.a);
  const replaced = await api(`/api/pages/${fixture.api}`, { method: 'PUT', render: true,
    body: { html: document('Wrapper API V3', 'WRAPPER_SMOKE_API_V3') } });
  validatePage(replaced.page, fixture.api, fixture.a);
  validateRender(replaced.render, fixture.api, fixture.a);
  assert.equal(replaced.page.url, created.page.url);
  await pageBody(replaced.page, 'WRAPPER_SMOKE_API_V3');
  await error(`/api/entities/${fixture.a}`, 409, { method: 'DELETE' });
  assert.equal((await api('/api/entities')).entities.find(entity => entity.id === fixture.a).diagramCount, 2);
  await query(fixture.a, [fixture.mcp, fixture.api]);

  for (const filename of [fixture.mcp, fixture.api]) {
    const before = await page(filename, fixture.a);
    const beforeBody = (await request(before.url, { auth: 'none' })).text;
    const moved = (await api(`/api/pages/${filename}`, { method: 'PATCH', body: { entityId: fixture.b } })).page;
    validatePage(moved, filename, fixture.b);
    assert.equal(moved.url, before.url, 'Moving must not change signed URL');
    assert.equal(moved.modified, before.modified, 'Moving must not touch HTML modification time');
    assert.equal(moved.bytes, before.bytes);
    assert.equal(moved.title, before.title);
    assert.equal((await request(before.url, { auth: 'none' })).text, beforeBody, 'Moving must not change page body');
  }
  const unassigned = (await api(`/api/pages/${fixture.api}`, { method: 'PATCH', body: { entityId: null } })).page;
  validatePage(unassigned, fixture.api, null);
  await query(null, [fixture.legacy, fixture.api]);
  await api(`/api/pages/${fixture.api}`, { method: 'PATCH', body: { entityId: fixture.b } });
  await request(`/api/entities/${fixture.a}`, { method: 'DELETE', status: 204 });
  console.log('PASS page PUT/create/replace, explicit unassignment, filters, nonempty conflict and stable move URL/body/mtime');

  await error('/api/entities', 400, { method: 'POST', body: { id: 'INVALID ID', name: 'Invalid' } });
  await error('/api/entities', 400, { method: 'POST', body: { id: fixture.empty, name: ' ' } });
  await error(`/api/entities/${fixture.missing}`, 404, { method: 'PATCH', body: { name: 'Missing' } });
  await error(`/api/entities/${fixture.missing}`, 404, { method: 'DELETE' });
  await error('/api/pages?entityId=INVALID', 400);
  await error(`/api/pages?entityId=${fixture.missing}`, 404);
  for (const [entityId, status] of [['INVALID', 400], [fixture.missing, 404]]) {
    await error(`/api/pages/${fixture.api}`, status, { method: 'PATCH', body: { entityId } });
    await error(`/api/pages/${fixture.rejected}`, status, { method: 'PUT', body: { html: document('Rejected', 'REJECTED'), entityId } });
  }
  await error(`/api/pages/${fixture.rejected}`, 404);
  await error(`/api/pages/${fixture.rejected}`, 404, { method: 'PATCH', body: { entityId: null } });
  await error('/api/entities', 400, { method: 'POST', raw: '{' });
  await error(`/api/entities/${fixture.b}`, 400, { method: 'PATCH', raw: '{' });
  await error(`/api/pages/${fixture.api}`, 400, { method: 'PATCH', raw: '{' });
  await error(`/api/pages/${fixture.api}`, 400, { method: 'PUT', raw: '{' });
  await error('/mcp', 400, { method: 'POST', raw: '{' });
  await error(`/api/pages/${fixture.rejected}`, 400, { method: 'PUT', render: true, body: { html: '<p>Not a document</p>' } });
  const rejected = await rpc('tools/call', { name: 'visual_explainer_render_html', arguments: {
    filename: fixture.rejected, html: document('Rejected', 'REJECTED'), entityId: fixture.missing,
  } }, { render: true });
  assert.equal(rejected.isError, true);
  assert.match(textContent(rejected), /Entity not found/);
  await error(`/api/pages/${fixture.rejected}`, 404);
  console.log('PASS malformed JSON, invalid/missing entities, missing pages and real renderer error results');

  await viewerChecks();
  await finalState();
  assert.deepEqual(await page(fixture.legacy, null), legacy, 'Legacy page metadata must remain untouched');
  assert.equal((await request(legacy.url, { auth: 'none' })).text, legacyBody, 'Legacy seeded page must remain byte-identical');
  console.log('PASS legacy preseed unchanged and complete final catalog state');
}

async function main() {
  assert.ok(process.argv.slice(2).every(arg => arg === '--persistence') && process.argv.length <= 3, 'Usage: node scripts/smoke.mjs [--persistence]');
  assert.ok(process.env.VE_BASE_URL, 'VE_BASE_URL is required');
  base = new URL(process.env.VE_BASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Smoke suite is restricted to isolated localhost instances');
  assert.equal(base.protocol, 'http:', 'Use HTTP for the isolated localhost smoke instance');
  assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'VE_BASE_URL must be a plain localhost origin');
  token = process.env.VE_TOKEN?.trim();
  assert.ok(token?.length >= 32, 'VE_TOKEN must contain at least 32 characters');
  viewerKey = createHmac('sha256', token).update('viewer-access').digest('hex');
  const health = await request('/health', { auth: 'none' });
  assert.equal(health.text, 'ok');
  if (process.argv.includes('--persistence')) {
    // Read-only: the process/container must have been restarted by the caller.
    await mcpReadChecks();
    await finalState();
    console.log('PASS restart persistence: renamed entity, two assignments, rendered pages, stable signed URLs and legacy page');
  } else {
    await fullSuite();
    console.log('PASS compatibility suite; restart this isolated server with the same data/token, then run --persistence');
  }
}

main().catch(cause => {
  let message = cause?.stack ?? String(cause);
  for (const secret of [token, viewerKey]) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
});
