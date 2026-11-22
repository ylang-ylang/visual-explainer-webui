import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, lstat, readdir, open } from 'node:fs/promises';
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
import { ApiError, canonicalFilename, createCatalog, pageFilename } from './catalog.mjs';
import { createHistory } from './history.mjs';

const publicUrl = new URL(process.env.PUBLIC_URL);
const outputDir = resolve(process.env.VISUAL_EXPLAINER_OUTPUT_DIR ?? '/data');
const token = (await readFile(process.env.TOKEN_FILE ?? '/run/secrets/api_token', 'utf8')).trim();
if (token.length < 32) throw new Error('API token must contain at least 32 characters');
const upstreamDir = process.env.UPSTREAM_DIR ?? fileURLToPath(new URL('./node_modules/visual-explainer/', import.meta.url));
const bridgeVersion = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version;
const instructions = 'Remote Visual Explainer; no LLM is called. Read visual-explainer://skill/SKILL.md and relevant resources/prompts, inspect your LOCAL project yourself, then send html and filename to visual_explainer_render_html. Do not send local paths or request a server-side browser window. Render results include a persistent browser URL. Anyone with a page URL can read that page; keep it private. Executable ve-flow models are disabled; use declarative data instead. Repository citation checks and video export require local project access and are not remote MCP tools.';
const galleryHtml = await readFile(new URL('./index.html', import.meta.url));
const cjkFont = await readFile(new URL('./static/cjk.woff2', import.meta.url));
const cjkLicense = await readFile(new URL('./static/LICENSE.fonts-wqy-zenhei', import.meta.url));
const viewerKey = createHmac('sha256', token).update('viewer-access').digest('hex');
const sessionLifetime = 7 * 24 * 60 * 60;
const catalog = await createCatalog(outputDir);
const history = await createHistory(outputDir, catalog);
await catalog.run(() => history.snapshot('Snapshot existing pages'));

function sessionSignature(expires) {
  return createHmac('sha256', token).update(`viewer-session:${expires}`).digest('hex');
}
function viewerSession(req) {
  const value = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith('ve_viewer='))?.slice(10);
  if (!value) return false;
  const [expires, sig] = value.split('.');
  const remaining = Number(expires) - Math.floor(Date.now() / 1000);
  return remaining > 0 && remaining <= sessionLifetime && equal(sig ?? '', sessionSignature(expires));
}
function setViewerSession(res) {
  const expires = Math.floor(Date.now() / 1000) + sessionLifetime;
  res.setHeader('Set-Cookie', `ve_viewer=${expires}.${sessionSignature(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime}${publicUrl.protocol === 'https:' ? '; Secure' : ''}`);
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
    return { filename, title, modified: info.mtime.toISOString(), bytes: info.size, url: pageUrl(filename), entityId: catalog.assignment(filename) };
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

async function listPages() {
  const pages = [];
  for (const entry of await readdir(outputDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.html?$/i.test(entry.name) || /\.src\.html?$/i.test(entry.name)) continue;
    const page = await readPage(entry.name);
    if (page) pages.push(page);
  }
  return pages.sort((a, b) => b.modified.localeCompare(a.modified));
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

async function readBody(req, limit) {
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
  return Buffer.concat(chunks, size).toString('utf8');
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
  if (Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(body, key))) {
    throw new ApiError(400, `Expected fields: ${required.join(', ')}`);
  }
}

function withCount(entity, pages) {
  return { ...entity, diagramCount: pages.filter(page => page.entityId === entity.id).length };
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

function renderHtml(args, apiFilename = false, params = { name: 'visual_explainer_render_html' }) {
  return catalog.run(async () => {
    fields(args, ['filename', 'html', 'entityId'], ['filename', 'html']);
    if (typeof args.filename !== 'string' || typeof args.html !== 'string' || !args.html.length) {
      throw new ApiError(400, 'Send filename and nonempty html strings');
    }
    if (apiFilename) canonicalFilename(args.filename);
    if (Object.hasOwn(args, 'entityId') && args.entityId !== null) catalog.entity(args.entityId);
    // The renderer normalizes @, whitespace, extensions and kit source names.
    // Assign its actual guarded output, never the caller's unnormalized input.
    const existingFiles = new Set((await readdir(outputDir, { withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => entry.name));
    const result = await upstream.callTool({
      ...params,
      arguments: { filename: args.filename, html: args.html, open: false },
    }, undefined, { timeout: 180000 });
    if (result.isError) return { render: result };
    const path = result.structuredContent?.path;
    if (typeof path !== 'string' || resolve(path) !== join(outputDir, basename(path))) {
      throw new Error('Upstream returned a path outside the output directory');
    }
    const filename = pageFilename(basename(path));
    if (apiFilename && filename !== args.filename) throw new Error('Upstream changed the API output filename');
    const page = await requirePage(filename);
    const assigned = Object.hasOwn(args, 'entityId') ? args.entityId : existingFiles.has(filename) ? catalog.assignment(filename) : null;
    await catalog.assign(filename, assigned);
    await history.snapshot(`Publish page ${filename}`);
    page.entityId = assigned;
    result.structuredContent = { ...result.structuredContent, url: page.url, entityId: assigned };
    result.content.push({ type: 'text', text: `View: ${page.url}\nThis link grants read access to this page. Reusing the filename replaces it; use unique filenames for immutable reports.` });
    return { page, render: result, created: !existingFiles.has(filename) };
  });
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
    const url = new URL(req.url, publicUrl);
    if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, 'ok');
    if (req.headers.host !== publicUrl.host) {
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') throw new ApiError(403, 'Unexpected Host');
      return send(res, 403, 'Unexpected Host');
    }
    if (url.pathname.startsWith('/pages/') && ['GET', 'HEAD'].includes(req.method)) {
      const parts = url.pathname.split('/');
      if (parts.length !== 4) return send(res, 404, 'Not found');
      const filename = decodeURIComponent(parts[3]);
      if (basename(filename) !== filename || filename.includes('\\') || filename.includes('..') ||
          /[\x00-\x1f\x7f]/.test(filename) || !/\.html?$/i.test(filename) ||
          !equal(parts[2], signature(filename))) return send(res, 404, 'Not found');
      const path = join(outputDir, filename);
      const status = await lstat(path).catch(() => null);
      if (!status?.isFile() || status.isSymbolicLink()) return send(res, 404, 'Not found');
      // Capability URLs need no cookie. Sandbox prevents generated HTML from accessing
      // the service origin or other reports; allow scripts for upstream interactive diagrams.
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts; frame-ancestors \'self\'');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return send(res, 200, req.method === 'HEAD' ? '' : await readFile(path), 'text/html; charset=utf-8');
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
        setViewerSession(res);
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
      if (!equal(key, viewerKey) && !equal(key, token)) throw new ApiError(401, '访问密钥不正确');
      setViewerSession(res);
      return send(res, 200, 'ok');
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      if (req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Unexpected Origin');
      res.setHeader('Set-Cookie', 've_viewer=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return send(res, 200, 'ok');
    }
    if (url.pathname.startsWith('/api/')) {
      const service = equal(req.headers.authorization ?? '', `Bearer ${token}`);
      if (req.method === 'GET' ? !service && !viewerSession(req) : !service) throw new ApiError(401, 'Authentication required');
      if (req.headers.origin && req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Unexpected Origin');
      let parts;
      try { parts = url.pathname.split('/').slice(2).map(decodeURIComponent); }
      catch { throw new ApiError(400, 'Invalid URL encoding'); }
      const [resource, id] = parts;
      if (resource === 'entities' && parts.length === 1 && req.method === 'GET') {
        return await catalog.run(async () => {
          const pages = await listPages();
          return json(res, 200, {
            entities: catalog.entities().map(entity => withCount(entity, pages)),
            unassignedCount: pages.filter(page => page.entityId === null).length,
            totalCount: pages.length,
          });
        });
      }
      if (resource === 'entities' && parts.length === 1 && req.method === 'POST') {
        const body = await readJson(req, 4096);
        fields(body, ['id', 'name'], ['id', 'name']);
        return await catalog.run(async () => {
          const entity = await catalog.create(body.id, body.name);
          await history.snapshot(`Create entity ${entity.id}`);
          return json(res, 201, { entity: withCount(entity, await listPages()) });
        });
      }
      if (resource === 'entities' && parts.length === 2 && req.method === 'PATCH') {
        const body = await readJson(req, 4096);
        fields(body, ['name'], ['name']);
        return await catalog.run(async () => {
          const current = catalog.entity(id);
          const entity = typeof body.name === 'string' && body.name.trim() === current.name
            ? current : await catalog.rename(id, body.name);
          await history.snapshot(`Rename entity ${id}`);
          return json(res, 200, { entity: withCount(entity, await listPages()) });
        });
      }
      if (resource === 'entities' && parts.length === 2 && req.method === 'DELETE') {
        return await catalog.run(async () => {
          await catalog.remove(id, await listPages());
          await history.snapshot(`Delete entity ${id}`);
          return send(res, 204, '');
        });
      }
      if (resource === 'pages' && parts.length === 1 && req.method === 'GET') {
        return await catalog.run(async () => {
          const filter = url.searchParams.get('entityId');
          if (filter !== null && filter !== '') catalog.entity(filter);
          const pages = await listPages();
          return json(res, 200, { pages: filter === null ? pages : pages.filter(page => page.entityId === (filter || null)) });
        });
      }
      if (resource === 'pages' && parts.length === 2 && req.method === 'GET') {
        return await catalog.run(async () => json(res, 200, { page: await requirePage(id) }));
      }
      if (resource === 'pages' && parts.length === 2 && req.method === 'PATCH') {
        const body = await readJson(req, 4096);
        fields(body, ['entityId'], ['entityId']);
        return await catalog.run(async () => {
          const page = await requirePage(id);
          await catalog.assign(id, body.entityId);
          await history.snapshot(`Move page ${id}`);
          return json(res, 200, { page: { ...page, entityId: body.entityId } });
        });
      }
      if (resource === 'pages' && parts.length === 2 && req.method === 'PUT') {
        canonicalFilename(id);
        const body = await readJson(req, 12 * 1024 * 1024);
        fields(body, ['html', 'entityId'], ['html']);
        const result = await renderHtml({ ...body, filename: id }, true);
        if (result.render.isError) {
          throw new ApiError(400, result.render.content.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Rendering failed');
        }
        return json(res, result.created ? 201 : 200, { page: result.page, render: result.render });
      }
      throw new ApiError(404, 'Not found');
    }
    if (url.pathname !== '/mcp') return send(res, 404, 'Not found');
    if (!equal(req.headers.authorization ?? '', `Bearer ${token}`)) throw new ApiError(401, 'Bearer token required');
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
