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
import { createAccounts, createShares } from './accounts.mjs';
import { extractPageAnchors, resolveCommentWhere } from './anchors.mjs';
import { createComments, createCommentsStore, formatCommentsSummary, normalizeAuthor, normalizeWhere } from './comments.mjs';
import { createEventHub } from './events.mjs';
import { createHistory } from './history.mjs';
import { createSkills, docIdFromUri, validateExplainerId } from './skills.mjs';
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
const watchScript = await readFile(new URL('./static/watch.sh', import.meta.url));
const viewerKey = createHmac('sha256', token).update('viewer-access').digest('hex');
const sessionLifetime = 7 * 24 * 60 * 60;
const catalog = await createCatalog(outputDir);
const tokens = await createTokens(outputDir, catalog);
const comments = await createComments(outputDir);
const skillComments = await createCommentsStore(outputDir, {
  storeFile: '.skills-comments.json',
  validateKey: validateExplainerId,
});
const accounts = await createAccounts(outputDir);
const shares = await createShares(outputDir);
const events = createEventHub({ initialEventId: Date.now() * 1000 });
const skillEvents = createEventHub({ initialEventId: Date.now() * 1000 });
const history = await createHistory(outputDir, catalog);
await catalog.run(() => history.snapshot('Snapshot existing pages'));

const sessionCookies = {
  admin: { name: 've_admin', context: 'admin-session' },
  account: { name: 've_acct', context: 'account-session' },
  viewer: { name: 've_reader', context: 'reader-session' },
  legacy: { name: 've_viewer', context: 'viewer-session' },
};
function sessionSignature(expires, kind) {
  return createHmac('sha256', token).update(`${sessionCookies[kind].context}:${expires}`).digest('hex');
}
function accountSessionSignature(accountId, expires) {
  return createHmac('sha256', token).update(`${sessionCookies.account.context}:${accountId}:${expires}`).digest('hex');
}
function cookieValue(req, name) {
  const prefix = `${name}=`;
  return (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix))?.slice(prefix.length) ?? '';
}
function hasSession(req, kind) {
  const value = cookieValue(req, sessionCookies[kind].name);
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 2) return false;
  const [expires, sig] = parts;
  const remaining = Number(expires) - Math.floor(Date.now() / 1000);
  return remaining > 0 && remaining <= sessionLifetime && equal(sig ?? '', sessionSignature(expires, kind));
}
function readAccountSession(req) {
  const value = cookieValue(req, sessionCookies.account.name);
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [accountId, expires, sig] = parts;
  const remaining = Number(expires) - Math.floor(Date.now() / 1000);
  if (!(remaining > 0 && remaining <= sessionLifetime) || !equal(sig ?? '', accountSessionSignature(accountId, expires))) return null;
  const acct = accounts.get(accountId);
  if (!acct || acct.builtIn) return null;
  return { role: acct.role, accountId: acct.id, name: acct.name, builtIn: false };
}
function setSession(res, kind, accountId = null) {
  const expires = Math.floor(Date.now() / 1000) + sessionLifetime;
  const secure = publicUrl.protocol === 'https:' ? '; Secure' : '';
  const activeValue = kind === 'account'
    ? `${accountId}.${expires}.${accountSessionSignature(accountId, expires)}`
    : `${expires}.${sessionSignature(expires, kind)}`;
  res.setHeader('Set-Cookie', [kind, ...Object.keys(sessionCookies).filter(role => role !== kind)].map(role => {
    const { name } = sessionCookies[role];
    return `${name}=${role === kind ? activeValue : ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${role === kind ? sessionLifetime : 0}${secure}`;
  }));
}
function identity(req) {
  if (req.headers.authorization) {
    if (equal(req.headers.authorization, `Bearer ${token}`)) {
      return { role: 'admin', accountId: 'owner', name: accounts.ownerName(), builtIn: true, bearer: true };
    }
    const match = req.headers.authorization.match(/^Bearer (.+)$/);
    if (match) {
      const acct = accounts.authenticate(match[1]);
      if (acct) return { role: acct.role, accountId: acct.id, name: acct.name, builtIn: false, bearer: true };
      const skillEditor = skills.authenticateKey(match[1]);
      if (skillEditor) return skillEditor;
      const agent = tokens.authenticate(match[1]);
      if (agent) return agent;
    }
    throw new ApiError(401, 'Authentication required');
  }
  if (hasSession(req, 'admin')) return { role: 'admin', accountId: 'owner', name: accounts.ownerName(), builtIn: true };
  const acct = readAccountSession(req);
  if (acct) return acct;
  if (hasSession(req, 'viewer')) return { role: 'viewer' };
  if (hasSession(req, 'legacy')) return { role: 'admin', accountId: 'owner', name: accounts.ownerName(), builtIn: true, legacy: true };
  throw new ApiError(401, 'Authentication required');
}
function commentActor(authorName, auth) {
  const explicit = (authorName !== undefined && authorName !== null && authorName !== '')
    ? authorName
    : (auth.role !== 'agent' && auth.name ? auth.name : undefined);
  return normalizeAuthor(explicit, auth.role);
}
function guestErrorHtml(title, message) {
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f7f7f8;color:#111318;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}@media(prefers-color-scheme:dark){body{background:#0e1014;color:#f0f2f6}main{background:#14171d;border-color:#242934}p{color:#9ba3b4}}main{max-width:420px;width:100%;padding:28px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;text-align:center}h1{margin:0 0 8px;font-size:17px;font-weight:600}p{margin:0;color:#4b5563}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
}
function versionSignature(filename, revision) {
  return createHmac('sha256', token).update(`version:${filename}:${revision}`).digest('hex');
}
function versionUrl(filename, revision) {
  return new URL(`/versions/${versionSignature(filename, revision)}/${encodeURIComponent(filename)}/${revision}`, publicUrl).href;
}
function exposeVersion(filename, version) {
  const counts = version.version ? (comments.countsByVersion(filename).get(version.version) ?? { open: 0, resolved: 0, total: 0 }) : { open: 0, resolved: 0, total: 0 };
  return { ...version, commentCounts: counts, url: versionUrl(filename, version.revision) };
}
function cleanNote(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value)) throw new ApiError(400, 'Invalid publish note');
  const trimmed = value.trim();
  if ([...trimmed].length > 500) throw new ApiError(400, 'Publish note exceeds 500 characters');
  return trimmed;
}
function parseVersionQuery(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const match = String(raw).trim().match(/^v?(\d+)$/i);
  if (!match) throw new ApiError(400, 'version must be a positive integer like 3 or v3');
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < 1) throw new ApiError(400, 'version must be a positive integer');
  return value;
}
function parseAnchorLimit(raw) {
  if (raw === null || raw === undefined || raw === '') return 160;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1) throw new ApiError(400, 'limit must be a positive integer');
  return Math.min(value, 500);
}

// Runtime comment bridge injected ONLY on embedded preview requests (?embed=1).
// Saved HTML on disk and in Git remains 100% unmodified; sandbox="allow-scripts" stays opaque.
const embedBridgeScript = `<script data-ve-raft-bridge>(()=>{
if(window.parent===window)return;
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const h=(tag,attrs={},...kids)=>{const el=document.createElement(tag);for(const[k,v]of Object.entries(attrs))if(v!=null&&v!==false)k.startsWith('on')?el.addEventListener(k.slice(2),v):el.setAttribute(k,v===true?'':v);el.append(...kids.flat().filter(k=>k!=null&&k!==false));return el;};
// Suppress upstream kit/reply.js Ask/Comment/Copy-reply UI while keeping kit APIs safe.
window.veReply={$,$$,h,toast:()=>{},deliver:async()=>'sent',note:()=>{},closePop:()=>{},onSelect:()=>{},sheet:()=>{},close:()=>{},isOpen:()=>false,page:()=>{},parts:[],refresh:()=>{}};
const post=msg=>{try{window.parent.postMessage(msg,'*');}catch{}};
const clean=s=>String(s||'').replace(/\\s+/g,' ').trim();
const isBridge=el=>!!el?.closest?.('[data-ve-bridge-ui]');
function cssPath(el){
  if(!el||el.nodeType!==1)return '';
  if(el.id&&/^[A-Za-z_][A-Za-z0-9_:-]*$/.test(el.id)){
    const byId='#'+CSS.escape(el.id);
    if(document.querySelectorAll(byId).length===1)return byId;
  }
  const parts=[];
  let cur=el;
  while(cur&&cur.nodeType===1&&cur!==document.documentElement&&parts.length<32){
    if(cur.id&&/^[A-Za-z_][A-Za-z0-9_:-]*$/.test(cur.id)){
      const byId='#'+CSS.escape(cur.id);
      if(document.querySelectorAll(byId).length===1){
        parts.unshift(byId);
        break;
      }
    }
    const local=cur.localName||cur.tagName.toLowerCase();
    const tag=CSS.escape(local);
    let idx=1,sib=cur.previousElementSibling;
    while(sib){if((sib.localName||sib.tagName.toLowerCase())===local)idx++;sib=sib.previousElementSibling;}
    let same=0,s2=cur.parentElement?.firstElementChild;
    while(s2){if((s2.localName||s2.tagName.toLowerCase())===local)same++;s2=s2.nextElementSibling;}
    parts.unshift(same>1?tag+':nth-of-type('+idx+')':tag);
    const candidate=parts.join(' > ');
    try{
      const matches=document.querySelectorAll(candidate);
      if(matches.length===1&&matches[0]===el)break;
    }catch{}
    if(cur===document.body)break;
    cur=cur.parentElement;
  }
  return parts.join(' > ');
}
function headingTrail(el){
  if(!el)return [];
  const hs=$$('h1,h2,h3,h4').filter(x=>!isBridge(x));
  const stack=[];
  for(const hd of hs){
    const rel=hd.compareDocumentPosition(el);
    if(hd===el||(rel&Node.DOCUMENT_POSITION_FOLLOWING)){
      const lvl=Number(hd.tagName.slice(1));
      const text=clean(hd.textContent).slice(0,100);
      if(!text)continue;
      while(stack.length&&stack[stack.length-1].lvl>=lvl)stack.pop();
      stack.push({lvl,text});
    }
  }
  return stack.map(x=>x.text);
}
function labelOf(el){
  if(!el)return '';
  const direct=clean(el.getAttribute?.('aria-label')||el.getAttribute?.('data-label')||el.getAttribute?.('data-ref')||el.querySelector?.('h1,h2,h3,h4,figcaption,title')?.textContent);
  return (direct||clean(el.textContent)).slice(0,120);
}
let picking=false,threads=[],api=null,activeTheme=null,activeThemeMode='auto',draftSelector='',hoveredId='',wikiPages=[],wikiCurrent={filename:'',path:'',stem:'',dir:''};
function applyThemeToDoc(theme,mode='auto'){
  if(theme!=='dark'&&theme!=='light')return;
  activeTheme=theme;
  activeThemeMode=mode==='manual'?'manual':'auto';
  document.documentElement.dataset.theme=theme;
  document.documentElement.style.colorScheme=activeThemeMode==='auto'?'light dark':theme;
  const styleEl=document.getElementById('ve-raft-theme-override');
  if(activeThemeMode==='auto'){
    if(styleEl)styleEl.remove();
    return;
  }
  // Keep official kit pages visually synchronized with explicit WebUI light/dark override.
  const isKit=!!document.querySelector('[data-ve-kit]')||!!document.querySelector('style')?.textContent?.includes('--node-top');
  if(!isKit)return;
  let el=styleEl;
  if(!el&&document.head){el=h('style',{id:'ve-raft-theme-override','data-ve-bridge-ui':''});document.head.append(el);}
  if(!el)return;
  const reg=document.documentElement.dataset.register||'instrument';
  const darkVars=reg==='blueprint'
    ? '--bg:#0d1520;--surface:#132031;--border:#22324a;--border-bright:#596b87;--text:#e3ecf5;--text-dim:#92a6bb;--accent:#ffb547;--accent-dim:rgba(255,181,71,.14);--node-top:color-mix(in srgb,#e3ecf5 7%,#132031);--lift:rgb(0 0 0 / .45);'
    : '--bg:#0b0d0c;--surface:#121614;--border:#1f2522;--border-bright:#5e6662;--text:#e6ebe8;--text-dim:#919d97;--accent:#f2a93b;--accent-dim:rgba(242,169,59,.14);--node-top:color-mix(in srgb,#e6ebe8 7%,#121614);--lift:rgb(0 0 0 / .45);';
  const lightVars=reg==='blueprint'
    ? '--bg:#f2f6fa;--surface:#ffffff;--border:#d6e0ea;--border-bright:#818f9e;--text:#0f1a26;--text-dim:#4d6074;--accent:#a34700;--accent-dim:rgba(163,71,0,.12);--node-top:#ffffff;--lift:rgb(18 22 20 / .12);'
    : reg==='paper'
      ? '--bg:#f7f7f4;--surface:#ffffff;--border:#e3e3dc;--border-bright:#8e8e8a;--text:#17191c;--text-dim:#575c63;--accent:#2c4cd0;--accent-dim:rgba(44,76,208,.12);--node-top:#ffffff;--lift:rgb(18 22 20 / .12);'
      : '--bg:#f4f5f3;--surface:#ffffff;--border:#dfe3e0;--border-bright:#888e8b;--text:#121614;--text-dim:#545e59;--accent:#955700;--accent-dim:rgba(149,87,0,.12);--node-top:#ffffff;--lift:rgb(18 22 20 / .12);';
  el.textContent=':root{color-scheme:'+theme+';'+(theme==='dark'?darkVars:lightVars)+'}';
}
window.addEventListener('message',e=>{
  if(e.source!==window.parent||!e.data||typeof e.data!=='object')return;
  if(e.data.type==='ve-comment:pick'){picking=!!e.data.active;api?.applyPick();}
  else if(e.data.type==='ve-comment:sync'&&Array.isArray(e.data.threads)){threads=e.data.threads;api?.renderBoxes();}
  else if(e.data.type==='ve-comment:draft-box'){draftSelector=typeof e.data.selector==='string'?e.data.selector:'';api?.renderDraftBox();}
  else if(e.data.type==='ve-comment:hover'){hoveredId=typeof e.data.id==='string'?e.data.id:'';api?.updateHover();}
  else if(e.data.type==='ve-comment:focus'){api?.focusThread(e.data.id,e.data.selector);}
  else if(e.data.type==='ve-theme'){applyThemeToDoc(e.data.theme,e.data.mode);}
  else if(e.data.type==='ve-wiki:pages'){
    wikiPages=Array.isArray(e.data.pages)?e.data.pages:[];
    wikiCurrent=e.data.current&&typeof e.data.current==='object'?e.data.current:{filename:'',path:'',stem:'',dir:''};
    api?.syncWikiLinks();
  }
});
function init(){
  if(document.getElementById('ve-raft-bridge-style'))return;
  document.head.append(h('style',{id:'ve-raft-bridge-style','data-ve-bridge-ui':''},[
    '[data-ve-bridge-ui][hidden]{display:none !important;}',
    '.ve-raft-layer{position:fixed !important;inset:0 !important;width:100% !important;height:100% !important;margin:0 !important;padding:0 !important;border:0 !important;z-index:2147483635;pointer-events:none;overflow:hidden;box-sizing:border-box !important;}',
    '.ve-raft-sel{position:fixed !important;z-index:2147483640;pointer-events:auto;display:inline-flex;align-items:center;gap:6px;padding:6px 11px;margin:0 !important;border:1px solid #1b45b0;border-radius:7px;background:#2458d6;color:#fff;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 20px -4px rgba(15,23,42,.26);cursor:pointer;white-space:nowrap;transition:background 120ms ease,border-color 120ms ease;}',
    '.ve-raft-sel:hover{background:#1b45b0;}',
    '.ve-raft-sel svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
    '.ve-raft-pick-banner{position:fixed !important;top:12px;left:50%;transform:translateX(-50%);z-index:2147483641;display:inline-flex;align-items:center;gap:8px;padding:6px 13px;margin:0 !important;border:1px solid rgba(21,25,34,.14);border-radius:999px;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);color:#151922;font:500 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px -4px rgba(15,23,42,.18);pointer-events:none;}',
    '.ve-raft-pick-dot{width:7px;height:7px;border-radius:50%;background:#2458d6;box-shadow:0 0 0 3px rgba(36,88,214,.18);}',
    '.ve-raft-pick-box{position:fixed !important;margin:0 !important;padding:0 !important;box-sizing:border-box !important;z-index:2147483638;pointer-events:none;border:1.75px solid #2458d6;background:rgba(36,88,214,.08);border-radius:6px;box-shadow:0 0 0 3px rgba(36,88,214,.10);}',
    '.ve-raft-draft-box{position:fixed !important;margin:0 !important;padding:0 !important;box-sizing:border-box !important;z-index:2147483637;pointer-events:none;border:1.75px dashed #2458d6;background:rgba(36,88,214,.08);border-radius:6px;box-shadow:0 0 0 3px rgba(36,88,214,.14);}',
    '.ve-raft-comment-box{position:fixed !important;margin:0 !important;padding:0 !important;box-sizing:border-box !important;pointer-events:none;border:1.5px solid rgba(36,88,214,.44);background:rgba(36,88,214,.045);border-radius:6px;transition:border-color 120ms ease,background-color 120ms ease,box-shadow 120ms ease;}',
    '.ve-raft-comment-box.is-active{border:1.75px solid #2458d6;background:rgba(36,88,214,.11);box-shadow:0 0 0 3px rgba(36,88,214,.16);z-index:2;}',
    '.ve-raft-box-handle{position:absolute;top:-7px;right:-7px;pointer-events:auto;width:15px;height:15px;padding:0 !important;margin:0 !important;border:1.5px solid #ffffff;border-radius:50%;background:#2458d6;box-shadow:0 1px 4px rgba(15,23,42,.22),0 0 0 1px rgba(36,88,214,.28);cursor:pointer;transition:transform 110ms ease,background 110ms ease;}',
    '.ve-raft-box-handle:hover,.ve-raft-comment-box.is-active .ve-raft-box-handle{transform:scale(1.16);background:#1b45b0;}',
    '.ve-raft-comment-box.is-agent{border:1.5px solid rgba(180,83,9,.56);background:rgba(217,119,6,.06);}',
    '.ve-raft-comment-box.is-agent.is-active{border:2px solid #b45309;background:rgba(217,119,6,.13);box-shadow:0 0 0 3px rgba(217,119,6,.18);z-index:2;}',
    '.ve-raft-comment-box.is-agent .ve-raft-box-handle{border-color:#ffffff;background:#d97706;box-shadow:0 1px 4px rgba(15,23,42,.22),0 0 0 1px rgba(180,83,9,.34);}',
    '.ve-raft-comment-box.is-agent .ve-raft-box-handle:hover,.ve-raft-comment-box.is-agent.is-active .ve-raft-box-handle{transform:scale(1.16);background:#b45309;}',
    'body.ve-raft-picking,body.ve-raft-picking *{cursor:crosshair !important;}',
    ':root[data-theme="dark"] .ve-raft-sel{border-color:#8fb6ff;background:#6ea0ff;color:#0f1218;box-shadow:0 10px 24px rgba(0,0,0,.45);}',
    ':root[data-theme="dark"] .ve-raft-sel:hover{background:#8fb6ff;}',
    ':root[data-theme="dark"] .ve-raft-pick-banner{border-color:#22324a;background:rgba(19,32,49,.94);color:#e3ecf5;box-shadow:0 10px 28px rgba(0,0,0,.48);}',
    ':root[data-theme="dark"] .ve-raft-pick-dot{background:#6ea0ff;box-shadow:0 0 0 3px rgba(110,160,255,.22);}',
    ':root[data-theme="dark"] .ve-raft-pick-box{border-color:#6ea0ff;background:rgba(110,160,255,.11);box-shadow:0 0 0 3px rgba(110,160,255,.16);}',
    ':root[data-theme="dark"] .ve-raft-draft-box{border-color:#6ea0ff;background:rgba(110,160,255,.11);box-shadow:0 0 0 3px rgba(110,160,255,.18);}',
    ':root[data-theme="dark"] .ve-raft-comment-box{border-color:rgba(110,160,255,.48);background:rgba(110,160,255,.06);}',
    ':root[data-theme="dark"] .ve-raft-comment-box.is-active{border-color:#6ea0ff;background:rgba(110,160,255,.15);box-shadow:0 0 0 3px rgba(110,160,255,.22);}',
    ':root[data-theme="dark"] .ve-raft-box-handle{border-color:#0d1520;background:#6ea0ff;box-shadow:0 2px 8px rgba(0,0,0,.45),0 0 0 1px rgba(110,160,255,.35);}',
    ':root[data-theme="dark"] .ve-raft-box-handle:hover,:root[data-theme="dark"] .ve-raft-comment-box.is-active .ve-raft-box-handle{background:#8fb6ff;}',
    ':root[data-theme="dark"] .ve-raft-comment-box.is-agent{border:1.5px solid rgba(255,181,71,.62);background:rgba(255,181,71,.07);}',
    ':root[data-theme="dark"] .ve-raft-comment-box.is-agent.is-active{border:2px solid #ffb547;background:rgba(255,181,71,.15);box-shadow:0 0 0 3px rgba(255,181,71,.22);}',
    ':root[data-theme="dark"] .ve-raft-comment-box.is-agent .ve-raft-box-handle{border-color:#0d1520;background:#ffb547;box-shadow:0 2px 8px rgba(0,0,0,.45),0 0 0 1px rgba(255,181,71,.42);}',
    ':root[data-theme="dark"] .ve-raft-comment-box.is-agent .ve-raft-box-handle:hover,:root[data-theme="dark"] .ve-raft-comment-box.is-agent.is-active .ve-raft-box-handle{background:#ffd080;}',
    '.ve-drill-node{cursor:pointer;outline:none;}',
    '.ve-drill-node > rect:first-of-type,.ve-drill-node > polygon:first-of-type{stroke:rgba(36,88,214,.52);stroke-width:1.6px;filter:drop-shadow(4px 4px 0 rgba(36,88,214,.16)) drop-shadow(0 1px 2px rgba(15,23,42,.08));transition:stroke 140ms ease,filter 140ms ease;}',
    '.ve-drill-node:hover > rect:first-of-type,.ve-drill-node:focus-visible > rect:first-of-type,.ve-drill-node.is-drill-hover > rect:first-of-type,.ve-drill-node:hover > polygon:first-of-type,.ve-drill-node:focus-visible > polygon:first-of-type,.ve-drill-node.is-drill-hover > polygon:first-of-type{stroke:#2458d6;stroke-width:1.9px;filter:drop-shadow(5px 5px 0 rgba(36,88,214,.26)) drop-shadow(0 6px 14px rgba(36,88,214,.20));}',
    '.ve-drill-card{cursor:pointer;outline:none;border-color:rgba(36,88,214,.44) !important;box-shadow:4px 4px 0 0 rgba(36,88,214,.10),4px 4px 0 1px rgba(36,88,214,.26) !important;transition:transform 140ms ease,border-color 140ms ease,box-shadow 140ms ease;}',
    '.ve-drill-card:hover,.ve-drill-card:focus-visible,.ve-drill-card.is-drill-hover{border-color:#2458d6 !important;transform:translate(-1px,-1.5px);box-shadow:5px 5px 0 0 rgba(36,88,214,.16),0 8px 20px -6px rgba(36,88,214,.22) !important;}',
    '.ve-drill-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px 1px 6px;margin:0 1px;border-radius:5px;background:rgba(36,88,214,.08);border:1px solid rgba(36,88,214,.26);color:#1c47b5 !important;font-weight:560;line-height:1.45;text-decoration:none !important;vertical-align:baseline;cursor:pointer;transition:background 140ms ease,border-color 140ms ease,color 140ms ease;}',
    '.ve-drill-chip::before{content:"⧉";font-size:.88em;line-height:1;opacity:.88;}',
    '.ve-drill-chip::after{content:"›";font-size:1.05em;line-height:1;opacity:.72;transition:transform 140ms ease,opacity 140ms ease;}',
    '.ve-drill-chip:hover,.ve-drill-chip:focus-visible{background:rgba(36,88,214,.15);border-color:#2458d6;color:#2458d6 !important;outline:none;}',
    '.ve-drill-chip:hover::after{transform:translateX(2px);opacity:1;}',
    '.ve-drill-badge{position:fixed !important;margin:0 !important;pointer-events:auto;display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 6px;border-radius:5px;border:1px solid rgba(36,88,214,.38);background:rgba(244,247,255,.94);color:#1f4ec2;font:600 10.5px/1 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;box-shadow:0 1px 3px rgba(15,23,42,.10);cursor:pointer;white-space:nowrap;transition:background 140ms ease,color 140ms ease,border-color 140ms ease;}',
    '.ve-drill-badge:hover,.ve-drill-badge.is-hovered{background:#2458d6;border-color:#2458d6;color:#fff;}',
    '.ve-drill-badge svg{width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:1.4;flex:none;}',
    ':root[data-theme="dark"] .ve-drill-node > rect:first-of-type,:root[data-theme="dark"] .ve-drill-node > polygon:first-of-type{stroke:rgba(110,160,255,.54);filter:drop-shadow(4px 4px 0 rgba(110,160,255,.22)) drop-shadow(0 2px 5px rgba(0,0,0,.45));}',
    ':root[data-theme="dark"] .ve-drill-node:hover > rect:first-of-type,:root[data-theme="dark"] .ve-drill-node:focus-visible > rect:first-of-type,:root[data-theme="dark"] .ve-drill-node.is-drill-hover > rect:first-of-type{stroke:#6ea0ff;filter:drop-shadow(5px 5px 0 rgba(110,160,255,.32)) drop-shadow(0 8px 18px rgba(0,0,0,.55));}',
    ':root[data-theme="dark"] .ve-drill-card{border-color:rgba(110,160,255,.50) !important;box-shadow:4px 4px 0 0 rgba(110,160,255,.14),4px 4px 0 1px rgba(110,160,255,.30) !important;}',
    ':root[data-theme="dark"] .ve-drill-card:hover,:root[data-theme="dark"] .ve-drill-card:focus-visible,:root[data-theme="dark"] .ve-drill-card.is-drill-hover{border-color:#6ea0ff !important;box-shadow:5px 5px 0 0 rgba(110,160,255,.22),0 10px 24px -6px rgba(0,0,0,.55) !important;}',
    ':root[data-theme="dark"] .ve-drill-chip{background:rgba(110,160,255,.12);border-color:rgba(110,160,255,.32);color:#8eb7ff !important;}',
    ':root[data-theme="dark"] .ve-drill-chip:hover,:root[data-theme="dark"] .ve-drill-chip:focus-visible{background:rgba(110,160,255,.22);border-color:#6ea0ff;color:#b4d0ff !important;}',
    ':root[data-theme="dark"] .ve-drill-badge{background:rgba(24,32,48,.94);border-color:rgba(110,160,255,.46);color:#8bb4ff;}',
    ':root[data-theme="dark"] .ve-drill-badge:hover,:root[data-theme="dark"] .ve-drill-badge.is-hovered{background:#6ea0ff;border-color:#6ea0ff;color:#0f1218;}',
    '@media(prefers-color-scheme:dark){',
    ':root:not([data-theme="light"]) .ve-raft-sel{border-color:#8fb6ff;background:#6ea0ff;color:#0f1218;box-shadow:0 10px 24px rgba(0,0,0,.45);}',
    ':root:not([data-theme="light"]) .ve-raft-sel:hover{background:#8fb6ff;}',
    ':root:not([data-theme="light"]) .ve-raft-pick-banner{border-color:#22324a;background:rgba(19,32,49,.94);color:#e3ecf5;box-shadow:0 10px 28px rgba(0,0,0,.48);}',
    ':root:not([data-theme="light"]) .ve-raft-pick-dot{background:#6ea0ff;box-shadow:0 0 0 3px rgba(110,160,255,.22);}',
    ':root:not([data-theme="light"]) .ve-raft-pick-box{border-color:#6ea0ff;background:rgba(110,160,255,.11);box-shadow:0 0 0 3px rgba(110,160,255,.16);}',
    ':root:not([data-theme="light"]) .ve-raft-draft-box{border-color:#6ea0ff;background:rgba(110,160,255,.11);box-shadow:0 0 0 3px rgba(110,160,255,.18);}',
    ':root:not([data-theme="light"]) .ve-raft-comment-box{border-color:rgba(110,160,255,.48);background:rgba(110,160,255,.06);}',
    ':root:not([data-theme="light"]) .ve-raft-comment-box.is-active{border-color:#6ea0ff;background:rgba(110,160,255,.15);box-shadow:0 0 0 3px rgba(110,160,255,.22);}',
    ':root:not([data-theme="light"]) .ve-raft-box-handle{border-color:#0d1520;background:#6ea0ff;box-shadow:0 2px 8px rgba(0,0,0,.45),0 0 0 1px rgba(110,160,255,.35);}',
    ':root:not([data-theme="light"]) .ve-raft-box-handle:hover,:root:not([data-theme="light"]) .ve-raft-comment-box.is-active .ve-raft-box-handle{background:#8fb6ff;}',
    ':root:not([data-theme="light"]) .ve-raft-comment-box.is-agent{border:1.5px solid rgba(255,181,71,.62);background:rgba(255,181,71,.07);}',
    ':root:not([data-theme="light"]) .ve-raft-comment-box.is-agent.is-active{border:2px solid #ffb547;background:rgba(255,181,71,.15);box-shadow:0 0 0 3px rgba(255,181,71,.22);}',
    ':root:not([data-theme="light"]) .ve-raft-comment-box.is-agent .ve-raft-box-handle{border-color:#0d1520;background:#ffb547;box-shadow:0 2px 8px rgba(0,0,0,.45),0 0 0 1px rgba(255,181,71,.42);}',
    ':root:not([data-theme="light"]) .ve-raft-comment-box.is-agent .ve-raft-box-handle:hover,:root:not([data-theme="light"]) .ve-raft-comment-box.is-agent.is-active .ve-raft-box-handle{background:#ffd080;}',
    ':root:not([data-theme="light"]) .ve-drill-node > rect:first-of-type,:root:not([data-theme="light"]) .ve-drill-node > polygon:first-of-type{stroke:rgba(110,160,255,.54);filter:drop-shadow(4px 4px 0 rgba(110,160,255,.22)) drop-shadow(0 2px 5px rgba(0,0,0,.45));}',
    ':root:not([data-theme="light"]) .ve-drill-card{border-color:rgba(110,160,255,.50) !important;box-shadow:4px 4px 0 0 rgba(110,160,255,.14),4px 4px 0 1px rgba(110,160,255,.30) !important;}',
    ':root:not([data-theme="light"]) .ve-drill-chip{background:rgba(110,160,255,.12);border-color:rgba(110,160,255,.32);color:#8eb7ff !important;}',
    ':root:not([data-theme="light"]) .ve-drill-badge{background:rgba(24,32,48,.94);border-color:rgba(110,160,255,.46);color:#8bb4ff;}',
    '}',
    '@media print{[data-ve-bridge-ui]{display:none !important;}}'
  ].join('')));
  let selBtn=null,selRange=null,selTimer=null,hovered=null,draftEl=null,lastPtr=null;
  let tracked=[],wikiTracked=[],rafId=0,animUntil=0,animRaf=0,activeDrill=null;
  const drillBound=new WeakSet();
  const drillMeta=new WeakMap();
  const pickBanner=h('div',{class:'ve-raft-pick-banner','data-ve-bridge-ui':'',hidden:true},h('span',{class:'ve-raft-pick-dot'}),'Click any element to comment · Esc to cancel');
  const overlay=h('div',{class:'ve-raft-layer','data-ve-bridge-ui':''});
  const boxesHost=h('div',{'data-ve-bridge-ui':''});
  const wikiHost=h('div',{'data-ve-bridge-ui':''});
  const draftBox=h('div',{class:'ve-raft-draft-box','data-ve-bridge-ui':'',hidden:true});
  const pickBox=h('div',{class:'ve-raft-pick-box','data-ve-bridge-ui':'',hidden:true});
  overlay.append(boxesHost,wikiHost,draftBox,pickBox);
  (document.documentElement||document.body).append(overlay,pickBanner);
  const clearSelBtn=()=>{selBtn?.remove();selBtn=null;selRange=null;};
  const normWiki=s=>String(s||'').trim().replace(/^\\.?\\//,'').replace(/\\.html?$/i,'');
  function resolveWikiTarget(raw){
    const t=normWiki(raw);
    if(!t||!wikiPages.length)return null;
    const match=pred=>wikiPages.find(pred)||null;
    const lower=t.toLowerCase();
    const curStem=normWiki(wikiCurrent.stem||wikiCurrent.path);
    const curDir=normWiki(wikiCurrent.dir);
    if(curStem){
      const direct=curStem+'/'+t;
      const found=match(p=>normWiki(p.path)===direct)||match(p=>normWiki(p.path).toLowerCase()===direct.toLowerCase());
      if(found)return found;
    }
    if(curDir){
      const sib=curDir+'/'+t;
      const found=match(p=>normWiki(p.path)===sib)||match(p=>normWiki(p.path).toLowerCase()===sib.toLowerCase());
      if(found)return found;
    }
    return match(p=>normWiki(p.path)===t)
      ||match(p=>normWiki(p.path).toLowerCase()===lower)
      ||match(p=>normWiki(p.filename)===t||p.stem===t||normWiki(p.path).split('/').pop()===t)
      ||match(p=>normWiki(p.filename).toLowerCase()===lower||(p.stem||'').toLowerCase()===lower||normWiki(p.path).split('/').pop().toLowerCase()===lower);
  }
  function clipRect(el){
    let l=0,t=0,r=innerWidth,b=innerHeight;
    let p=el.parentElement;
    while(p&&p!==document.documentElement&&p!==document.body){
      const cs=getComputedStyle(p);
      const ox=cs.overflowX,oy=cs.overflowY;
      if(ox==='auto'||ox==='scroll'||ox==='hidden'||ox==='clip'||oy==='auto'||oy==='scroll'||oy==='hidden'||oy==='clip'){
        const pr=p.getBoundingClientRect();
        if(ox==='auto'||ox==='scroll'||ox==='hidden'||ox==='clip'){l=Math.max(l,pr.left);r=Math.min(r,pr.right);}
        if(oy==='auto'||oy==='scroll'||oy==='hidden'||oy==='clip'){t=Math.max(t,pr.top);b=Math.min(b,pr.bottom);}
      }
      p=p.parentElement;
    }
    return {l,t,r,b};
  }
  function placeBox(box,el,pad=3){
    if(!el||!el.isConnected)return false;
    const r=el.getBoundingClientRect();
    if(!r.width&&!r.height)return false;
    const c=clipRect(el);
    const l=Math.max(c.l,r.left-pad);
    const t=Math.max(c.t,r.top-pad);
    const right=Math.min(c.r,r.right+pad);
    const bottom=Math.min(c.b,r.bottom+pad);
    const w=right-l,ht=bottom-t;
    if(w<=1||ht<=1||bottom<=0||t>=innerHeight||right<=0||l>=innerWidth){
      box.style.visibility='hidden';
      return true;
    }
    box.style.visibility='visible';
    box.style.left=l+'px';
    box.style.top=t+'px';
    box.style.width=w+'px';
    box.style.height=ht+'px';
    return true;
  }
  function placeWikiBadge(badge,el){
    if(!el||!el.isConnected)return false;
    const r=el.getBoundingClientRect();
    if(r.width<24||r.height<18)return false;
    const c=clipRect(el);
    const bw=badge.offsetWidth||58,bh=badge.offsetHeight||19;
    const left=Math.round(r.right-bw-6);
    const top=Math.round(r.top+6);
    if(top+bh<=c.t||top>=c.b||left+bw<=c.l||left>=c.r||top+bh<=0||top>=innerHeight||left+bw<=0||left>=innerWidth){
      badge.style.visibility='hidden';
      return true;
    }
    badge.style.visibility='visible';
    badge.style.left=Math.max(c.l+2,Math.min(left,c.r-bw-2))+'px';
    badge.style.top=Math.max(c.t+2,Math.min(top,c.b-bh-2))+'px';
    return true;
  }
  function positionSelBtn(){
    if(!selBtn||!selRange)return;
    const r=selRange.getBoundingClientRect();
    if((!r.width&&!r.height)||r.bottom<0||r.top>innerHeight){clearSelBtn();return;}
    const left=Math.max(8,Math.min(r.left,innerWidth-selBtn.offsetWidth-8));
    const top=Math.max(8,r.top-40);
    selBtn.style.left=left+'px';
    selBtn.style.top=top+'px';
  }
  function syncPositions(){
    let missing=false;
    for(const item of tracked){
      if(!item.el.isConnected){missing=true;continue;}
      placeBox(item.box,item.el,3);
    }
    if(missing){renderBoxes();return;}
    let wikiMissing=false;
    for(const item of wikiTracked){
      if(!item.el.isConnected){wikiMissing=true;continue;}
      if(item.badge)placeWikiBadge(item.badge,item.el);
    }
    if(wikiMissing){syncWikiLinks();return;}
    if(draftSelector){
      if(!draftEl||!draftEl.isConnected){try{draftEl=document.querySelector(draftSelector);}catch{draftEl=null;}}
      if(draftEl&&!isBridge(draftEl)&&placeBox(draftBox,draftEl,3))draftBox.hidden=false;
      else draftBox.hidden=true;
    }else{
      draftEl=null;
      draftBox.hidden=true;
    }
    if(picking){
      if(lastPtr){
        const under=document.elementFromPoint(lastPtr.x,lastPtr.y);
        if(under&&!isBridge(under)&&under!==document.documentElement&&under!==document.body)hovered=under;
      }
      if(hovered&&hovered.isConnected&&placeBox(pickBox,hovered,0))pickBox.hidden=false;
      else pickBox.hidden=true;
    }
    if(selBtn)positionSelBtn();
  }
  function scheduleSync(){
    if(rafId)return;
    rafId=requestAnimationFrame(()=>{rafId=0;syncPositions();});
  }
  function startAnimSync(ms=650){
    animUntil=Math.max(animUntil,performance.now()+ms);
    if(animRaf)return;
    const step=now=>{
      syncPositions();
      if(now<animUntil)animRaf=requestAnimationFrame(step);
      else animRaf=0;
    };
    animRaf=requestAnimationFrame(step);
  }
  const ro=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>scheduleSync()):null;
  function refreshObserved(){
    if(!ro)return;
    ro.disconnect();
    if(document.documentElement)ro.observe(document.documentElement);
    if(document.body)ro.observe(document.body);
    if(draftEl&&draftEl.isConnected)ro.observe(draftEl);
    for(const item of tracked){if(item.el&&item.el.isConnected)ro.observe(item.el);}
    for(const item of wikiTracked){if(item.el&&item.el.isConnected)ro.observe(item.el);}
  }
  function clearDrillHover(){
    if(!activeDrill)return;
    activeDrill.el.classList.remove('is-drill-hover');
    activeDrill.badge?.classList.remove('is-hovered');
    activeDrill=null;
    post({type:'ve-wiki:hover',filename:''});
  }
  function enterDrill(el){
    if(picking)return;
    const meta=drillMeta.get(el);
    if(!meta?.target)return;
    if(activeDrill&&activeDrill.el!==el){
      activeDrill.el.classList.remove('is-drill-hover');
      activeDrill.badge?.classList.remove('is-hovered');
    }
    activeDrill=meta;
    meta.el.classList.add('is-drill-hover');
    meta.badge?.classList.add('is-hovered');
    const r=meta.el.getBoundingClientRect();
    post({type:'ve-wiki:hover',filename:meta.target.filename,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}});
  }
  function leaveDrill(el,related){
    const meta=drillMeta.get(el);
    if(!meta)return;
    if(related&&(meta.el.contains(related)||(meta.badge&&meta.badge.contains(related))))return;
    if(activeDrill&&activeDrill.el===el)clearDrillHover();
  }
  function navigateDrill(el,e){
    if(picking)return;
    const meta=drillMeta.get(el);
    if(!meta?.target)return;
    e.preventDefault();
    e.stopPropagation();
    clearDrillHover();
    post({type:'ve-wiki:navigate',filename:meta.target.filename});
  }
  function bindDrillElement(el){
    if(drillBound.has(el))return;
    drillBound.add(el);
    el.addEventListener('pointerenter',()=>enterDrill(el));
    el.addEventListener('pointerleave',e=>leaveDrill(el,e.relatedTarget));
    el.addEventListener('focusin',()=>enterDrill(el));
    el.addEventListener('focusout',e=>leaveDrill(el,e.relatedTarget));
    el.addEventListener('click',e=>navigateDrill(el,e));
    el.addEventListener('keydown',e=>{
      if((e.key==='Enter'||e.key===' ')&&!picking)navigateDrill(el,e);
    });
  }
  function syncWikiLinks(){
    clearDrillHover();
    wikiHost.replaceChildren();
    wikiTracked=[];
    const nodes=$$('[data-ve-child]').filter(el=>!isBridge(el));
    for(const el of nodes){
      const raw=el.getAttribute('data-ve-child');
      const target=resolveWikiTarget(raw);
      el.classList.remove('ve-drill-node','ve-drill-card','ve-drill-chip','is-drill-hover');
      if(!target){drillMeta.delete(el);continue;}
      const isSvg=typeof SVGElement!=='undefined'&&el instanceof SVGElement;
      const isInline=!isSvg&&el.matches('span,a,button,code,em,strong,small,b,i,mark');
      if(isSvg)el.classList.add('ve-drill-node');
      else if(isInline)el.classList.add('ve-drill-chip');
      else el.classList.add('ve-drill-card');
      if(!el.hasAttribute('tabindex')&&!el.matches('a[href],button'))el.setAttribute('tabindex','0');
      if(!el.hasAttribute('role')&&!el.matches('a[href],button'))el.setAttribute('role','button');
      let badge=null;
      if(!isInline){
        const label=target.childCount>0?('↳ '+target.childCount+' sub'):'↳ Detail';
        badge=h('button',{type:'button',class:'ve-drill-badge','data-ve-bridge-ui':'',tabindex:'-1','aria-label':'Open '+target.title});
        badge.innerHTML='<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.2" y="1.2" width="6.5" height="6.5" rx="1.3"/><path d="M4.5 10.6h4.8a1.3 1.3 0 0 0 1.3-1.3V4.5" stroke-linecap="round"/></svg><span></span>';
        badge.lastElementChild.textContent=label;
        badge.addEventListener('pointerenter',()=>enterDrill(el));
        badge.addEventListener('pointerleave',e=>leaveDrill(el,e.relatedTarget));
        badge.addEventListener('click',e=>navigateDrill(el,e));
        wikiHost.append(badge);
      }
      const meta={el,target,badge};
      drillMeta.set(el,meta);
      bindDrillElement(el);
      wikiTracked.push(meta);
    }
    for(const item of wikiTracked){if(item.badge)placeWikiBadge(item.badge,item.el);}
    refreshObserved();
  }
  function applyPick(){
    document.body.classList.toggle('ve-raft-picking',picking);
    pickBanner.hidden=!picking;
    if(!picking){hovered=null;lastPtr=null;pickBox.hidden=true;}
    else{clearSelBtn();clearDrillHover();}
  }
  function renderDraftBox(){
    if(!draftSelector){draftEl=null;draftBox.hidden=true;refreshObserved();return;}
    let el=null;
    try{el=document.querySelector(draftSelector);}catch{}
    draftEl=el&&!isBridge(el)?el:null;
    if(!draftEl||!placeBox(draftBox,draftEl,3)){draftBox.hidden=true;refreshObserved();return;}
    draftBox.hidden=false;
    refreshObserved();
    startAnimSync(300);
  }
  function updateHover(){
    for(const item of tracked){
      item.box.classList.toggle('is-active',Boolean(hoveredId)&&item.id===hoveredId);
    }
  }
  function renderBoxes(){
    boxesHost.replaceChildren();
    tracked=[];
    const seen=new Map();
    for(const t of threads){
      if(!t.selector)continue;
      let el=null;
      try{el=document.querySelector(t.selector);}catch{}
      if(!el||isBridge(el))continue;
      const isAgent=t.authorRole==='agent';
      const box=h('div',{class:'ve-raft-comment-box'+(isAgent?' is-agent':''),'data-ve-bridge-ui':'','data-thread-id':t.id});
      if(!placeBox(box,el,3))continue;
      const slot=seen.get(el)||0;
      seen.set(el,slot+1);
      const handleLabel=isAgent?'Open AI comment':'Open comment';
      const handle=h('button',{type:'button',class:'ve-raft-box-handle','data-ve-bridge-ui':'',title:handleLabel,'aria-label':handleLabel,onclick:e=>{e.stopPropagation();e.preventDefault();post({type:'ve-comment:select',id:t.id});}});
      if(slot>0)handle.style.right=(-7+slot*18)+'px';
      box.append(handle);
      if(hoveredId&&hoveredId===t.id)box.classList.add('is-active');
      boxesHost.append(box);
      tracked.push({box,el,id:t.id});
    }
    refreshObserved();
  }
  function focusThread(id,selector){
    let el=null;
    if(selector){try{el=document.querySelector(selector);}catch{}}
    if(el&&!isBridge(el)){
      el.scrollIntoView({behavior:'smooth',block:'center'});
      if(!tracked.some(item=>item.id===id))renderBoxes();
      startAnimSync(800);
      const item=tracked.find(x=>x.id===id);
      if(item){
        item.box.classList.add('is-active');
        setTimeout(()=>{if(hoveredId!==id)item.box.classList.remove('is-active');},1600);
      }
    }else{
      post({type:'ve-comment:focus-miss',id});
    }
  }
  api={applyPick,renderBoxes,renderDraftBox,updateHover,focusThread,syncWikiLinks};
  if(activeTheme)applyThemeToDoc(activeTheme,activeThemeMode);
  applyPick();
  renderBoxes();
  renderDraftBox();
  syncWikiLinks();
  window.addEventListener('scroll',scheduleSync,{passive:true,capture:true});
  window.addEventListener('resize',()=>{scheduleSync();startAnimSync(250);},{passive:true});
  window.addEventListener('load',()=>{renderBoxes();renderDraftBox();syncWikiLinks();startAnimSync(300);});
  document.fonts?.ready?.then(()=>{scheduleSync();startAnimSync(200);});
  document.addEventListener('transitionrun',e=>{if(!isBridge(e.target))startAnimSync(700);},true);
  document.addEventListener('transitionend',e=>{if(!isBridge(e.target))scheduleSync();},true);
  document.addEventListener('animationstart',e=>{if(!isBridge(e.target))startAnimSync(700);},true);
  document.addEventListener('animationend',e=>{if(!isBridge(e.target))scheduleSync();},true);
  if(typeof MutationObserver!=='undefined'&&document.body){
    new MutationObserver(muts=>{
      let changed=false,treeChanged=false;
      for(const m of muts){
        if(isBridge(m.target))continue;
        changed=true;
        if(m.type==='childList')treeChanged=true;
      }
      if(!changed)return;
      if(treeChanged&&threads.length&&tracked.length<threads.length)renderBoxes();
      if(treeChanged&&wikiPages.length)syncWikiLinks();
      else scheduleSync();
    }).observe(document.body,{attributes:true,childList:true,subtree:true});
  }
  document.addEventListener('selectionchange',()=>{
    clearTimeout(selTimer);
    selTimer=setTimeout(()=>{
      clearSelBtn();
      if(picking)return;
      const sel=getSelection();
      if(!sel||sel.isCollapsed)return;
      const quote=clean(sel.toString());
      if(quote.length<2||quote.length>1000)return;
      const range=sel.getRangeAt(0);
      const base=range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;
      const node=base?.getRootNode?.() instanceof ShadowRoot?base.getRootNode().host:base;
      if(!node||isBridge(node)||node.closest?.('textarea,input'))return;
      const rect=range.getBoundingClientRect();
      if(!rect.width&&!rect.height)return;
      selRange=range.cloneRange();
      selBtn=h('button',{type:'button',class:'ve-raft-sel','data-ve-bridge-ui':''});
      selBtn.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg><span>Comment</span>';
      selBtn.addEventListener('pointerdown',e=>e.preventDefault());
      selBtn.addEventListener('click',e=>{
        e.preventDefault();e.stopPropagation();
        clearSelBtn();
        const selector=cssPath(node);
        const where={kind:'text',quote,selector,tag:node.tagName.toLowerCase(),headings:headingTrail(node)};
        sel.removeAllRanges();
        draftSelector=selector;
        renderDraftBox();
        post({type:'ve-comment:draft',where});
      });
      overlay.append(selBtn);
      positionSelBtn();
    },140);
  });
  document.addEventListener('pointerdown',e=>{if(selBtn&&!selBtn.contains(e.target))clearSelBtn();},true);
  document.addEventListener('pointermove',e=>{
    if(!picking)return;
    lastPtr={x:e.clientX,y:e.clientY};
    const target=document.elementFromPoint(e.clientX,e.clientY);
    if(!target||isBridge(target)||target===document.documentElement||target===document.body){hovered=null;pickBox.hidden=true;return;}
    hovered=target;
    if(placeBox(pickBox,target,0))pickBox.hidden=false;
    else pickBox.hidden=true;
  },true);
  document.addEventListener('click',e=>{
    if(!picking)return;
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
    const raw=hovered||e.target;
    const target=raw&&raw.nodeType===1?raw:raw?.parentElement;
    if(!target||isBridge(target))return;
    const selector=cssPath(target);
    const where={kind:'element',selector,tag:target.tagName.toLowerCase(),label:labelOf(target),quote:clean(target.textContent).slice(0,240),headings:headingTrail(target)};
    picking=false;
    applyPick();
    draftSelector=selector;
    renderDraftBox();
    post({type:'ve-comment:pick-state',active:false});
    post({type:'ve-comment:draft',where});
  },true);
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&picking){e.preventDefault();picking=false;applyPick();post({type:'ve-comment:pick-state',active:false});return;}
    if(e.key==='Escape'&&!picking&&!e.target?.closest?.('input,textarea,select,[contenteditable]')){clearDrillHover();post({type:'ve-wiki:escape'});}
  },true);
  post({type:'ve-comment:ready'});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
else init();
})();</script>`;

function injectEmbedBridge(bytes) {
  const html = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + embedBridgeScript + html.slice(head.index + head[0].length);
  const doc = /<html\b[^>]*>/i.exec(html);
  if (doc) return html.slice(0, doc.index + doc[0].length) + embedBridgeScript + html.slice(doc.index + doc[0].length);
  return embedBridgeScript + html;
}
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
function thumbFilename(filename, theme = 'light') {
  return filename.replace(/\.html?$/i, theme === 'dark' ? '.thumb-dark.png' : '.thumb.png');
}
function thumbFilenames(filename) {
  return [thumbFilename(filename, 'light'), thumbFilename(filename, 'dark')];
}
function extractSummary(doc) {
  const raw = doc.querySelector('meta[name="description"]')?.getAttribute('content')
    || doc.querySelector('.lead')?.textContent
    || doc.querySelector('main p, body p')?.textContent
    || '';
  const normalized = String(raw).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return [...normalized].length > 160 ? [...normalized].slice(0, 159).join('') + '…' : normalized;
}
async function saveThumb(filename, bytes, theme = 'light') {
  const path = join(outputDir, thumbFilename(filename, theme)), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => console.error('Thumb temporary cleanup failed')); }
}
async function removeThumbs(filename) {
  for (const name of thumbFilenames(filename)) {
    const path = join(outputDir, name);
    const info = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && info.isFile() && !info.isSymbolicLink()) {
      await rm(path, { force: true }).catch(() => console.error('Stale thumb cleanup failed'));
    }
  }
}
let thumbBrowserPromise = null;
async function getThumbBrowser() {
  if (thumbBrowserPromise) {
    try {
      const existing = await thumbBrowserPromise;
      if (existing && existing.isConnected()) return existing;
    } catch {}
    thumbBrowserPromise = null;
  }
  thumbBrowserPromise = (async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    browser.on('disconnected', () => { thumbBrowserPromise = null; });
    return browser;
  })();
  try {
    return await thumbBrowserPromise;
  } catch (error) {
    thumbBrowserPromise = null;
    throw error;
  }
}
async function closeThumbBrowser() {
  const pending = thumbBrowserPromise;
  thumbBrowserPromise = null;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {}
}
async function renderThumbnailBuffers(renderedHtml) {
  let context = null;
  try {
    const browser = await getThumbBrowser();
    context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'reduce',
      offline: true,
      serviceWorkers: 'block',
    });
    await context.route('**/*', route => {
      const reqUrl = route.request().url();
      if (reqUrl === 'about:blank' || reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) {
        return route.continue();
      }
      return route.abort();
    });
    const page = await context.newPage();
    await page.setContent(renderedHtml, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.addStyleTag({
      content: '.js-motion main > *{opacity:1 !important;transform:none !important;transition:none !important;}',
    });
    await Promise.race([
      page.evaluate(() => document.fonts?.ready).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 250)),
    ]);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await Promise.race([
      page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 250)),
    ]);
    const lightPng = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 10000 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await Promise.race([
      page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 250)),
    ]);
    const darkPng = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 10000 });
    return { lightPng, darkPng };
  } finally {
    await context?.close().catch(() => {});
  }
}
async function captureThumbnails(renderedHtml, filename) {
  try {
    const { lightPng, darkPng } = await renderThumbnailBuffers(renderedHtml);
    await saveThumb(filename, lightPng, 'light');
    await saveThumb(filename, darkPng, 'dark');
  } catch (error) {
    console.error('Thumbnail capture failed', { filename, message: error?.message });
    await removeThumbs(filename);
  }
}
async function captureSkillThumbnails(renderedHtml, explainerId) {
  try {
    const { lightPng, darkPng } = await renderThumbnailBuffers(renderedHtml);
    await skills.saveThumbs(explainerId, lightPng, darkPng);
  } catch (error) {
    console.error('Skill explainer thumbnail capture failed', { explainerId, message: error?.message });
    await skills.removeThumbs(explainerId);
  }
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
    const buffer = Buffer.alloc(Math.min(32768, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const doc = parse(buffer.subarray(0, bytesRead).toString('utf8'));
    const title = doc.querySelector('title')?.textContent.trim() || filename;
    const summary = extractSummary(doc);
    const thumbInfo = await lstat(join(outputDir, thumbFilename(filename))).catch(() => null);
    const hasThumb = Boolean(thumbInfo && thumbInfo.isFile() && !thumbInfo.isSymbolicLink());
    const modified = info.mtime.toISOString();
    const commentCounts = comments.counts(filename);
    return {
      filename, title, summary, modified, bytes: info.size,
      url: pageUrl(filename),
      thumbUrl: hasThumb ? `/api/pages/${encodeURIComponent(filename)}/thumb?v=${encodeURIComponent(modified)}` : null,
      openComments: commentCounts.open, totalComments: commentCounts.total,
      ...catalog.location(filename),
    };
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
  const thumbNames = thumbFilenames(filename);
  const thumbs = thumbNames.filter(name => names.includes(name));
  const owners = entries => entries.filter(name => !/\.src\.html?$/i.test(name) &&
    /\.html?$/i.test(name) && name.replace(/\.html?$/i, '') === stem);
  const files = [];
  for (const name of [filename, ...companions, ...sheets, ...thumbs]) {
    const info = await lstat(join(outputDir, name)).catch(error => {
      if (error.code === 'ENOENT') throw new ApiError(name === filename ? 404 : 409, name === filename ? 'Page not found' : 'Page files changed; refresh and retry');
      throw error;
    });
    if (!info.isFile() || info.isSymbolicLink()) throw new ApiError(409, 'Page files must be regular files, not symlinks');
    files.push({ name, info });
  }
  if ((sheets.length || thumbs.length) && owners(names).length > 1) {
    throw new ApiError(409, 'Render sheets have multiple possible page owners');
  }
  // Direct filesystem edits may not yet be in Git. Preserve the exact old HTML
  // and source before removing anything; identical snapshots make no new commit.
  await history.snapshot(`Snapshot before deleting page ${filename}`, { push: false });
  const currentNames = await readdir(outputDir);
  if (JSON.stringify(companions) !== JSON.stringify(sourcePairs(currentNames).get(filename) ?? []) ||
      JSON.stringify(sheets) !== JSON.stringify(currentNames.filter(name => sheetPattern.test(name))) ||
      JSON.stringify(thumbs) !== JSON.stringify(thumbNames.filter(name => currentNames.includes(name))) ||
      JSON.stringify(owners(names)) !== JSON.stringify(owners(currentNames))) {
    throw new ApiError(409, 'Page file ownership changed; refresh and retry');
  }
  const staging = await mkdtemp(join(outputDir, '.delete-'));
  const moved = [];
  let removedComments = [];
  let removedShares = [];
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
    removedComments = await comments.forgetPage(filename);
    removedShares = await shares.forgetPage(filename);
  } catch (error) {
    // A filesystem/catalog failure restores staged originals. A Git failure below
    // follows the existing local-first contract instead of rolling back content.
    try {
      await shares.restorePage(removedShares);
      await comments.restorePage(removedComments);
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
    if (!entry.isFile() || entry.name.startsWith('__skill-render-') || !/\.html?$/i.test(entry.name) || /\.src\.html?$/i.test(entry.name)) continue;
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

async function readOptionalJson(req, limit) {
  const raw = (await readBody(req, limit)).trim();
  if (!raw) return {};
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new ApiError(400, 'Invalid JSON'); }
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
const upstreamSkillDocs = new Map();
for (const resource of originalResources.resources) {
  const docId = docIdFromUri(resource.uri);
  if (!docId) continue;
  const loaded = await upstream.readResource({ uri: resource.uri });
  if (loaded.contents.length !== 1 || typeof loaded.contents[0].text !== 'string') {
    throw new Error(`Official upstream resource ${resource.uri} did not return one text document`);
  }
  upstreamSkillDocs.set(docId, loaded.contents[0].text);
}
const builtinSkillsDir = fileURLToPath(new URL('./builtin-skills', import.meta.url));
const skills = await createSkills(outputDir, {
  upstreamDocs: upstreamSkillDocs,
  upstreamMeta: {
    version: upstream.getServerVersion().version,
    revision: originalRevision,
  },
  builtinDir: builtinSkillsDir,
});
const originalIndexBase = {
  package: { name: 'visual-explainer', version: upstream.getServerVersion().version, revision: originalRevision, source: originalSource },
  resources: [...originalDocuments].map(([path, resource]) => ({ ...resource, url: new URL(originalPrefix + path, publicUrl).href })),
  prompts: originalPrompts.prompts.map(prompt => ({ ...prompt, url: new URL(`${originalPrefix}/prompts/${encodeURIComponent(prompt.name)}`, publicUrl).href })),
  tools: originalTools.tools,
  prepareUrl: new URL(`${originalPrefix}/prepare`, publicUrl).href,
  watchUrl: new URL(`${originalPrefix}/watch.sh`, publicUrl).href,
  publish: { method: 'PUT', path: '/api/entities/:id/files/<path>.html', contentType: 'text/html; charset=utf-8' },
};
function publicTemplateCatalog() {
  const defaultTemplate = skills.defaultTemplate();
  const templates = skills.listTemplates().map(tpl => ({
    id: tpl.id,
    docId: tpl.docId,
    title: tpl.title,
    whenToUse: tpl.whenToUse,
    default: tpl.isDefault,
    sha256: tpl.sha256,
    url: new URL(`${originalPrefix}/templates/${encodeURIComponent(tpl.id)}.md`, publicUrl).href,
  }));
  return { defaultTemplate, templates };
}
function buildOriginalIndex() {
  const catalog = publicTemplateCatalog();
  return {
    ...originalIndexBase,
    templatesUrl: new URL(`${originalPrefix}/templates`, publicUrl).href,
    defaultTemplate: catalog.defaultTemplate,
    templates: catalog.templates,
  };
}
function originalReadonly(parts, method) {
  return parts[0] === 'visual-explainer' && (method === 'GET' || (method === 'POST' &&
    ((parts.length === 2 && parts[1] === 'prepare') || (parts.length === 3 && parts[1] === 'prompts'))));
}
async function originalRequest(call) {
  try { return await call(); }
  catch (error) { throw new ApiError(502, `Official visual-explainer request failed: ${error.message}`); }
}
async function serveOriginal(req, res, parts, url) {
  if (parts.length === 1 && req.method === 'GET') return json(res, 200, buildOriginalIndex());
  if (parts.length === 2 && parts[1] === 'watch.sh' && req.method === 'GET') {
    return send(res, 200, watchScript, 'text/x-shellscript; charset=utf-8');
  }
  if (parts.length === 2 && parts[1] === 'bootstrap-prompt' && req.method === 'GET') {
    const content = skills.getEffectiveDoc('webui/bootstrap-prompt.md');
    return json(res, 200, {
      id: 'webui/bootstrap-prompt.md',
      sha256: skills.expectedSkillHash(['webui/bootstrap-prompt.md']),
      content,
    });
  }
  if (parts.length === 2 && parts[1] === 'templates' && req.method === 'GET') {
    return json(res, 200, publicTemplateCatalog());
  }
  if (parts.length === 3 && parts[1] === 'templates' && req.method === 'GET') {
    const fileName = parts[2];
    if (!/^[a-z0-9][a-z0-9-]{0,63}\.md$/.test(fileName)) {
      throw new ApiError(404, 'Template not found');
    }
    const docId = `templates/${fileName}`;
    if (!skills.hasDoc(docId)) throw new ApiError(404, 'Template not found');
    return send(res, 200, skills.getEffectiveDoc(docId), 'text/markdown; charset=utf-8');
  }
  if (parts.length === 2 && parts[1] === 'bundle' && req.method === 'GET') {
    const skillRes = originalDocuments.get('/SKILL.md');
    const styleRes = originalDocuments.get('/references/style-guide.md');
    if (!skillRes || !styleRes) throw new ApiError(502, 'Official bootstrap resources unavailable');
    const requested = [
      ['/SKILL.md', skillRes],
      ['/references/style-guide.md', styleRes],
    ];
    const rawRefs = url?.searchParams.get('refs');
    if (rawRefs !== null && rawRefs !== undefined && rawRefs !== '') {
      const slugs = rawRefs.split(',').map(slug => slug.trim());
      if (slugs.length > 8) throw new ApiError(400, 'At most 8 refs may be requested');
      const seen = new Set(['style-guide']);
      for (const slug of slugs) {
        if (!/^[a-z0-9-]+$/.test(slug)) throw new ApiError(400, 'Invalid reference slug');
        const docPath = `/references/${slug}.md`;
        const resource = originalDocuments.get(docPath);
        if (!resource) throw new ApiError(404, `Official reference not found: ${slug}`);
        if (seen.has(slug)) continue;
        seen.add(slug);
        requested.push([docPath, resource]);
      }
    }
    const docs = await Promise.all(requested.map(async ([docPath, resource]) => {
      const docId = docPath.slice(1);
      if (skills.hasDoc(docId)) return [docPath, skills.getEffectiveDoc(docId)];
      const result = await originalRequest(() => upstream.readResource({ uri: resource.uri }));
      if (result.contents.length !== 1 || typeof result.contents[0].text !== 'string') {
        throw new ApiError(502, 'Official resource did not return one text document');
      }
      return [docPath, result.contents[0].text];
    }));
    const sections = [
      `=== ${originalPrefix} ===\n${JSON.stringify(buildOriginalIndex())}`,
      ...docs.map(([docPath, text]) => `=== ${originalPrefix}${docPath} ===\n${text}`),
    ];
    return send(res, 200, sections.join('\n\n') + '\n', 'text/plain; charset=utf-8');
  }
  if (req.method === 'GET') {
    const relPath = parts.slice(1).join('/');
    const resource = originalDocuments.get('/' + relPath);
    if (resource) {
      if (skills.hasDoc(relPath)) {
        return send(res, 200, skills.getEffectiveDoc(relPath), `${resource.mimeType}; charset=utf-8`);
      }
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

function encodeExplainerPath(id) {
  return id.split('/').map(encodeURIComponent).join('/');
}
function exposeSkillExplainer(entry) {
  const counts = skillComments.counts(entry.id);
  const encoded = encodeExplainerPath(entry.id);
  return {
    ...entry,
    htmlUrl: `/api/skills/explainers/${encoded}/html`,
    sourceUrl: `/api/skills/explainers/${encoded}/source`,
    thumbUrl: `/api/skills/explainers/${encoded}/thumb?v=${encodeURIComponent(entry.updatedAt || entry.skillHash || '1')}`,
    openComments: counts.open,
    totalComments: counts.total,
  };
}
function requireSkillsEditEnabled() {
  if (!skills.isEditEnabled()) {
    throw new ApiError(423, 'Skill editing is locked. Enable Skill Editing in Admin Skills first.');
  }
}
async function renderSkillExplainerLocked(explainerId, sourceHtml) {
  const renderId = randomUUID();
  const prefix = `__skill-render-${renderId}`;
  const transientFilename = `${prefix}.html`;
  try {
    const result = await upstream.callTool(
      { name: 'visual_explainer_render_html', arguments: { filename: transientFilename, html: sourceHtml, open: false } },
      undefined,
      { timeout: 180000 },
    );
    if (result.isError) {
      throw new ApiError(400, result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Rendering failed');
    }
    const renderedPath = result.structuredContent?.path;
    if (typeof renderedPath !== 'string' || resolve(renderedPath) !== join(outputDir, transientFilename)) {
      throw new Error('Upstream returned an unexpected path for skill explainer render');
    }
    const renderedBytes = await regularBytes(transientFilename);
    if (!renderedBytes) throw new ApiError(502, 'Upstream renderer did not produce rendered HTML');
    const renderedHtml = renderedBytes.toString('utf8');
    const doc = parse(renderedHtml);
    const parsedTitle = doc.querySelector('title')?.textContent.trim() || '';
    const parsedSummary = extractSummary(doc);
    await captureSkillThumbnails(renderedHtml, explainerId);
    result.structuredContent = {
      ...result.structuredContent,
      explainerId,
      url: new URL(`/api/skills/explainers/${encodeExplainerPath(explainerId)}/html`, publicUrl).href,
    };
    return { renderedHtml, render: result, parsedTitle, parsedSummary };
  } finally {
    const names = await readdir(outputDir).catch(() => []);
    for (const name of names) {
      if (name.startsWith(prefix)) {
        await rm(join(outputDir, name), { force: true }).catch(() => console.error('Skill render transient cleanup failed', { name }));
      }
    }
  }
}

async function renderLocked(args, apiFilename = false, params = { name: 'visual_explainer_render_html' }, location = null, sourceBytes = null, note = '') {
  fields(args, ['filename', 'html', 'entityId', 'note'], ['filename', 'html']);
  const publishNote = cleanNote(note || args.note);
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
  const renderedBytes = await regularBytes(filename);
  if (renderedBytes) await captureThumbnails(renderedBytes.toString('utf8'), filename);
  else await removeThumbs(filename);
  await catalog.assign(filename, assigned, logical);
  const revision = await history.snapshot(publishNote ? `Publish page ${filename}: ${publishNote}` : `Publish page ${filename}`);
  const latest = await history.latestVersion(filename);
  const page = await requirePage(filename);
  const open = comments.list(filename, { status: 'open' }).threads;
  const commentsUrl = new URL(`/api/pages/${encodeURIComponent(filename)}/comments`, publicUrl).href;
  result.structuredContent = { ...result.structuredContent, url: page.url, entityId: assigned };
  result.content.push({ type: 'text', text: `View: ${page.url}\nThis link grants read access to this page. Reusing the filename replaces it; use unique filenames for immutable reports.` });
  return {
    page, render: result, created: !before, revision,
    version: latest ? { number: latest.version, label: latest.label, revision: latest.revision, note: latest.note } : null,
    commentsUrl, openComments: open,
  };
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
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params?.uri;
    const docId = typeof uri === 'string' ? skills.docIdFromUri(uri) : null;
    if (docId && skills.hasDoc(docId)) {
      return {
        contents: [{ uri, mimeType: 'text/markdown', text: skills.getEffectiveDoc(docId) }],
      };
    }
    return upstream.readResource(request.params);
  });
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
      const body = req.method === 'HEAD' ? '' : (url.searchParams.get('embed') === '1' ? injectEmbedBridge(bytes) : bytes);
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts; frame-ancestors \'self\'');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return send(res, 200, body, 'text/html; charset=utf-8');
    }
    if (url.pathname.startsWith('/versions/') && ['GET', 'HEAD'].includes(req.method)) {
      const parts = url.pathname.split('/');
      if (parts.length !== 5) throw new ApiError(404, 'Not found');
      const filename = pageFilename(decodeSegment(parts[3])), revision = parts[4];
      if (!equal(parts[2], versionSignature(filename, revision))) throw new ApiError(404, 'Not found');
      return await catalog.run(async () => {
        const saved = await history.version(filename, revision);
        const body = req.method === 'HEAD' ? '' : (url.searchParams.get('embed') === '1' ? injectEmbedBridge(saved.rendered) : saved.rendered);
        res.setHeader('Content-Security-Policy', 'sandbox allow-scripts; frame-ancestors \'self\'');
        res.setHeader('Referrer-Policy', 'no-referrer');
        return send(res, 200, body, 'text/html; charset=utf-8');
      });
    }
    if (url.pathname.startsWith('/s/') && ['GET', 'HEAD'].includes(req.method)) {
      const parts = url.pathname.split('/');
      const head = req.method === 'HEAD';
      if (parts.length !== 3 || !parts[2]) {
        return send(res, 404, head ? '' : guestErrorHtml('Share link not found', 'Share link not found or revoked.'), 'text/html; charset=utf-8');
      }
      const resolved = shares.resolve(parts[2]);
      if (resolved.status === 'not_found') {
        return send(res, 404, head ? '' : guestErrorHtml('Share link not found', 'Share link not found or revoked.'), 'text/html; charset=utf-8');
      }
      if (resolved.status === 'expired') {
        return send(res, 410, head ? '' : guestErrorHtml('Share link expired', 'This share link has expired.'), 'text/html; charset=utf-8');
      }
      const bytes = await regularBytes(resolved.share.filename).catch(error => {
        if (error instanceof ApiError && error.status === 409) return null;
        throw error;
      });
      if (bytes === null) {
        return send(res, 404, head ? '' : guestErrorHtml('Share link not found', 'Share link not found or revoked.'), 'text/html; charset=utf-8');
      }
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts; frame-ancestors \'self\'');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return send(res, 200, head ? '' : bytes, 'text/html; charset=utf-8');
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
        if (hasSession(req, 'admin') || hasSession(req, 'legacy')) setSession(res, 'admin');
        else {
          const acct = readAccountSession(req);
          if (acct) setSession(res, 'account', acct.accountId);
          else setSession(res, 'viewer');
        }
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
      if (equal(key, token)) {
        setSession(res, 'admin');
        return send(res, 200, 'ok');
      }
      const acct = accounts.authenticate(key);
      if (acct) {
        setSession(res, 'account', acct.id);
        return send(res, 200, 'ok');
      }
      throw new ApiError(401, 'Invalid access key');
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      if (req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Unexpected Origin');
      res.setHeader('Set-Cookie', Object.values(sessionCookies).map(({ name }) => `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${publicUrl.protocol === 'https:' ? '; Secure' : ''}`));
      return send(res, 200, 'ok');
    }
    if (url.pathname.startsWith('/api/')) {
      const apiParts = url.pathname.split('/').slice(2).map(decodeSegment);
      if (apiParts.length === 2 && apiParts[0] === 'skills' && apiParts[1] === 'events' && req.method === 'GET') {
        if (req.headers.origin && req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Unexpected Origin');
        const auth = identity(req);
        if (auth.role !== 'admin' && auth.role !== 'skill-editor') {
          throw new ApiError(403, 'Admin or skill editor access required');
        }
        const rawExplainer = url.searchParams.get('explainer');
        const explainerId = rawExplainer ? validateExplainerId(rawExplainer) : null;
        const onceRaw = (url.searchParams.get('once') ?? '').trim().toLowerCase();
        const once = onceRaw === '1' || onceRaw === 'true';
        skillEvents.subscribe(req, res, {
          entityId: '__skills__',
          filename: explainerId,
          path: explainerId ?? '',
          events: url.searchParams.get('events'),
          once,
          timeoutSec: url.searchParams.get('timeout'),
          after: url.searchParams.get('after'),
          client: url.searchParams.get('client') ?? '',
          ip: req.socket?.remoteAddress,
          tokenId: auth.keyId ?? (auth.accountId && !auth.builtIn ? `account:${auth.accountId}` : null),
        });
        return;
      }
      if (apiParts.length === 3 && apiParts[0] === 'entities' && apiParts[2] === 'events' && req.method === 'GET') {
        if (req.headers.origin && req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Unexpected Origin');
        const id = apiParts[1];
        const subTarget = await catalog.run(async () => {
          const auth = identity(req);
          const allowed = (auth.role === 'agent' && id === auth.entityId) || auth.role === 'admin' || auth.role === 'user';
          if (!allowed) throw new ApiError(403, 'Entity-scoped access only');
          catalog.entity(id);
          const rawPath = url.searchParams.get('path');
          let filename = null;
          let path = '';
          if (rawPath) {
            path = logicalPath(rawPath, true);
            filename = catalog.find(id, path);
            if (!filename) throw new ApiError(404, 'File not found');
            await requirePage(filename);
          }
          return {
            entityId: id,
            filename,
            path,
            tokenId: auth.tokenId ?? (auth.accountId && !auth.builtIn ? `account:${auth.accountId}` : null),
            expiresAt: auth.expiresAt ?? null,
          };
        });
        const onceRaw = (url.searchParams.get('once') ?? '').trim().toLowerCase();
        const once = onceRaw === '1' || onceRaw === 'true';
        events.subscribe(req, res, {
          entityId: subTarget.entityId,
          filename: subTarget.filename,
          path: subTarget.path,
          events: url.searchParams.get('events'),
          once,
          timeoutSec: url.searchParams.get('timeout'),
          after: url.searchParams.get('after'),
          client: url.searchParams.get('client') ?? '',
          ip: req.socket?.remoteAddress,
          inScope: catalog.inScope,
          tokenId: subTarget.tokenId,
          expiresAt: subTarget.expiresAt,
        });
        return;
      }
      return await catalog.run(async () => {
        const auth = identity(req);
        const parts = apiParts;
        const isWorkspaceMember = auth.role === 'admin' || auth.role === 'user';
        const originalRead = originalReadonly(parts, req.method);
        const mutation = !['GET', 'HEAD'].includes(req.method) && !originalRead;
        if (req.headers.origin && req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Unexpected Origin');
        const [resource, id, action] = parts;
        if (resource === 'skills' && auth.role !== 'admin' && auth.role !== 'skill-editor') {
          throw new ApiError(403, 'Admin or skill editor access required');
        }
        if (mutation && auth.role === 'viewer') throw new ApiError(401, 'Admin authentication required');
        if (mutation && isWorkspaceMember && !auth.bearer && req.headers.origin !== publicUrl.origin) throw new ApiError(403, 'Same-origin Origin required');
        if (resource === 'session' && parts.length === 1 && req.method === 'GET') {
          if (auth.legacy) setSession(res, 'admin');
          return json(res, 200, {
            role: auth.role,
            ...(auth.accountId ? { accountId: auth.accountId, name: auth.name, builtIn: auth.builtIn } : {}),
            ...(auth.entityId ? { entityId: auth.entityId } : {}),
            ...(auth.keyId ? { keyId: auth.keyId, name: auth.name } : {}),
          });
        }
        if (auth.role === 'skill-editor') {
          if (resource !== 'skills' && !originalRead) {
            throw new ApiError(403, 'Skill-scoped access only');
          }
        }
        if (resource === 'skills') {
          if (parts.length === 1 && req.method === 'GET') {
            const overview = skills.overview();
            return json(res, 200, {
              ...overview,
              explainers: overview.explainers.map(exposeSkillExplainer),
              listeners: skillEvents.hostSummary({ entityId: '__skills__' }),
            });
          }
          if (parts.length === 2 && id === 'settings' && req.method === 'PATCH') {
            if (auth.role !== 'admin') throw new ApiError(403, 'Admin session required to change skill edit lock');
            const body = await readJson(req, 4096);
            fields(body, ['editEnabled'], ['editEnabled']);
            const editEnabled = await skills.setEditEnabled(body.editEnabled);
            return json(res, 200, { editEnabled });
          }
          if (id === 'keys') {
            if (auth.role !== 'admin') throw new ApiError(403, 'Admin session required to manage skill editor keys');
            if (parts.length === 2 && req.method === 'GET') {
              return json(res, 200, { keys: skills.listKeys() });
            }
            if (parts.length === 2 && req.method === 'POST') {
              requireSkillsEditEnabled();
              const body = await readOptionalJson(req, 4096);
              fields(body, ['name'], []);
              return json(res, 201, await skills.createKey({ name: body.name, createdBy: auth.name || 'Owner' }));
            }
            if (parts.length === 3 && req.method === 'DELETE') {
              await skills.revokeKey(parts[2]);
              skillEvents.disconnectByToken(parts[2], 'Skill editor key revoked');
              return send(res, 204, '');
            }
          }
          if (id === 'templates') {
            if (parts.length === 2 && req.method === 'GET') {
              return json(res, 200, {
                defaultTemplate: skills.defaultTemplate(),
                templates: skills.listTemplates(),
              });
            }
            if (parts.length === 2 && req.method === 'POST') {
              requireSkillsEditEnabled();
              const body = await readJson(req, 2 * 1024 * 1024);
              fields(body, ['id', 'content', 'note'], ['id', 'content']);
              const note = cleanNote(body.note ?? url.searchParams.get('note') ?? req.headers['x-ve-note']);
              const result = await skills.createTemplate(body.id, body.content, { note, actor: auth.name || 'Owner' });
              return json(res, 201, result);
            }
            if (parts.length === 4 && parts[3] === 'default' && req.method === 'PATCH') {
              requireSkillsEditEnabled();
              const body = await readOptionalJson(req, 4096);
              fields(body, [], []);
              return json(res, 200, await skills.setDefaultTemplate(parts[2]));
            }
            if (parts.length === 3 && req.method === 'DELETE') {
              requireSkillsEditEnabled();
              const body = await readOptionalJson(req, 4096);
              fields(body, ['note'], []);
              const note = cleanNote(body.note ?? url.searchParams.get('note') ?? req.headers['x-ve-note']);
              return json(res, 200, await skills.deleteTemplate(parts[2], { note, actor: auth.name || 'Owner' }));
            }
          }
          if (id === 'docs' && parts.length >= 3) {
            if (parts.length >= 4 && parts.at(-1) === 'reset' && req.method === 'POST') {
              requireSkillsEditEnabled();
              const docId = parts.slice(2, -1).join('/');
              const body = await readOptionalJson(req, 4096);
              fields(body, ['note'], []);
              const result = await skills.resetDoc(docId, { note: cleanNote(body.note), actor: auth.name || 'Owner' });
              return json(res, 200, result);
            }
            const docId = parts.slice(2).join('/');
            if (req.method === 'GET') {
              return json(res, 200, await skills.getDoc(docId));
            }
            if (req.method === 'PUT') {
              requireSkillsEditEnabled();
              const rawContentType = (req.headers['content-type'] ?? '').trim();
              const mediaType = rawContentType.split(';')[0].trim().toLowerCase();
              let content, note;
              if (mediaType === 'application/json' || mediaType === '') {
                const body = await readJson(req, 2 * 1024 * 1024);
                fields(body, ['content', 'note'], ['content']);
                content = body.content;
                note = cleanNote(body.note ?? url.searchParams.get('note') ?? req.headers['x-ve-note']);
              } else if (mediaType === 'text/markdown' || mediaType === 'text/plain') {
                const bytes = await readBody(req, 2 * 1024 * 1024, true);
                try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
                catch { throw new ApiError(400, 'Skill document must be valid UTF-8'); }
                note = cleanNote(url.searchParams.get('note') ?? req.headers['x-ve-note']);
              } else {
                throw new ApiError(415, 'Use Content-Type: application/json, text/markdown, or text/plain');
              }
              return json(res, 200, await skills.updateDoc(docId, content, { note, actor: auth.name || 'Owner' }));
            }
          }
          if (id === 'explainers' && parts.length >= 3) {
            const tail = parts.at(-1);
            if (parts.length >= 4 && tail === 'source' && req.method === 'GET') {
              const explainerId = parts.slice(2, -1).join('/');
              const sourceHtml = skills.getExplainerSource(explainerId);
              res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
              res.setHeader('Referrer-Policy', 'no-referrer');
              return send(res, 200, sourceHtml, 'text/html; charset=utf-8');
            }
            if (parts.length >= 4 && tail === 'html' && ['GET', 'HEAD'].includes(req.method)) {
              const explainerId = parts.slice(2, -1).join('/');
              const renderedHtml = skills.getExplainerHtml(explainerId);
              const body = req.method === 'HEAD' ? '' : (url.searchParams.get('embed') === '1' ? injectEmbedBridge(renderedHtml) : renderedHtml);
              res.setHeader('Content-Security-Policy', "sandbox allow-scripts; frame-ancestors 'self'");
              res.setHeader('Referrer-Policy', 'no-referrer');
              return send(res, 200, body, 'text/html; charset=utf-8');
            }
            if (parts.length >= 4 && tail === 'thumb' && ['GET', 'HEAD'].includes(req.method)) {
              const explainerId = parts.slice(2, -1).join('/');
              const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
              const renderedHtml = skills.getExplainerHtml(explainerId);
              let bytes = await skills.readThumb(explainerId, theme);
              if (bytes === null) {
                await captureSkillThumbnails(renderedHtml, explainerId);
                bytes = await skills.readThumb(explainerId, theme);
                if (bytes === null && theme === 'dark') bytes = await skills.readThumb(explainerId, 'light');
              }
              if (bytes === null) throw new ApiError(404, 'Explainer thumbnail not found');
              res.writeHead(200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'private, max-age=60',
                'X-Content-Type-Options': 'nosniff',
              });
              return res.end(req.method === 'HEAD' ? '' : bytes);
            }
            if (parts.length >= 4 && tail === 'anchors' && req.method === 'GET') {
              const explainerId = parts.slice(2, -1).join('/');
              const renderedHtml = skills.getExplainerHtml(explainerId);
              const limit = parseAnchorLimit(url.searchParams.get('limit'));
              const anchors = extractPageAnchors(renderedHtml, { limit });
              return json(res, 200, { explainerId, anchors });
            }
            const explainerId = parts.slice(2).join('/');
            if (req.method === 'GET') {
              return json(res, 200, exposeSkillExplainer(skills.getExplainer(explainerId)));
            }
            if (req.method === 'PUT') {
              requireSkillsEditEnabled();
              if (!/^text\/html(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(req.headers['content-type'] ?? '')) {
                throw new ApiError(415, 'Use Content-Type: text/html; charset=utf-8');
              }
              const bytes = await readBody(req, 12 * 1024 * 1024, true);
              let sourceHtml;
              try { sourceHtml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
              catch { throw new ApiError(400, 'HTML must be valid UTF-8'); }
              const skillHash = req.headers['x-ve-skill-hash'] ?? url.searchParams.get('skillHash');
              const coversInput = req.headers['x-ve-covers'] ?? url.searchParams.get('covers');
              const note = cleanNote(url.searchParams.get('note') ?? req.headers['x-ve-note']);
              const verified = skills.verifyExplainerHash(explainerId, { covers: coversInput, skillHash });
              const rendered = await renderSkillExplainerLocked(explainerId, sourceHtml);
              const titleInput = req.headers['x-ve-title'] ?? url.searchParams.get('title') ?? (rendered.parsedTitle || undefined);
              const summaryInput = req.headers['x-ve-summary'] ?? url.searchParams.get('summary') ?? (rendered.parsedSummary || undefined);
              const layerInput = req.headers['x-ve-layer'] ?? url.searchParams.get('layer');
              const parentInput = req.headers['x-ve-parent'] ?? url.searchParams.get('parentId');
              const saved = await skills.updateExplainer(explainerId, {
                html: rendered.renderedHtml,
                sourceHtml,
                title: titleInput,
                summary: summaryInput,
                layer: layerInput,
                parentId: parentInput !== null && parentInput !== undefined ? parentInput : undefined,
                covers: verified.covers,
                skillHash: verified.expectedSkillHash,
                note,
                actor: auth.name || 'Owner',
              });
              return json(res, 200, {
                explainer: exposeSkillExplainer(saved.explainer),
                render: rendered.render,
                version: saved.version,
                synced: true,
              });
            }
          }
          if (id === 'versions') {
            if (parts.length === 2 && req.method === 'GET') {
              const docFilter = url.searchParams.get('doc') || null;
              return json(res, 200, { versions: skills.versions(docFilter) });
            }
            if (parts.length === 4 && parts[3] === 'diff' && req.method === 'GET') {
              return json(res, 200, await skills.versionDiff(parts[2]));
            }
          }
          if (id === 'rollback' && parts.length === 2 && req.method === 'POST') {
            requireSkillsEditEnabled();
            const body = await readJson(req, 4096);
            fields(body, ['version', 'revision', 'note'], []);
            const targetRef = body.revision ?? body.version;
            if (targetRef === undefined || targetRef === null || targetRef === '') {
              throw new ApiError(400, 'Expected version or revision');
            }
            const result = await skills.rollback(targetRef, { note: cleanNote(body.note), actor: auth.name || 'Owner' });
            return json(res, 200, {
              ...result,
              explainers: result.explainers.map(exposeSkillExplainer),
            });
          }
          if (id === 'comments') {
            if (parts.length === 2 && req.method === 'GET') {
              const filter = url.searchParams.get('status') || 'all';
              const rawExplainer = url.searchParams.get('explainer');
              const explainerId = rawExplainer ? validateExplainerId(rawExplainer) : null;
              const { threads, counts } = skillComments.list(explainerId, { status: filter });
              const summary = formatCommentsSummary(threads, explainerId ? { filename: explainerId, path: explainerId, title: explainerId } : null);
              const listeners = skillEvents.hostSummary({ entityId: '__skills__', filename: explainerId });
              return json(res, 200, { explainerId, counts, threads, summary, listeners });
            }
            if (parts.length === 2 && req.method === 'POST') {
              requireSkillsEditEnabled();
              const body = await readJson(req, 32768);
              fields(body, ['explainerId', 'explainer', 'body', 'where', 'replyTo', 'version', 'revision', 'authorName'], ['body']);
              const actor = commentActor(body.authorName, auth);
              if (body.replyTo !== undefined) {
                const explicitExplainer = body.explainerId ?? body.explainer ?? null;
                const result = await skillComments.reply({ filename: explicitExplainer, threadId: body.replyTo, author: actor, body: body.body });
                if (auth.role === 'admin') {
                  skillEvents.emit({
                    type: 'comment.replied',
                    entityId: '__skills__',
                    filename: result.thread.filename,
                    path: result.thread.filename,
                    payload: { threadId: result.thread.id, explainerId: result.thread.filename, reply: result.reply, reopened: result.reopened, thread: result.thread, author: actor },
                  });
                }
                return json(res, 201, result);
              }
              const targetExplainer = body.explainerId ?? body.explainer;
              if (!targetExplainer) throw new ApiError(400, 'explainerId is required');
              validateExplainerId(targetExplainer);
              const latest = skills.overview().latestVersion;
              const verNum = body.version !== undefined ? parseVersionQuery(body.version) : (latest?.version ?? null);
              const rev = body.revision ?? latest?.revision ?? null;
              const normalizedWhere = normalizeWhere(body.where);
              let renderedHtml = '';
              try { renderedHtml = skills.getExplainerHtml(targetExplainer); } catch {}
              const resolvedAnchor = resolveCommentWhere(renderedHtml, normalizedWhere);
              const result = await skillComments.create({ filename: targetExplainer, version: verNum, revision: rev, where: resolvedAnchor.where, author: actor, body: body.body });
              if (auth.role === 'admin') {
                skillEvents.emit({
                  type: 'comment.created',
                  entityId: '__skills__',
                  filename: targetExplainer,
                  path: targetExplainer,
                  payload: { threadId: result.thread.id, explainerId: targetExplainer, thread: result.thread, author: actor },
                });
              }
              return json(res, 201, { ...result, anchorMatched: resolvedAnchor.anchorMatched, matchedCount: resolvedAnchor.matchedCount });
            }
            if (parts.length === 3 && parts[2] === 'dispatch' && req.method === 'POST') {
              requireSkillsEditEnabled();
              const body = await readOptionalJson(req, 8192);
              fields(body, ['explainerId', 'explainer', 'note'], []);
              const note = cleanNote(body.note);
              const rawExplainer = body.explainerId ?? body.explainer ?? null;
              const explainerId = rawExplainer ? validateExplainerId(rawExplainer) : null;
              const { threads, counts } = skillComments.list(explainerId, { status: 'open' });
              const summary = formatCommentsSummary(threads, explainerId ? { filename: explainerId, path: explainerId, title: explainerId } : null);
              const delivered = skillEvents.emit({
                type: 'comment.dispatch',
                entityId: '__skills__',
                filename: explainerId,
                path: explainerId ?? '',
                payload: { explainerId, note, openCount: counts.open, threads, summary, dispatchedBy: auth.name || 'Owner' },
              });
              const listeners = skillEvents.hostSummary({ entityId: '__skills__', filename: explainerId });
              return json(res, 200, {
                ok: true,
                eventId: delivered.event.id,
                explainerId,
                openCount: counts.open,
                deliveredHosts: delivered.deliveredHosts,
                deliveredConnections: delivered.deliveredConnections,
                listeners,
              });
            }
            if (parts.length === 4 && parts[3] === 'dispatch' && req.method === 'POST') {
              requireSkillsEditEnabled();
              const body = await readOptionalJson(req, 8192);
              fields(body, ['note'], []);
              const note = cleanNote(body.note);
              const thread = skillComments.getThread(parts[2]);
              const explainerId = thread.filename;
              const { threads, counts } = skillComments.list(explainerId, { status: 'open' });
              const summary = formatCommentsSummary(threads.length ? threads : [thread], { filename: explainerId, path: explainerId, title: explainerId });
              const delivered = skillEvents.emit({
                type: 'comment.dispatch',
                entityId: '__skills__',
                filename: explainerId,
                path: explainerId,
                payload: {
                  threadId: thread.id,
                  thread,
                  explainerId,
                  note,
                  openCount: counts.open,
                  threads,
                  summary,
                  dispatchedBy: auth.name || 'Owner',
                },
              });
              const listeners = skillEvents.hostSummary({ entityId: '__skills__', filename: explainerId });
              return json(res, 200, {
                ok: true,
                eventId: delivered.event.id,
                threadId: thread.id,
                explainerId,
                openCount: counts.open,
                deliveredHosts: delivered.deliveredHosts,
                deliveredConnections: delivered.deliveredConnections,
                listeners,
              });
            }
            if (parts.length === 4 && ['resolve', 'reopen'].includes(parts[3]) && req.method === 'POST') {
              requireSkillsEditEnabled();
              const threadId = parts[2];
              const body = await readOptionalJson(req, 16384);
              fields(body, parts[3] === 'resolve' ? ['note', 'authorName'] : [], []);
              if (parts[3] === 'resolve') {
                const actor = commentActor(body.authorName, auth);
                return json(res, 200, await skillComments.resolve({ threadId, actor, note: body.note ?? '' }));
              }
              const result = await skillComments.reopen({ threadId });
              if (auth.role === 'admin' && result.changed) {
                skillEvents.emit({
                  type: 'comment.reopened',
                  entityId: '__skills__',
                  filename: result.thread.filename,
                  path: result.thread.filename,
                  payload: { threadId: result.thread.id, explainerId: result.thread.filename, thread: result.thread },
                });
              }
              return json(res, 200, result);
            }
            if (parts.length === 3 && req.method === 'PATCH') {
              requireSkillsEditEnabled();
              const body = await readJson(req, 32768);
              fields(body, ['body'], ['body']);
              return json(res, 200, await skillComments.edit({ commentId: parts[2], body: body.body }));
            }
            if (parts.length === 3 && req.method === 'DELETE') {
              requireSkillsEditEnabled();
              return json(res, 200, await skillComments.remove({ commentId: parts[2] }));
            }
          }
          throw new ApiError(404, 'Skill endpoint not found');
        }
        if (resource === 'session' && id === 'name' && parts.length === 2 && req.method === 'PATCH') {
          if (!isWorkspaceMember) throw new ApiError(403, 'Account authentication required');
          const body = await readJson(req, 4096);
          fields(body, ['name'], ['name']);
          const account = await accounts.rename(auth.accountId, body.name);
          return json(res, 200, { account });
        }
        if (resource === 'accounts') {
          if (auth.role !== 'admin') throw new ApiError(403, 'Admin authentication required');
          if (parts.length === 1 && req.method === 'GET') return json(res, 200, accounts.list());
          if (parts.length === 1 && req.method === 'POST') {
            const body = await readJson(req, 4096);
            fields(body, ['name', 'role'], ['name']);
            return json(res, 201, await accounts.create({ name: body.name, role: body.role ?? 'user' }));
          }
          if (parts.length === 2 && req.method === 'PATCH') {
            const body = await readJson(req, 4096);
            fields(body, ['name'], ['name']);
            return json(res, 200, { account: await accounts.rename(id, body.name) });
          }
          if (parts.length === 2 && req.method === 'DELETE') {
            await accounts.remove(id);
            events.disconnectByToken(`account:${id}`, 'Account deleted');
            skillEvents.disconnectByToken(`account:${id}`, 'Account deleted');
            return send(res, 204, '');
          }
        }
        if (auth.role === 'agent') {
          const scoped = resource === 'entities' && id === auth.entityId &&
            ((action === 'tree' && parts.length === 3 && req.method === 'GET') ||
             (action === 'folders' && parts.length === 3 && ['POST', 'PATCH', 'DELETE'].includes(req.method)) ||
             (action === 'files' && parts.length >= 4 && ['GET', 'PUT', 'PATCH'].includes(req.method)) ||
             (action === 'versions' && parts.length === 3 && req.method === 'GET') ||
             (action === 'anchors' && parts.length === 3 && req.method === 'GET') ||
             (action === 'comments' && ((parts.length === 3 && ['GET', 'POST'].includes(req.method)) ||
               (parts.length === 5 && ['resolve', 'reopen'].includes(parts[4]) && req.method === 'POST'))));
          const ownPage = resource === 'pages' &&
            ((action === 'versions' && [3, 4].includes(parts.length) && req.method === 'GET') ||
             (action === 'thumb' && parts.length === 3 && ['GET', 'HEAD'].includes(req.method)) ||
             (action === 'anchors' && parts.length === 3 && req.method === 'GET') ||
             (action === 'restore' && parts.length === 3 && req.method === 'POST') ||
             (action === 'comments' && ((parts.length === 3 && ['GET', 'POST'].includes(req.method)) ||
               (parts.length === 5 && ['resolve', 'reopen'].includes(parts[4]) && req.method === 'POST'))));
          if (!scoped && !ownPage && !originalRead) throw new ApiError(403, 'Entity-scoped access only');
          if (ownPage && !catalog.inScope(auth.entityId, catalog.assignment(id))) throw new ApiError(403, 'Page is outside current folder scope');
        }
        if (resource === 'visual-explainer') return serveOriginal(req, res, parts, url);
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
          events.disconnectByEntity(id, 'Folder deleted');
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
          if (!isWorkspaceMember) throw new ApiError(auth.role === 'viewer' && mutation ? 401 : 403, 'Admin authentication required');
          if (parts.length === 3 && req.method === 'GET') return json(res, 200, { tokens: tokens.list(id) });
          if (parts.length === 3 && req.method === 'POST') {
            const body = await readJson(req, 4096); fields(body, ['name', 'expiresIn'], []);
            return json(res, 201, await tokens.create(id, body.name, body.expiresIn));
          }
          if (parts.length === 4 && req.method === 'PATCH') {
            const body = await readJson(req, 4096); fields(body, ['expiresIn'], ['expiresIn']);
            const result = await tokens.setExpiry(id, parts[3], body.expiresIn);
            events.updateTokenExpiry(parts[3], result.token.expiresAt ?? null);
            return json(res, 200, result);
          }
          if (parts.length === 4 && req.method === 'DELETE') {
            await tokens.revoke(id, parts[3]);
            events.disconnectByToken(parts[3], 'Token revoked');
            return send(res, 204, '');
          }
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
            if (req.headers['if-none-match'] === '*' && filename) throw new ApiError(409, 'A page with this name already exists');
            if (!/^text\/html(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'Use Content-Type: text/html; charset=utf-8');
            const bytes = await readBody(req, 12 * 1024 * 1024, true);
            let html;
            try { html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
            catch { throw new ApiError(400, 'HTML must be valid UTF-8'); }
            const physical = filename ?? `${randomUUID()}.html`;
            const note = cleanNote(url.searchParams.get('note') ?? req.headers['x-ve-note']);
            const result = requireRender(await renderLocked({ filename: physical, html }, true, undefined, location, bytes, note));
            return json(res, filename ? 200 : 201, {
              page: scopedPage(result.page, id), revision: result.revision,
              version: result.version, commentsUrl: result.commentsUrl, openComments: result.openComments,
              render: result.render,
            });
          }
          if (req.method === 'PATCH') {
            if (!filename) throw new ApiError(404, 'File not found');
            await requirePage(filename);
            const body = await readJson(req, 4096); fields(body, ['path'], ['path']);
            logicalPath(body.path, true);
            const target = catalog.fileLocation(id, body.path);
            const move = await catalog.movePage(filename, target.entityId, target.path, id);
            if (move.moved) await history.snapshot(`Move page ${filename}`);
            return json(res, 200, { page: scopedPage(await requirePage(filename), id) });
          }
        }
        if (resource === 'entities' && action === 'anchors' && parts.length === 3 && req.method === 'GET') {
          catalog.entity(id);
          const rawPath = url.searchParams.get('path');
          if (!rawPath) throw new ApiError(400, 'path query parameter is required');
          const path = logicalPath(rawPath, true);
          const filename = catalog.find(id, path);
          if (!filename) throw new ApiError(404, 'File not found');
          const page = await requirePage(filename);
          const bytes = await regularBytes(filename);
          if (bytes === null) throw new ApiError(404, 'Page not found');
          const limit = parseAnchorLimit(url.searchParams.get('limit'));
          const anchors = extractPageAnchors(bytes.toString('utf8'), { limit });
          return json(res, 200, { page: scopedPage(page, id), anchors });
        }
        if (resource === 'entities' && action === 'versions' && parts.length === 3 && req.method === 'GET') {
          catalog.entity(id);
          const rawPath = url.searchParams.get('path');
          if (!rawPath) throw new ApiError(400, 'path query parameter is required');
          const path = logicalPath(rawPath, true);
          const filename = catalog.find(id, path);
          if (!filename) throw new ApiError(404, 'File not found');
          const page = await requirePage(filename);
          const entity = auth.role === 'agent' ? auth.entityId : undefined;
          const versions = (await history.versions(filename, entity)).map(version => exposeVersion(filename, version));
          return json(res, 200, { page: scopedPage(page, id), versions });
        }
        if (resource === 'entities' && action === 'comments') {
          catalog.entity(id);
          if (parts.length === 3 && req.method === 'GET') {
            const filter = url.searchParams.get('status') || 'all';
            const versionFilter = parseVersionQuery(url.searchParams.get('version'));
            const rawPath = url.searchParams.get('path');
            if (rawPath) {
              const path = logicalPath(rawPath, true);
              const filename = catalog.find(id, path);
              if (!filename) throw new ApiError(404, 'File not found');
              const page = scopedPage(await requirePage(filename), id);
              const latest = await history.latestVersion(filename);
              const currentVersion = latest ? { number: latest.version, label: latest.label, revision: latest.revision, note: latest.note } : null;
              const { threads, counts } = comments.list(filename, { status: filter, version: versionFilter });
              return json(res, 200, { page, currentVersion, counts, threads, summary: formatCommentsSummary(threads, page, currentVersion) });
            }
            const scopedPages = (await listPages()).filter(page => catalog.inScope(id, page.entityId)).map(page => scopedPage(page, id));
            const items = [];
            let open = 0, resolved = 0, total = 0;
            const summaryBlocks = [];
            for (const page of scopedPages) {
              const { threads, counts } = comments.list(page.filename, { status: filter, version: versionFilter });
              open += counts.open; resolved += counts.resolved; total += counts.total;
              if (!threads.length) continue;
              const latest = await history.latestVersion(page.filename);
              const currentVersion = latest ? { number: latest.version, label: latest.label, revision: latest.revision, note: latest.note } : null;
              items.push({ page, currentVersion, counts, threads });
              summaryBlocks.push(formatCommentsSummary(threads, page, currentVersion));
            }
            return json(res, 200, {
              entityId: id, counts: { open, resolved, total }, items,
              summary: summaryBlocks.length ? summaryBlocks.join('\n\n') : 'No matching comments.',
            });
          }
          if (parts.length === 3 && req.method === 'POST') {
            const body = await readJson(req, 32768);
            fields(body, ['path', 'body', 'where', 'replyTo', 'version', 'revision', 'authorName'], ['path', 'body']);
            const path = logicalPath(body.path, true);
            const filename = catalog.find(id, path);
            if (!filename) throw new ApiError(404, 'File not found');
            const page = await requirePage(filename);
            const actor = commentActor(body.authorName, auth);
            if (body.replyTo !== undefined) {
              const result = await comments.reply({ filename, threadId: body.replyTo, author: actor, body: body.body });
              if (auth.role !== 'agent') {
                events.emit({
                  type: 'comment.replied',
                  entityId: page.entityId ?? null,
                  filename,
                  path: page.path || filename,
                  payload: { threadId: result.thread.id, reply: result.reply, reopened: result.reopened, thread: result.thread, author: actor },
                });
              }
              return json(res, 201, result);
            }
            const latest = await history.latestVersion(filename);
            const verNum = body.version !== undefined ? parseVersionQuery(body.version) : (latest?.version ?? null);
            const rev = body.revision ?? latest?.revision ?? null;
            const normalizedWhere = normalizeWhere(body.where);
            const renderedBytes = await regularBytes(filename);
            const resolvedAnchor = resolveCommentWhere(renderedBytes ? renderedBytes.toString('utf8') : '', normalizedWhere);
            const result = await comments.create({ filename, version: verNum, revision: rev, where: resolvedAnchor.where, author: actor, body: body.body });
            if (auth.role !== 'agent') {
              events.emit({
                type: 'comment.created',
                entityId: page.entityId ?? null,
                filename,
                path: page.path || filename,
                payload: { threadId: result.thread.id, thread: result.thread, author: actor },
              });
            }
            return json(res, 201, { ...result, anchorMatched: resolvedAnchor.anchorMatched, matchedCount: resolvedAnchor.matchedCount });
          }
          if (parts.length === 5 && ['resolve', 'reopen'].includes(parts[4]) && req.method === 'POST') {
            const threadId = parts[3];
            const body = await readOptionalJson(req, 16384);
            fields(body, parts[4] === 'resolve' ? ['path', 'note', 'authorName'] : ['path'], []);
            let filename;
            if (body.path) {
              filename = catalog.find(id, logicalPath(body.path, true));
              if (!filename) throw new ApiError(404, 'File not found');
            } else {
              const existing = comments.getThread(threadId);
              filename = existing.filename;
              if (!catalog.inScope(id, catalog.assignment(filename))) throw new ApiError(403, 'Comment is outside folder scope');
            }
            const page = await requirePage(filename);
            if (parts[4] === 'resolve') {
              const actor = commentActor(body.authorName, auth);
              return json(res, 200, await comments.resolve({ filename, threadId, actor, note: body.note ?? '' }));
            }
            const result = await comments.reopen({ filename, threadId });
            if (auth.role !== 'agent' && result.changed) {
              events.emit({
                type: 'comment.reopened',
                entityId: page.entityId ?? null,
                filename,
                path: page.path || filename,
                payload: { threadId: result.thread.id, thread: result.thread },
              });
            }
            return json(res, 200, result);
          }
        }
        if (resource === 'pages' && parts.length === 1 && req.method === 'GET') {
          const filter = url.searchParams.get('entityId');
          if (filter !== null && filter !== '') catalog.entity(filter);
          const pages = await listPages();
          return json(res, 200, { pages: filter === null ? pages : pages.filter(page => filter ? catalog.inScope(filter, page.entityId) : page.entityId === null) });
        }
        if (resource === 'pages' && action === 'thumb' && parts.length === 3 && ['GET', 'HEAD'].includes(req.method)) {
          await requirePage(id);
          const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
          let bytes = await regularBytes(thumbFilename(id, theme));
          if (bytes === null && theme === 'dark') bytes = await regularBytes(thumbFilename(id, 'light'));
          if (bytes === null) throw new ApiError(404, 'Thumbnail not found');
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'private, max-age=60',
            'X-Content-Type-Options': 'nosniff',
          });
          return res.end(req.method === 'HEAD' ? '' : bytes);
        }
        if (resource === 'pages' && action === 'listeners' && parts.length === 3 && req.method === 'GET') {
          if (!isWorkspaceMember) throw new ApiError(403, 'Authentication required');
          const page = await requirePage(id);
          return json(res, 200, { listeners: events.hostSummary({ entityId: page.entityId ?? null, filename: id, inScope: catalog.inScope }) });
        }
        if (resource === 'pages' && action === 'shares') {
          if (!isWorkspaceMember) throw new ApiError(auth.role === 'viewer' && mutation ? 401 : 403, 'Authentication required');
          await requirePage(id);
          if (parts.length === 3 && req.method === 'GET') return json(res, 200, { shares: shares.list(id) });
          if (parts.length === 3 && req.method === 'POST') {
            const body = await readJson(req, 4096);
            fields(body, ['expiresIn', 'label'], ['expiresIn']);
            const created = await shares.create({
              filename: id,
              expiresIn: body.expiresIn,
              label: body.label ?? '',
              createdBy: auth.name || 'Owner',
            });
            return json(res, 201, { share: created.share, url: new URL(`/s/${created.token}`, publicUrl).href });
          }
          if (parts.length === 4 && req.method === 'DELETE') {
            await shares.revoke(parts[3], id);
            return send(res, 204, '');
          }
        }
        if (resource === 'pages' && action === 'anchors' && parts.length === 3 && req.method === 'GET') {
          const page = await requirePage(id);
          const bytes = await regularBytes(id);
          if (bytes === null) throw new ApiError(404, 'Page not found');
          const limit = parseAnchorLimit(url.searchParams.get('limit'));
          const anchors = extractPageAnchors(bytes.toString('utf8'), { limit });
          return json(res, 200, { page, anchors });
        }
        if (resource === 'pages' && action === 'comments') {
          const page = await requirePage(id);
          if (parts.length === 3 && req.method === 'GET') {
            const filter = url.searchParams.get('status') || 'all';
            const versionFilter = parseVersionQuery(url.searchParams.get('version'));
            const latest = await history.latestVersion(id);
            const currentVersion = latest ? { number: latest.version, label: latest.label, revision: latest.revision, note: latest.note } : null;
            const { threads, counts } = comments.list(id, { status: filter, version: versionFilter });
            const listeners = events.hostSummary({ entityId: page.entityId ?? null, filename: id, inScope: catalog.inScope });
            return json(res, 200, { page, currentVersion, counts, threads, summary: formatCommentsSummary(threads, page, currentVersion), listeners });
          }
          if (parts.length === 4 && parts[3] === 'dispatch' && req.method === 'POST') {
            if (!isWorkspaceMember) throw new ApiError(403, 'Authentication required');
            const body = await readOptionalJson(req, 8192);
            fields(body, ['note'], []);
            const note = cleanNote(body.note);
            const latest = await history.latestVersion(id);
            const currentVersion = latest ? { number: latest.version, label: latest.label, revision: latest.revision, note: latest.note } : null;
            const { threads, counts } = comments.list(id, { status: 'open' });
            const summary = formatCommentsSummary(threads, page, currentVersion);
            const delivered = events.emit({
              type: 'comment.dispatch',
              entityId: page.entityId ?? null,
              filename: id,
              path: page.path || id,
              payload: { note, openCount: counts.open, currentVersion, threads, summary, dispatchedBy: auth.name || 'Owner' },
            });
            const listeners = events.hostSummary({ entityId: page.entityId ?? null, filename: id, inScope: catalog.inScope });
            return json(res, 200, {
              ok: true,
              eventId: delivered.event.id,
              openCount: counts.open,
              deliveredHosts: delivered.deliveredHosts,
              deliveredConnections: delivered.deliveredConnections,
              listeners,
            });
          }
          if (parts.length === 3 && req.method === 'POST') {
            const body = await readJson(req, 32768);
            fields(body, ['body', 'where', 'replyTo', 'version', 'revision', 'authorName'], ['body']);
            const actor = commentActor(body.authorName, auth);
            if (body.replyTo !== undefined) {
              const result = await comments.reply({ filename: id, threadId: body.replyTo, author: actor, body: body.body });
              if (auth.role !== 'agent') {
                events.emit({
                  type: 'comment.replied',
                  entityId: page.entityId ?? null,
                  filename: id,
                  path: page.path || id,
                  payload: { threadId: result.thread.id, reply: result.reply, reopened: result.reopened, thread: result.thread, author: actor },
                });
              }
              return json(res, 201, result);
            }
            const latest = await history.latestVersion(id);
            const verNum = body.version !== undefined ? parseVersionQuery(body.version) : (latest?.version ?? null);
            const rev = body.revision ?? latest?.revision ?? null;
            const normalizedWhere = normalizeWhere(body.where);
            const renderedBytes = await regularBytes(id);
            const resolvedAnchor = resolveCommentWhere(renderedBytes ? renderedBytes.toString('utf8') : '', normalizedWhere);
            const result = await comments.create({ filename: id, version: verNum, revision: rev, where: resolvedAnchor.where, author: actor, body: body.body });
            if (auth.role !== 'agent') {
              events.emit({
                type: 'comment.created',
                entityId: page.entityId ?? null,
                filename: id,
                path: page.path || id,
                payload: { threadId: result.thread.id, thread: result.thread, author: actor },
              });
            }
            return json(res, 201, { ...result, anchorMatched: resolvedAnchor.anchorMatched, matchedCount: resolvedAnchor.matchedCount });
          }
          if (parts.length === 5 && ['resolve', 'reopen'].includes(parts[4]) && req.method === 'POST') {
            const threadId = parts[3];
            const body = await readOptionalJson(req, 16384);
            fields(body, parts[4] === 'resolve' ? ['note', 'authorName'] : [], []);
            if (parts[4] === 'resolve') {
              const actor = commentActor(body.authorName, auth);
              return json(res, 200, await comments.resolve({ filename: id, threadId, actor, note: body.note ?? '' }));
            }
            const result = await comments.reopen({ filename: id, threadId });
            if (auth.role !== 'agent' && result.changed) {
              events.emit({
                type: 'comment.reopened',
                entityId: page.entityId ?? null,
                filename: id,
                path: page.path || id,
                payload: { threadId: result.thread.id, thread: result.thread },
              });
            }
            return json(res, 200, result);
          }
          if (parts.length === 4 && req.method === 'PATCH') {
            if (!isWorkspaceMember) throw new ApiError(403, 'Admin authentication required');
            const body = await readJson(req, 32768); fields(body, ['body'], ['body']);
            return json(res, 200, await comments.edit({ filename: id, commentId: parts[3], body: body.body }));
          }
          if (parts.length === 4 && req.method === 'DELETE') {
            if (!isWorkspaceMember) throw new ApiError(403, 'Admin authentication required');
            return json(res, 200, await comments.remove({ filename: id, commentId: parts[3] }));
          }
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
          const body = await readJson(req, 4096); fields(body, ['revision', 'version', 'note'], []);
          const targetRef = body.revision ?? body.version;
          if (targetRef === undefined || targetRef === null || targetRef === '') throw new ApiError(400, 'Expected revision or version');
          const saved = await history.version(id, targetRef, auth.role === 'agent' ? auth.entityId : undefined);
          const restoreNote = cleanNote(body.note) || (saved.version.label ? `Restored from ${saved.version.label}` : '');
          const result = requireRender(await renderLocked({ filename: id, html: saved.html }, true, undefined, { entityId: page.entityId, path: page.path }, null, restoreNote));
          return json(res, 200, { page: result.page, revision: result.revision, version: result.version });
        }
        if (resource === 'pages' && parts.length === 2 && req.method === 'GET') return json(res, 200, { page: await requirePage(id) });
        if (resource === 'pages' && parts.length === 2 && req.method === 'DELETE') {
          if (!isWorkspaceMember) throw new ApiError(403, 'Admin authentication required');
          await deletePage(id);
          return send(res, 204, '');
        }
        if (resource === 'pages' && parts.length === 2 && req.method === 'PATCH') {
          await requirePage(id);
          const body = await readJson(req, 4096); fields(body, ['entityId', 'path'], ['entityId']);
          const path = body.path ?? (body.entityId === null ? id : catalog.location(id).path);
          const target = body.entityId === null ? { entityId: null, path } : catalog.fileLocation(body.entityId, path);
          if (target.entityId === null) await requireRootNameFree(target.path, id);
          const move = await catalog.movePage(id, target.entityId, target.path);
          if (move.moved) await history.snapshot(`Move page ${id}`);
          return json(res, 200, { page: await requirePage(id) });
        }
        if (resource === 'pages' && parts.length === 2 && req.method === 'PUT') {
          canonicalFilename(id);
          if (req.headers['if-none-match'] === '*' && await readPage(id)) throw new ApiError(409, 'A page with this name already exists');
          const body = await readJson(req, 12 * 1024 * 1024); fields(body, ['html', 'entityId', 'note'], ['html']);
          const result = requireRender(await renderLocked({ ...body, filename: id }, true));
          return json(res, result.created ? 201 : 200, {
            page: result.page, render: result.render, revision: result.revision,
            version: result.version, commentsUrl: result.commentsUrl, openComments: result.openComments,
          });
        }
        throw new ApiError(404, 'Not found');
      });
    }
    if (url.pathname !== '/mcp') return send(res, 404, 'Not found');
    if (!equal(req.headers.authorization ?? '', `Bearer ${token}`)) {
      const match = req.headers.authorization?.match(/^Bearer (.+)$/);
      throw new ApiError(match && (tokens.authenticate(match[1]) || accounts.authenticate(match[1]) || skills.authenticateKey(match[1])) ? 403 : 401, 'Service Bearer token required');
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
      if (req.url?.startsWith('/api/') || req.url?.startsWith('/mcp')) {
        json(res, status, error instanceof ApiError && error.details ? { error: message, ...error.details } : { error: message });
      }
      else send(res, status, message);
    }
    else res.end();
  }
});
http.requestTimeout = 180000;
http.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log(`Visual Explainer ready: ${publicUrl.origin}/mcp`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  stopping = true;
  events.closeAll();
  skillEvents.closeAll();
  http.close();
  await closeThumbBrowser();
  await upstream.close();
  await history.close?.();
  process.exit(0);
});
