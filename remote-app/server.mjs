import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema,
  ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { parse } from 'node-html-parser';
import { ApiError, canonicalFilename, createCatalog, logicalPath, pageFilename, sourceFilename, sourcePairs } from './catalog.mjs';
import { createHistory } from './history.mjs';
import { createTokens } from './tokens.mjs';

const publicUrl = new URL(process.env.PUBLIC_URL);
const outputDir = resolve(process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data');
const token = (await readFile(process.env.TOKEN_FILE ?? '/run/secrets/api_token', 'utf8')).trim();
if (token.length < 32) throw new Error('API token must contain at least 32 characters');
const upstreamDir = process.env.UPSTREAM_DIR ?? fileURLToPath(new URL('./node_modules/visual-explainer/', import.meta.url));
const bridgePackage = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const bridgeVersion = bridgePackage.version;
const instructions = 'Remote Visual Explainer; no LLM is called. Read visual-explainer://skill/SKILL.md and relevant resources/prompts, inspect your LOCAL project yourself, then send html and filename to visual_explainer_render_html. Do not send local paths or request a server-side browser window. Render results include a persistent browser URL. Anyone with a page URL can read that page; keep it private. Executable ve-flow models are disabled; use declarative data instead. Repository citation checks and video export require local project access and are not remote MCP tools.';
const galleryHtml = await readFile(new URL('./index.html', import.meta.url));
const cjkFont = await readFile(new URL('./static/cjk.woff2', import.meta.url));
const cjkLicense = await readFile(new URL('./static/LICENSE.fonts-wqy-zenhei', import.meta.url));
const viewerKey = createHmac('sha256', token).update('viewer-access').digest('hex');
const sessionLifetime = 7 * 24 * 60 * 60;
const catalog = await createCatalog(outputDir);
const tokens = await createTokens(outputDir, catalog);
const history = await createHistory(outputDir, catalog);
await catalog.run(() => history.snapshot('Snapshot existing pages'));

const sessionCookies = {
  admin: { name: 've_admin', context: 'admin-session' },
  viewer: { name: 've_reader', context: 'reader-session' },
  legacy: { name: 've_viewer', context: 'viewer-session' },
};
function sessionSignature(expires, kind) {
  return createHmac('sha256', token).update(`${sessionCookies[kind].context}:${expires}`).digest('hex');
}
function hasSession(req, kind) {
  const prefix = `${sessionCookies[kind].name}=`;
  const value = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix))?.slice(prefix.length);
  if (!value) return false;
  const [expires, sig] = value.split('.');
  const remaining = Number(expires) - Math.floor(Date.now() / 1000);
  return remaining > 0 && remaining <= sessionLifetime && equal(sig ?? '', sessionSignature(expires, kind));
}
function setSession(res, kind) {
  const expires = Math.floor(Date.now() / 1000) + sessionLifetime;
  const secure = publicUrl.protocol === 'https:' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [kind, ...Object.keys(sessionCookies).filter(role => role !== kind)].map(role => {
    const { name } = sessionCookies[role];
    return `${name}=${role === kind ? `${expires}.${sessionSignature(expires, kind)}` : ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${role === kind ? sessionLifetime : 0}${secure}`;
  }));
}
function identity(req) {
  if (req.headers.authorization) {
    if (equal(req.headers.authorization, `Bearer ${token}`)) return { role: 'admin', bearer: true };
    const match = req.headers.authorization.match(/^Bearer (.+)$/);
    const agent = match && tokens.authenticate(match[1]);
    if (agent) return agent;
    throw new ApiError(401, 'Authentication required');
  }
  if (hasSession(req, 'admin')) return { role: 'admin' };
  if (hasSession(req, 'viewer')) return { role: 'viewer' };
  if (hasSession(req, 'legacy')) return { role: 'admin', legacy: true };
  throw new ApiError(401, 'Authentication required');
}
function versionSignature(filename, revision) {
  return createHmac('sha256', token).update(`version:${filename}:${revision}`).digest('hex');
}
function versionUrl(filename, revision) {
  return new URL(`/versions/${versionSignature(filename, revision)}/${encodeURIComponent(filename)}/${revision}`, publicUrl).href;
}
function exposeVersion(filename, version) { return { ...version, url: versionUrl(filename, version.revision) }; }
function decodeSegment(value) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new ApiError(400, 'Invalid URL encoding'); }
  if (decoded.includes('/') || decoded.includes('\\') || decoded === '.' || decoded === '..' || /\p{Cc}/u.test(decoded)) throw new ApiError(400, 'Invalid URL segment');
  return decoded;
}
async function regularBytes(filename) {
  let handle;
  try {
    handle = await open(join(outputDir, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new ApiError(409, 'Expected a regular file');
    return await handle.readFile();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw new ApiError(409, 'File must not be a symlink');
    throw error;
  } finally { await handle?.close(); }
}
async function readSource(filename, rendering = false) {
  const pairs = sourcePairs(await readdir(outputDir));
  if (rendering) {
    const upstreamSource = filename.replace(/\.html?$/i, '.src.html');
    if ([...pairs].some(([page, sources]) => page !== filename && sources.includes(upstreamSource))) {
      throw new ApiError(409, 'Renderer source path belongs to another page');
    }
  }
  return await regularBytes(pairs.get(filename)?.[0] ?? sourceFilename(filename));
}
async function saveSource(filename, bytes) {
  const path = join(outputDir, sourceFilename(filename)), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => console.error('Source temporary cleanup failed')); }
}
async function readPage(filename) {
  let handle;
  try {
    handle = await open(join(outputDir, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(16384, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const title = parse(buffer.subarray(0, bytesRead).toString('utf8')).querySelector('title')?.textContent.trim() || filename;
    return { filename, title, modified: info.mtime.toISOString(), bytes: info.size, url: pageUrl(filename), ...catalog.location(filename) };
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  } finally { await handle?.close(); }
}

async function requirePage(filename) {
  pageFilename(filename);
  const page = await readPage(filename);
  if (!page) throw new ApiError(404, 'Page not found');
  return page;
}

// Called inside the catalog queue, like rendering and moves. Only exact owned
// flat files are staged; no directory, generic image, font or credential is a target.
async function deletePage(filename) {
  pageFilename(filename);
  const names = await readdir(outputDir);
  const companions = sourcePairs(names).get(filename) ?? [];
  const stem = filename.replace(/\.html?$/i, '');
  const sheetPattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.sheet(?:-\\d+)?\\.png$`);
  const sheets = names.filter(name => sheetPattern.test(name));
  const owners = entries => entries.filter(name => !/\.src\.html?$/i.test(name) &&
    /\.html?$/i.test(name) && name.replace(/\.html?$/i, '') === stem);
  const files = [];
  for (const name of [filename, ...companions, ...sheets]) {
    const info = await lstat(join(outputDir, name)).catch(error => {
      if (error.code === 'ENOENT') throw new ApiError(name === filename ? 404 : 409, name === filename ? 'Page not found' : 'Page files changed; refresh and retry');
      throw error;
    });
    if (!info.isFile() || info.isSymbolicLink()) throw new ApiError(409, 'Page files must be regular files, not symlinks');
    files.push({ name, info });
  }
  if (sheets.length && owners(names).length > 1) {
    throw new ApiError(409, 'Render sheets have multiple possible page owners');
  }
  // Direct filesystem edits may not yet be in Git. Preserve the exact old HTML
  // and source before removing anything; identical snapshots make no new commit.
  await history.snapshot(`Snapshot before deleting page ${filename}`);
  const currentNames = await readdir(outputDir);
  if (JSON.stringify(companions) !== JSON.stringify(sourcePairs(currentNames).get(filename) ?? []) ||
      JSON.stringify(sheets) !== JSON.stringify(currentNames.filter(name => sheetPattern.test(name))) ||
      JSON.stringify(owners(names)) !== JSON.stringify(owners(currentNames))) {
    throw new ApiError(409, 'Page file ownership changed; refresh and retry');
  }
  const staging = await mkdtemp(join(outputDir, '.delete-'));
  const moved = [];
  try {
    for (const { name, info } of files) {
      const current = await lstat(join(outputDir, name));
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino ||
          current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) {
        throw new ApiError(409, 'Page files changed; refresh and retry');
      }
      await rename(join(outputDir, name), join(staging, name));
      moved.push(name);
    }
    await catalog.forgetPage(filename);
  } catch (error) {
    // A filesystem/catalog failure restores staged originals. A Git failure below
    // follows the existing local-first contract instead of rolling back content.
    try {
      for (const name of moved.reverse()) {
        const occupied = await lstat(join(outputDir, name)).catch(failure => {
          if (failure.code === 'ENOENT') return null;
          throw failure;
        });
        if (occupied) throw new Error('Cannot overwrite a file created during deletion');
        await rename(join(staging, name), join(outputDir, name));
      }
      await rm(staging, { recursive: true });
    } catch (recovery) {
      console.error('Page deletion rollback failed', { code: recovery.code });
      throw new ApiError(500, 'Deletion failed and could not be fully rolled back. Preserve the data directory for recovery.');
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, 'Deletion failed; original page files were restored.');
  }
  try {
    await history.snapshot(`Delete page ${filename}`);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 503) throw error;
    throw new ApiError(503, 'Diagram deleted, but Git history synchronization failed. Previous snapshots and local commits are preserved. Refresh the library; the next mutation or restart retries synchronization.');
  } finally {
    // These are transient rollback files, not a trash/undelete feature. Failure is
    // surfaced rather than claiming a completely cleaned deletion.
    await rm(staging, { recursive: true }).catch(error => {
      console.error('Page deletion temporary cleanup failed', { code: error.code });
      throw new ApiError(500, 'Diagram deleted, but temporary file cleanup failed. Preserve the data directory for recovery.');
    });
  }
}

async function listPages() {
  const pages = [];
  for (const entry of await readdir(outputDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.html?$/i.test(entry.name) || /\.src\.html?$/i.test(entry.name)) continue;
    const page = await readPage(entry.name);
    if (page) pages.push(page);
  }
  return pages.sort((a, b) => b.modified.localeCompare(a.modified));
}

async function requireRootNameFree(name, exceptFilename = null) {
  if ((await listPages()).some(page => page.entityId === null && page.filename !== exceptFilename && page.path === name)) {
    throw new ApiError(409, 'Destination already exists');
  }
}

function equal(a, b) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function signature(filename) {
  return createHmac('sha256', token).update(`page:${filename}`).digest('hex');
}
function pageUrl(filename) {
  return new URL(`/pages/${signature(filename)}/${encodeURIComponent(filename)}`, publicUrl).href;
}
function send(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}
function json(res, status, body) {
  return send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

async function readBody(req, limit, raw = false) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
    req.resume();
    throw new ApiError(413, 'Request too large');
  }
  const chunks = [];
  let size = 0;
  try {
    // Returning early must not destroy the socket before the JSON error is sent.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limit) throw new ApiError(413, 'Request too large');
      chunks.push(chunk);
    }
  } catch (error) {
    req.resume();
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Incomplete request body');
  }
  const bytes = Buffer.concat(chunks, size);
  return raw ? bytes : bytes.toString('utf8');
}

async function readJson(req, limit) {
  let body;
  try { body = JSON.parse(await readBody(req, limit)); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Invalid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Expected a JSON object');
  return body;
}

function fields(body, allowed, required) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(body, key))) {
    throw new ApiError(400, `Expected fields: ${required.join(', ')}`);
  }
}

function withCount(entity, pages) {
  return { ...entity, diagramCount: pages.filter(page => catalog.inScope(entity.id, page.entityId)).length };
}
function scopedPage(page, id) {
  return { ...page, entityId: id, path: catalog.relative(id, page.entityId, page.path) };
}

// Run the unmodified official package's stdio server; one process multiplexes independent MCP calls.
const upstream = new Client({ name: 'visual-explainer-webui-bridge', version: bridgeVersion });
let stopping = false;
upstream.onclose = () => { if (!stopping) process.exit(1); };
await upstream.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(upstreamDir, 'plugins/visual-explainer/mcp/server.mjs')],
  cwd: upstreamDir,
  env: {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers',
    VISUAL_EXPLAINER_OUTPUT_DIR: outputDir,
    VISUAL_EXPLAINER_RUN_MODELS: '0',
  },
  stderr: 'inherit',
}));

// Only documents actually registered by this same renderer process are HTTP-readable.
// Paths are resource identifiers, never filesystem inputs.
const originalPrefix = '/api/visual-explainer';
const [originalResources, originalPrompts, originalTools] = await Promise.all([
  upstream.listResources(), upstream.listPrompts(), upstream.listTools(),
]);
const originalDocuments = new Map(originalResources.resources.flatMap(resource => {
  const path = resource.uri === 'visual-explainer://skill/SKILL.md' ? '/SKILL.md'
    : /^visual-explainer:\/\/(?:references|commands)\/[a-z0-9-]+\.md$/.test(resource.uri) || resource.uri === 'visual-explainer://kit/kit.css'
      ? resource.uri.replace('visual-explainer://', '/') : null;
  return path ? [[path, resource]] : [];
}));
const originalPromptNames = new Set(originalPrompts.prompts.map(prompt => prompt.name));
const originalSource = bridgePackage.dependencies['visual-explainer'];
const originalRevision = originalSource.match(/\/([a-f0-9]{40})$/)?.[1];
if (!originalRevision || !originalDocuments.has('/SKILL.md')) throw new Error('Expected pinned official visual-explainer resources');
const originalIndex = {
  package: { name: 'visual-explainer', version: upstream.getServerVersion().version, revision: originalRevision, source: originalSource },
  resources: [...originalDocuments].map(([path, resource]) => ({ ...resource, url: new URL(originalPrefix + path, publicUrl).href })),
  prompts: originalPrompts.prompts.map(prompt => ({ ...prompt, url: new URL(`${originalPrefix}/prompts/${encodeURIComponent(prompt.name)}`, publicUrl).href })),
  tools: originalTools.tools,
  prepareUrl: new URL(`${originalPrefix}/prepare`, publicUrl).href,
  publish: { method: 'PUT', path: '/api/entities/:id/files/<path>.html', contentType: 'text/html; charset=utf-8' },
};
function originalReadonly(parts, method) {
  return parts[0] === 'visual-explainer' && (method === 'GET' || (method === 'POST' &&
    ((parts.length === 2 && parts[1] === 'prepare') || (parts.length === 3 && parts[1] === 'prompts'))));
}
async function originalRequest(call) {
  try { return await call(); }
  catch (error) { throw new ApiError(502, `Official visual-explainer request failed: ${error.message}`); }
}
async function serveOriginal(req, res, parts) {
  if (parts.length === 1 && req.method === 'GET') return json(res, 200, originalIndex);
  if (req.method === 'GET') {
    const resource = originalDocuments.get('/' + parts.slice(1).join('/'));
    if (resource) {
      const result = await originalRequest(() => upstream.readResource({ uri: resource.uri }));
      if (result.contents.length !== 1 || typeof result.contents[0].text !== 'string') throw new ApiError(502, 'Official resource did not return one text document');
      return send(res, 200, result.contents[0].text, `${resource.mimeType}; charset=utf-8`);
    }
  }
  if (parts.length === 2 && parts[1] === 'prepare' && req.method === 'POST') {
    const args = await readJson(req, 65536);
    return json(res, 200, await originalRequest(() => upstream.callTool({ name: 'visual_explainer_prepare', arguments: args })));
  }
  if (parts.length === 3 && parts[1] === 'prompts' && req.method === 'POST') {
    if (!originalPromptNames.has(parts[2])) throw new ApiError(404, 'Official prompt not found');
    const args = await readJson(req, 65536);
    return json(res, 200, await originalRequest(() => upstream.getPrompt({ name: parts[2], arguments: args })));
  }
  throw new ApiError(404, 'Official resource or endpoint not found');
}

async function renderLocked(args, apiFilename = false, params = { name: 'visual_explainer_render_html' }, location = null, sourceBytes = null) {
  fields(args, ['filename', 'html', 'entityId'], ['filename', 'html']);
  if (typeof args.filename !== 'string' || typeof args.html !== 'string' || !args.html.length) throw new ApiError(400, 'Send filename and nonempty html strings');
  if (apiFilename) canonicalFilename(args.filename);
  if (Object.hasOwn(args, 'entityId') && args.entityId !== null) catalog.entity(args.entityId);
  // Mirror upstream's documented basename normalization only to preflight
  // collisions before it writes. The returned guarded path remains authoritative.
  let predicted = args.filename.replace(/^@/, '').trim();
  if (predicted.includes('/') || predicted.includes('\\') || /\p{Cc}/u.test(predicted) || !predicted) throw new ApiError(400, 'filename must be a nonempty basename');
  if (!/\.html?$/i.test(predicted)) predicted += '.html';
  predicted = predicted.replace(/\.src(\.html?)$/i, '$1');
  pageFilename(predicted);
  const before = await readPage(predicted);
  const assigned = location ? location.entityId : (Object.hasOwn(args, 'entityId') ? args.entityId : catalog.assignment(predicted));
  const logical = location?.path ?? (assigned === null && catalog.assignment(predicted) !== null ? predicted : catalog.location(predicted).path);
  if (!before) logicalPath(logical, true);
  if (assigned === null) await requireRootNameFree(logical, predicted);
  catalog.validateLocation(predicted, assigned, logical);
  await readSource(predicted, true);
  const result = await upstream.callTool({ ...params, arguments: { filename: predicted, html: args.html, open: false } }, undefined, { timeout: 180000 });
  if (result.isError) return { render: result };
  const path = result.structuredContent?.path;
  if (typeof path !== 'string' || resolve(path) !== join(outputDir, basename(path))) throw new Error('Upstream returned a path outside the output directory');
  const filename = pageFilename(basename(path));
  if (filename !== predicted || (apiFilename && filename !== args.filename)) throw new Error('Upstream changed the expected output filename');
  await readSource(filename);
  await saveSource(filename, sourceBytes ?? Buffer.from(args.html));
  await catalog.assign(filename, assigned, logical);
  const revision = await history.snapshot(`Publish page ${filename}`);
  const page = await requirePage(filename);
  result.structuredContent = { ...result.structuredContent, url: page.url, entityId: assigned };
  result.content.push({ type: 'text', text: `View: ${page.url}\nThis link grants read access to this page. Reusing the filename replaces it; use unique filenames for immutable reports.` });
  return { page, render: result, created: !before, revision };
}
function renderHtml(args, apiFilename = false, params = { name: 'visual_explainer_render_html' }) {
  return catalog.run(() => renderLocked(args, apiFilename, params));
}
function requireRender(result) {
  if (result.render.isError) throw new ApiError(400, result.render.content.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Rendering failed');
  return result;
}

function proxyServer() {
  const server = new Server({ name: 'visual-explainer-webui', version: bridgeVersion }, {
    capabilities: { tools: {}, resources: {}, prompts: {} }, instructions,
  });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await upstream.listTools(request.params);
    return { ...result, tools: result.tools.map((tool) => {
      if (tool.name !== 'visual_explainer_render_html') return tool;
      return {
        ...tool,
        description: 'Render complete HTML or visual-explainer page source on TrueNAS and return a persistent browser URL. Send html, not a local filesystem path. No LLM; executable models disabled.',
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: {
            filename: tool.inputSchema.properties.filename,
            html: tool.inputSchema.properties.html,
            entityId: { type: ['string', 'null'], description: 'Optional entity slug; omit to preserve the existing assignment, null to unassign.' },
          },
          required: ['filename', 'html'],
        },
        outputSchema: {
          ...tool.outputSchema,
          properties: { ...tool.outputSchema.properties, url: { type: 'string', format: 'uri' }, entityId: { type: ['string', 'null'] } },
        },
      };
    }) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params;
    if (params.name === 'visual_explainer_render_html') {
      try { return (await renderHtml(params.arguments ?? {}, false, params)).render; }
      catch (error) {
        if (!(error instanceof ApiError)) console.error(error);
        return { isError: true, content: [{ type: 'text', text: error instanceof ApiError ? error.message : 'Unable to render and persist page assignment' }] };
      }
    }
    const result = await upstream.callTool(params, undefined, { timeout: 180000 });
    if (params.name === 'visual_explainer_prepare' && !result.isError) {
      result.content.push({ type: 'text', text: instructions });
    }
    return result;
  });
  server.setRequestHandler(ListResourcesRequestSchema, (request) => upstream.listResources(request.params));
  server.setRequestHandler(ReadResourceRequestSchema, (request) => upstream.readResource(request.params));
  server.setRequestHandler(ListPromptsRequestSchema, (request) => upstream.listPrompts(request.params));
  server.setRequestHandler(GetPromptRequestSchema, (request) => upstream.getPrompt(request.params));
  return server;
}

const http = createServer(async (req, res) => {
  try {
    // Validate the raw request path before URL removes dot segments or backslashes.
    const rawPath = req.url.split('?')[0];
    if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) throw new ApiError(400, 'Invalid request path');
    rawPath.split('/').slice(1).forEach(decodeSegment);
    const url = new URL(req.url, publicUrl);
    if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, 'ok');
    if (req.headers.host !== publicUrl.host) {
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') throw new ApiError(403, 'Unexpected Host');
      return send(res, 403, 'Unexpected Host');
    }
    if (url.pathname.startsWith('/pages/') && ['GET', 'HEAD'].includes(req.method)) {
      const parts = url.pathname.split('/');
      if (parts.length !== 4) return send(res, 404, 'Not found');
      const filename = decodeSegment(parts[3]);
      if (basename(filename) !== filename || filename.includes('\\') || filename.includes('..') ||
          /[\x00-\x1f\x7f]/.test(filename) || !/\.html?$/i.test(filename) ||
          !equal(parts[2], signature(filename))) return send(res, 404, 'Not found');
      const bytes = await regularBytes(filename).catch(error => {
        if (error instanceof ApiError && error.status === 409) return null;
        throw error;
      });
      if (bytes === null) return send(res, 404, 'Not found');
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts; frame-ancestors \'self\'');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return send(res, 200, req.method === 'HEAD' ? '' : bytes, 'text/html; charset=utf-8');
    }
    if (url.pathname.startsWith('/versions/') && ['GET', 'HEAD'].includes(req.method)) {
      const parts = url.pathname.split('/');
      if (parts.length !== 5) throw new ApiError(404, 'Not found');
      const filename = pageFilename(decodeSegment(parts[3])), revision = parts[4];
      if (!equal(parts[2], versionSignature(filename, revision))) throw new ApiError(404, 'Not found');
      return await catalog.run(async () => {
        const saved = await history.version(filename, revision);
        res.setHeader('Content-Security-Policy', 'sandbox allow-scripts; frame-ancestors \'self\'');
        res.setHeader('Referrer-Policy', 'no-referrer');
        return send(res, 200, req.method === 'HEAD' ? '' : saved.rendered, 'text/html; charset=utf-8');
      });
    }
    if (['/assets/cjk.woff2', '/assets/cjk-license'].includes(url.pathname) && ['GET', 'HEAD'].includes(req.method)) {
      const font = url.pathname.endsWith('.woff2');
      res.writeHead(200, {
        'Content-Type': font ? 'font/woff2' : 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(req.method === 'HEAD' ? '' : font ? cjkFont : cjkLicense);
    }
    if (url.pathname === '/' && req.method === 'GET') {
      if (url.searchParams.has('access')) {
        if (!equal(url.searchParams.get('access'), viewerKey)) return send(res, 403, 'Invalid viewer access link');
        setSession(res, hasSession(req, 'admin') || hasSession(req, 'legacy') ? 'admin' : 'viewer');
        res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end();
      }
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.setHeader('Referrer-Policy', 'no-referrer');
      return send(res, 200, galleryHtml, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Unexpected Origin');
      const key = new URLSearchParams(await readBody(req, 1024)).get('key') ?? '';
      if (!equal(key, token)) throw new ApiError(401, '登录密钥不正确');
      setSession(res, 'admin');
      return send(res, 200, 'ok');
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      if (req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Unexpected Origin');
      res.setHeader('Set-Cookie', Object.values(sessionCookies).map(({ name }) => `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${publicUrl.protocol === 'https:' ? '; Secure' : ''}`));
      return send(res, 200, 'ok');
    }
    if (url.pathname.startsWith('/api/')) {
      return await catalog.run(async () => {
        const auth = identity(req);
        const parts = url.pathname.split('/').slice(2).map(decodeSegment);
        const originalRead = originalReadonly(parts, req.method);
        const mutation = !['GET', 'HEAD'].includes(req.method) && !originalRead;
        if (req.headers.origin && req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Unexpected Origin');
        if (mutation && auth.role === 'viewer') throw new ApiError(401, 'Admin authentication required');
        if (mutation && auth.role === 'admin' && !auth.bearer && req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Same-origin Origin required');
        const [resource, id, action] = parts;
        if (resource === 'session' && parts.length === 1 && req.method === 'GET') {
          if (auth.legacy) setSession(res, 'admin');
          return json(res, 200, { role: auth.role, ...(auth.entityId ? { entityId: auth.entityId } : {}) });
        }
        if (auth.role === 'agent') {
          const scoped = resource === 'entities' && id === auth.entityId &&
            ((action === 'tree' && parts.length === 3 && req.method === 'GET') ||
             (action === 'folders' && parts.length === 3 && ['POST', 'PATCH', 'DELETE'].includes(req.method)) ||
             (action === 'files' && parts.length >= 4 && ['GET', 'PUT', 'PATCH'].includes(req.method)));
          const ownHistory = resource === 'pages' &&
            ((action === 'versions' && [3, 4].includes(parts.length) && req.method === 'GET') ||
             (action === 'restore' && parts.length === 3 && req.method === 'POST'));
          if (!scoped && !ownHistory && !originalRead) throw new ApiError(403, 'Entity-scoped access only');
          if (ownHistory && !catalog.inScope(auth.entityId, catalog.assignment(id))) throw new ApiError(403, 'Page is outside current folder scope');
        }
        if (resource === 'visual-explainer') return serveOriginal(req, res, parts);
        if (resource === 'moves' && parts.length === 1 && req.method === 'POST') {
          const body = await readJson(req, 8192); fields(body, ['source', 'destination', 'name'], ['source', 'destination']);
          if (!body.source || !body.destination) throw new ApiError(400, 'Source and destination required');
          fields(body.destination, ['entityId', 'path'], ['entityId', 'path']);
          if (body.source.kind === 'page') {
            fields(body.source, ['kind', 'filename'], ['kind', 'filename']);
            await requirePage(body.source.filename);
          } else fields(body.source, ['kind', 'entityId', 'path'], ['kind', 'entityId', 'path']);
          if (!['page', 'folder'].includes(body.source.kind)) throw new ApiError(400, 'Invalid move kind');
          if (body.destination.entityId === null) {
            const from = body.source.kind === 'page' ? catalog.location(body.source.filename) : catalog.resolve(body.source.entityId, body.source.path);
            const sourceName = from.path ? from.path.split('/').at(-1) : catalog.entity(from.entityId).name;
            await requireRootNameFree(body.name ?? sourceName, body.source.kind === 'page' ? body.source.filename : null);
          }
          const move = await catalog.move(body.source, body.destination, body.name);
          if (move.moved) await history.snapshot('Organize library');
          return json(res, 200, { move });
        }
        if (resource === 'tree' && parts.length === 1 && req.method === 'GET') {
          const pages = await listPages();
          return json(res, 200, {
            entities: catalog.entities().map(entity => withCount(entity, pages)),
            folders: catalog.entities().flatMap(entity => catalog.folders(entity.id).map(folder => ({ entityId: entity.id, ...folder }))),
            pages, unassignedCount: pages.filter(page => page.entityId === null).length, totalCount: pages.length,
          });
        }
        if (resource === 'entities' && parts.length === 1 && req.method === 'GET') {
          const pages = await listPages();
          return json(res, 200, { entities: catalog.entities().map(entity => withCount(entity, pages)),
            unassignedCount: pages.filter(page => page.entityId === null).length, totalCount: pages.length });
        }
        if (resource === 'entities' && parts.length === 1 && req.method === 'POST') {
          const body = await readJson(req, 4096); fields(body, ['id', 'name'], ['name']);
          await requireRootNameFree(typeof body.name === 'string' ? body.name.trim() : body.name);
          const entity = await catalog.create(body.id, body.name);
          await history.snapshot(`Create entity ${entity.id}`);
          return json(res, 201, { entity: withCount(entity, await listPages()) });
        }
        if (resource === 'entities' && parts.length === 2 && req.method === 'PATCH') {
          const body = await readJson(req, 4096); fields(body, ['name'], ['name']);
          if (!catalog.entity(id).parent) await requireRootNameFree(typeof body.name === 'string' ? body.name.trim() : body.name);
          const entity = await catalog.rename(id, body.name);
          await history.snapshot(`Rename entity ${id}`);
          return json(res, 200, { entity: withCount(entity, await listPages()) });
        }
        if (resource === 'entities' && parts.length === 2 && req.method === 'DELETE') {
          catalog.entity(id);
          const pages = await listPages();
          if (pages.some(page => catalog.inScope(id, page.entityId)) || catalog.scopeFolders(id).length) throw new ApiError(409, 'Entity is not empty');
          // Revoke first: a partial failure can never leave live keys to a removed Entity.
          await tokens.revokeEntity(id);
          await catalog.remove(id, pages);
          await history.snapshot(`Delete entity ${id}`);
          return send(res, 204, '');
        }
        if (resource === 'entities' && action === 'tree' && parts.length === 3 && req.method === 'GET') {
          catalog.entity(id);
          return json(res, 200, { folders: catalog.scopeFolders(id),
            pages: (await listPages()).filter(page => catalog.inScope(id, page.entityId)).map(page => scopedPage(page, id))
              .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
        }
        if (resource === 'entities' && action === 'folders' && parts.length === 3) {
          if (req.method === 'POST') {
            const body = await readJson(req, 4096); fields(body, ['path'], ['path']);
            const folder = await catalog.createFolder(id, body.path);
            await history.snapshot(`Create folder in ${id}`);
            return json(res, 201, { folder });
          }
          if (req.method === 'PATCH') {
            const body = await readJson(req, 4096); fields(body, ['path', 'newPath'], ['path', 'newPath']);
            const move = await catalog.moveFolder(id, body.path, body.newPath);
            await history.snapshot(`Move folder in ${id}`);
            return json(res, 200, { folder: { path: body.newPath }, move });
          }
          if (req.method === 'DELETE') {
            await catalog.removeFolder(id, url.searchParams.get('path'));
            await history.snapshot(`Delete empty folder in ${id}`);
            return send(res, 204, '');
          }
        }
        if (resource === 'entities' && action === 'tokens') {
          if (auth.role !== 'admin') throw new ApiError(auth.role === 'viewer' && mutation ? 401 : 403, 'Admin authentication required');
          if (parts.length === 3 && req.method === 'GET') return json(res, 200, { tokens: tokens.list(id) });
          if (parts.length === 3 && req.method === 'POST') {
            const body = await readJson(req, 4096); fields(body, ['name', 'expiresIn'], []);
            return json(res, 201, await tokens.create(id, body.name, body.expiresIn));
          }
          if (parts.length === 4 && req.method === 'PATCH') {
            const body = await readJson(req, 4096); fields(body, ['expiresIn'], ['expiresIn']);
            return json(res, 200, await tokens.setExpiry(id, parts[3], body.expiresIn));
          }
          if (parts.length === 4 && req.method === 'DELETE') { await tokens.revoke(id, parts[3]); return send(res, 204, ''); }
        }
        if (resource === 'entities' && action === 'files' && parts.length >= 4) {
          catalog.entity(id);
          const path = logicalPath(parts.slice(3).join('/'), true);
          const filename = catalog.find(id, path);
          const location = catalog.fileLocation(id, path);
          if (req.method === 'GET') {
            if (!filename) throw new ApiError(404, 'File not found');
            await requirePage(filename);
            const bytes = await readSource(filename) ?? await regularBytes(filename);
            res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
            res.setHeader('Content-Disposition', 'attachment');
            res.setHeader('Referrer-Policy', 'no-referrer');
            return send(res, 200, bytes, 'text/html; charset=utf-8');
          }
          if (req.method === 'PUT') {
            if (!/^text\/html(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'Use Content-Type: text/html; charset=utf-8');
            const bytes = await readBody(req, 12 * 1024 * 1024, true);
            let html;
            try { html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
            catch { throw new ApiError(400, 'HTML must be valid UTF-8'); }
            const physical = filename ?? `${randomUUID()}.html`;
            const result = requireRender(await renderLocked({ filename: physical, html }, true, undefined, location, bytes));
            return json(res, filename ? 200 : 201, { page: scopedPage(result.page, id), revision: result.revision, render: result.render });
          }
          if (req.method === 'PATCH') {
            if (!filename) throw new ApiError(404, 'File not found');
            await requirePage(filename);
            const body = await readJson(req, 4096); fields(body, ['path'], ['path']);
            logicalPath(body.path, true);
            const target = catalog.fileLocation(id, body.path);
            await catalog.assign(filename, target.entityId, target.path);
            await history.snapshot(`Move page ${filename}`);
            return json(res, 200, { page: scopedPage(await requirePage(filename), id) });
          }
        }
        if (resource === 'pages' && parts.length === 1 && req.method === 'GET') {
          const filter = url.searchParams.get('entityId');
          if (filter !== null && filter !== '') catalog.entity(filter);
          const pages = await listPages();
          return json(res, 200, { pages: filter === null ? pages : pages.filter(page => filter ? catalog.inScope(filter, page.entityId) : page.entityId === null) });
        }
        if (resource === 'pages' && action === 'versions' && [3, 4].includes(parts.length) && req.method === 'GET') {
          await requirePage(id);
          const entity = auth.role === 'agent' ? auth.entityId : undefined;
          if (parts.length === 3) return json(res, 200, { versions: (await history.versions(id, entity)).map(version => exposeVersion(id, version)) });
          const saved = await history.version(id, parts[3], entity);
          return json(res, 200, { version: exposeVersion(id, saved.version), html: saved.html });
        }
        if (resource === 'pages' && action === 'restore' && parts.length === 3 && req.method === 'POST') {
          const page = await requirePage(id);
          const body = await readJson(req, 4096); fields(body, ['revision'], ['revision']);
          const saved = await history.version(id, body.revision, auth.role === 'agent' ? auth.entityId : undefined);
          const result = requireRender(await renderLocked({ filename: id, html: saved.html }, true, undefined, { entityId: page.entityId, path: page.path }));
          return json(res, 200, { page: result.page, revision: result.revision });
        }
        if (resource === 'pages' && parts.length === 2 && req.method === 'GET') return json(res, 200, { page: await requirePage(id) });
        if (resource === 'pages' && parts.length === 2 && req.method === 'DELETE') {
          if (auth.role !== 'admin') throw new ApiError(403, 'Admin authentication required');
          await deletePage(id);
          return send(res, 204, '');
        }
        if (resource === 'pages' && parts.length === 2 && req.method === 'PATCH') {
          await requirePage(id);
          const body = await readJson(req, 4096); fields(body, ['entityId', 'path'], ['entityId']);
          const path = body.path ?? (body.entityId === null ? id : catalog.location(id).path);
          const target = body.entityId === null ? { entityId: null, path } : catalog.fileLocation(body.entityId, path);
          if (target.entityId === null) await requireRootNameFree(target.path, id);
          await catalog.assign(id, target.entityId, target.path);
          await history.snapshot(`Move page ${id}`);
          return json(res, 200, { page: await requirePage(id) });
        }
        if (resource === 'pages' && parts.length === 2 && req.method === 'PUT') {
          canonicalFilename(id);
          const body = await readJson(req, 12 * 1024 * 1024); fields(body, ['html', 'entityId'], ['html']);
          const result = requireRender(await renderLocked({ ...body, filename: id }, true));
          return json(res, result.created ? 201 : 200, { page: result.page, render: result.render, revision: result.revision });
        }
        throw new ApiError(404, 'Not found');
      });
    }
    if (url.pathname !== '/mcp') return send(res, 404, 'Not found');
    if (!equal(req.headers.authorization ?? '', `Bearer ${token}`)) {
      const match = req.headers.authorization?.match(/^Bearer (.+)$/);
      throw new ApiError(match && tokens.authenticate(match[1]) ? 403 : 401, 'Service Bearer token required');
    }
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Unexpected Origin');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new ApiError(405, 'Use stateless MCP POST'); }
    const body = await readJson(req, 12 * 1024 * 1024);
    const server = proxyServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(console.error); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    if (!(error instanceof ApiError)) console.error(error);
    if (!res.headersSent) {
      const status = error instanceof ApiError ? error.status : 500;
      const message = error instanceof ApiError ? error.message : 'Internal server error';
      if (req.url?.startsWith('/api/') || req.url?.startsWith('/mcp')) json(res, status, { error: message });
      else send(res, status, message);
    }
    else res.end();
  }
});
http.requestTimeout = 180000;
http.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log(`Visual Explainer ready: ${publicUrl.origin}/mcp`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  stopping = true;
  http.close();
  await upstream.close();
  process.exit(0);
});
