import { parse } from 'node-html-parser';

const DEFAULT_ANCHOR_LIMIT = 160;
const MAX_ANCHOR_LIMIT = 500;
const MAX_SELECTOR_LEN = 512;
const MAX_LABEL_LEN = 120;
const MAX_HEADING_LEN = 100;
const MAX_HEADINGS = 12;
const VALID_ID_RE = /^[A-Za-z_][A-Za-z0-9_:-]*$/;

const SKIP_SUBTREE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head']);
const SVG_SKIP_TAGS = new Set(['defs', 'marker', 'clippath', 'mask', 'pattern', 'lineargradient', 'radialgradient', 'filter']);
const BLOCK_TEXT_TAGS = new Set([
  'text', 'tspan', 'div', 'p', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'br', 'section', 'article',
  'header', 'footer', 'pre', 'blockquote', 'figure', 'table', 'caption',
]);

function tagOf(el) {
  if (!el || el.nodeType !== 1) return '';
  return String(el.rawTagName || el.tagName || '').toLowerCase();
}

function cleanWs(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function trimChars(value, max) {
  const chars = [...String(value ?? '')];
  return chars.length > max ? chars.slice(0, max).join('').trim() : String(value ?? '');
}

function hasClass(el, name) {
  if (!el || el.nodeType !== 1) return false;
  if (el.classList?.contains) return el.classList.contains(name);
  const cls = el.getAttribute?.('class');
  return Boolean(cls && cls.split(/\s+/).includes(name));
}

function isBridgeEl(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (cur.hasAttribute?.('data-ve-bridge-ui')) return true;
    cur = cur.parentNode;
  }
  return false;
}

function extractCleanText(el) {
  if (!el) return '';
  const chunks = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      const raw = node.text ?? node.rawText ?? '';
      if (raw) chunks.push(raw);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = tagOf(node);
    if (SKIP_SUBTREE_TAGS.has(tag) || SVG_SKIP_TAGS.has(tag) || node.hasAttribute?.('data-ve-bridge-ui')) return;
    const sep = BLOCK_TEXT_TAGS.has(tag);
    if (sep) chunks.push(' ');
    for (const child of node.childNodes || []) walk(child);
    if (sep) chunks.push(' ');
  }
  walk(el);
  return cleanWs(chunks.join(''));
}

export function cssEscapeIdent(value) {
  const str = String(value);
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x0000) { result += '\uFFFD'; continue; }
    if ((code >= 0x0001 && code <= 0x001f) || code === 0x007f ||
        (i === 0 && code >= 0x0030 && code <= 0x0039) ||
        (i === 1 && code >= 0x0030 && code <= 0x0039 && str.charCodeAt(0) === 0x002d)) {
      result += '\\' + code.toString(16) + ' ';
      continue;
    }
    if (i === 0 && str.length === 1 && code === 0x002d) {
      result += '\\' + str.charAt(i);
      continue;
    }
    if (code >= 0x0080 || code === 0x002d || code === 0x005f ||
        (code >= 0x0030 && code <= 0x0039) ||
        (code >= 0x0041 && code <= 0x005a) ||
        (code >= 0x0061 && code <= 0x007a)) {
      result += str.charAt(i);
      continue;
    }
    result += '\\' + str.charAt(i);
  }
  return result;
}

export function escapeCssAttrValue(value) {
  return cleanWs(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeQueryAll(doc, selector) {
  if (!doc || typeof selector !== 'string' || !selector.trim()) return [];
  try {
    return doc.querySelectorAll(selector) || [];
  } catch {
    return [];
  }
}

function isUniqueSelector(doc, selector, target) {
  if (!selector || selector.length > MAX_SELECTOR_LEN) return false;
  const matches = safeQueryAll(doc, selector);
  return matches.length === 1 && matches[0] === target;
}

function computeUniqueSelector(doc, el) {
  if (!doc || !el || el.nodeType !== 1) return '';
  const tag = tagOf(el);
  if (!tag || tag === 'html') return '';

  const id = (el.getAttribute?.('id') || '').trim();
  if (id && VALID_ID_RE.test(id)) {
    const byId = '#' + cssEscapeIdent(id);
    if (isUniqueSelector(doc, byId, el)) return byId;
  }

  const ref = cleanWs(el.getAttribute?.('data-ref'));
  if (ref) {
    const escaped = escapeCssAttrValue(ref);
    const byRef = `[data-ref="${escaped}"]`;
    if (isUniqueSelector(doc, byRef, el)) return byRef;
    const byTagRef = `${cssEscapeIdent(tag)}[data-ref="${escaped}"]`;
    if (isUniqueSelector(doc, byTagRef, el)) return byTagRef;
  }

  const child = cleanWs(el.getAttribute?.('data-ve-child'));
  if (child) {
    const escaped = escapeCssAttrValue(child);
    const byChild = `[data-ve-child="${escaped}"]`;
    if (isUniqueSelector(doc, byChild, el)) return byChild;
    const byTagChild = `${cssEscapeIdent(tag)}[data-ve-child="${escaped}"]`;
    if (isUniqueSelector(doc, byTagChild, el)) return byTagChild;
  }

  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && parts.length < 32) {
    const local = tagOf(cur);
    if (!local || local === 'html') break;
    if (cur !== el) {
      const curId = (cur.getAttribute?.('id') || '').trim();
      if (curId && VALID_ID_RE.test(curId)) {
        const byId = '#' + cssEscapeIdent(curId);
        if (isUniqueSelector(doc, byId, cur)) {
          parts.unshift(byId);
          const anchored = parts.join(' > ');
          if (isUniqueSelector(doc, anchored, el)) return anchored;
          break;
        }
      }
    }
    const escapedTag = cssEscapeIdent(local);
    const parent = cur.parentNode;
    const sameTagSiblings = parent && parent.nodeType === 1
      ? (parent.childNodes || []).filter(n => n.nodeType === 1 && tagOf(n) === local)
      : [];
    const idx = sameTagSiblings.indexOf(cur) + 1;
    parts.unshift(sameTagSiblings.length > 1 && idx > 0 ? `${escapedTag}:nth-of-type(${idx})` : escapedTag);
    const candidate = parts.join(' > ');
    if (isUniqueSelector(doc, candidate, el)) return candidate;
    if (local === 'body') break;
    cur = parent;
  }
  const finalCandidate = parts.join(' > ');
  return finalCandidate && isUniqueSelector(doc, finalCandidate, el) ? finalCandidate : '';
}

function buildDocIndex(doc) {
  const positions = new Map();
  const headings = [];
  let counter = 0;

  function walk(node, inSvg, inSkip) {
    if (!node || node.nodeType !== 1) return;
    const tag = tagOf(node);
    const nextSkip = inSkip || SKIP_SUBTREE_TAGS.has(tag) || (inSvg && SVG_SKIP_TAGS.has(tag)) || node.hasAttribute?.('data-ve-bridge-ui');
    if (nextSkip) return;
    const pos = ++counter;
    positions.set(node, pos);
    if (!inSvg && (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4')) {
      const text = trimChars(extractCleanText(node), MAX_HEADING_LEN);
      if (text) headings.push({ pos, lvl: Number(tag.slice(1)), text });
    }
    const nextSvg = inSvg || tag === 'svg';
    for (const child of node.childNodes || []) {
      if (child.nodeType === 1) walk(child, nextSvg, false);
    }
  }

  walk(doc, false, false);
  return { positions, headings };
}

function headingTrailFor(index, el) {
  const pos = index.positions.get(el);
  if (!pos) return [];
  const stack = [];
  for (const hd of index.headings) {
    if (hd.pos > pos) break;
    while (stack.length && stack[stack.length - 1].lvl >= hd.lvl) stack.pop();
    stack.push({ lvl: hd.lvl, text: hd.text });
  }
  return stack.map(item => item.text).slice(0, MAX_HEADINGS);
}

function labelOf(el) {
  if (!el || el.nodeType !== 1) return '';
  const directAttr = cleanWs(
    el.getAttribute?.('aria-label')
    || el.getAttribute?.('data-label')
    || el.getAttribute?.('data-ref')
  );
  if (directAttr) return trimChars(directAttr, MAX_LABEL_LEN);

  const tag = tagOf(el);
  if (tag !== 'h1' && tag !== 'h2' && tag !== 'h3' && tag !== 'h4') {
    const caption = el.querySelector?.('figcaption, h1, h2, h3, h4, title');
    if (caption && !isBridgeEl(caption)) {
      const captionText = extractCleanText(caption);
      if (captionText) return trimChars(captionText, MAX_LABEL_LEN);
    }
  }

  const collapsed = extractCleanText(el);
  if (collapsed) return trimChars(collapsed, MAX_LABEL_LEN);
  const fallback = cleanWs(el.getAttribute?.('data-ve-child') || el.getAttribute?.('id'));
  return trimChars(fallback, MAX_LABEL_LEN);
}

function isPureSvgConnector(el, inSvg, text, ariaLabel, dataLabel, ref, child) {
  if (!inSvg) return false;
  if (text || ariaLabel || dataLabel || ref || child) return false;
  return hasClass(el, 've-e') || hasClass(el, 've-axis') || hasClass(el, 've-bnd');
}

function isPickableAnchor(el, inSvg) {
  const tag = tagOf(el);
  if (!tag || tag === 'html' || tag === 'body' || tag === 'main') return false;

  const hasRef = Boolean(cleanWs(el.getAttribute?.('data-ref')));
  const hasChild = Boolean(cleanWs(el.getAttribute?.('data-ve-child')));
  const id = (el.getAttribute?.('id') || '').trim();

  if (inSvg) {
    if (tag === 'g' && hasClass(el, 've-n')) return true;
    if (hasRef || hasChild) return true;
    if (tag === 'g' && Boolean(id)) return true;
    return false;
  }

  if (hasClass(el, 've-n')) return true;
  if (hasRef || hasChild) return true;
  if (tag === 'figure' || tag === 'table' || tag === 'blockquote' || tag === 'pre') return true;
  if ((tag === 'section' || tag === 'article' || tag === 'p') && Boolean(id)) return true;
  if (hasClass(el, 'card')) return true;
  if (tag === 'tr' && tagOf(el.parentNode) === 'tbody') return true;
  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') return true;
  return false;
}

export function extractPageAnchors(renderedHtml, { limit = DEFAULT_ANCHOR_LIMIT } = {}) {
  if (typeof renderedHtml !== 'string' || !renderedHtml.trim()) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_ANCHOR_LIMIT) : DEFAULT_ANCHOR_LIMIT;
  const doc = parse(renderedHtml);
  const index = buildDocIndex(doc);
  const anchors = [];
  const seenSelectors = new Set();

  function walk(node, inSvg) {
    if (!node || node.nodeType !== 1 || anchors.length >= cap) return;
    const tag = tagOf(node);
    if (SKIP_SUBTREE_TAGS.has(tag) || (inSvg && SVG_SKIP_TAGS.has(tag)) || node.hasAttribute?.('data-ve-bridge-ui')) {
      return;
    }

    if (isPickableAnchor(node, inSvg)) {
      const ariaLabel = cleanWs(node.getAttribute?.('aria-label'));
      const dataLabel = cleanWs(node.getAttribute?.('data-label'));
      const ref = cleanWs(node.getAttribute?.('data-ref'));
      const child = cleanWs(node.getAttribute?.('data-ve-child'));
      const id = (node.getAttribute?.('id') || '').trim();
      const text = extractCleanText(node);

      const emptyAnonymous = !text && !ariaLabel && !dataLabel && !ref && !child && !id;
      if (!emptyAnonymous && !isPureSvgConnector(node, inSvg, text, ariaLabel, dataLabel, ref, child)) {
        const selector = computeUniqueSelector(doc, node);
        if (selector && !seenSelectors.has(selector)) {
          seenSelectors.add(selector);
          const item = {
            selector,
            tag,
            label: labelOf(node),
            ...(ref ? { ref } : {}),
            ...(child ? { child } : {}),
            ...(id ? { id } : {}),
            headings: headingTrailFor(index, node),
          };
          anchors.push(item);
        }
      }
    }

    const nextSvg = inSvg || tag === 'svg';
    for (const childNode of node.childNodes || []) {
      if (anchors.length >= cap) break;
      if (childNode.nodeType === 1) walk(childNode, nextSvg);
    }
  }

  walk(doc, false);
  return anchors;
}

function findDeepestQuoteMatch(doc, rawQuote) {
  const needle = cleanWs(rawQuote);
  if (!needle) return null;
  const lowerNeedle = needle.toLowerCase();

  function collect(caseInsensitive) {
    const matches = [];
    let order = 0;

    function visit(node, depth, inSvg) {
      if (!node || node.nodeType !== 1) return false;
      const tag = tagOf(node);
      if (SKIP_SUBTREE_TAGS.has(tag) || (inSvg && SVG_SKIP_TAGS.has(tag)) || node.hasAttribute?.('data-ve-bridge-ui')) {
        return false;
      }

      const nextSvg = inSvg || tag === 'svg';
      let childMatched = false;
      for (const childNode of node.childNodes || []) {
        if (childNode.nodeType === 1) {
          if (visit(childNode, depth + 1, nextSvg)) childMatched = true;
        }
      }

      if (!tag || tag === 'html' || tag === 'head') return childMatched;

      const text = extractCleanText(node);
      const rawText = cleanWs(node.textContent);
      const hay = caseInsensitive ? text.toLowerCase() : text;
      const rawHay = caseInsensitive ? rawText.toLowerCase() : rawText;
      const target = caseInsensitive ? lowerNeedle : needle;
      const hit = hay.includes(target) || rawHay.includes(target);

      if (hit && !childMatched) {
        const effectiveLen = hay.includes(target) ? text.length : rawText.length;
        matches.push({ el: node, depth, textLen: effectiveLen, isBody: tag === 'body', order: ++order });
      }
      return hit || childMatched;
    }

    visit(doc, 0, false);
    if (!matches.length) return null;
    matches.sort((a, b) =>
      Number(a.isBody) - Number(b.isBody)
      || a.textLen - b.textLen
      || b.depth - a.depth
      || a.order - b.order
    );
    return matches[0].el;
  }

  return collect(false) || collect(true);
}

export function resolveCommentWhere(renderedHtml, where) {
  if (!where || where.kind === 'page') {
    return { where: { kind: 'page' }, anchorMatched: true, matchedCount: 0 };
  }

  const next = {
    ...where,
    ...(where.headings ? { headings: [...where.headings] } : {}),
  };

  if (next.kind === 'element' && next.ref && !next.selector) {
    next.selector = `[data-ref="${escapeCssAttrValue(next.ref)}"]`;
  }

  if (typeof renderedHtml !== 'string' || !renderedHtml.trim()) {
    return { where: next, anchorMatched: false, matchedCount: 0 };
  }

  const doc = parse(renderedHtml);
  const index = buildDocIndex(doc);

  if (next.kind === 'element') {
    if (!next.selector) {
      return { where: next, anchorMatched: false, matchedCount: 0 };
    }
    const matches = safeQueryAll(doc, next.selector).filter(el => !isBridgeEl(el));
    if (!matches.length) {
      return { where: next, anchorMatched: false, matchedCount: 0 };
    }
    const target = matches[0];
    if (!next.tag) {
      const tag = tagOf(target);
      if (tag) next.tag = tag.slice(0, 40);
    }
    if (!next.label) {
      const label = labelOf(target);
      if (label) next.label = label;
    }
    if (!next.headings?.length) {
      const trail = headingTrailFor(index, target);
      if (trail.length) next.headings = trail;
    }
    return { where: next, anchorMatched: true, matchedCount: matches.length };
  }

  if (next.kind === 'text') {
    if (next.selector) {
      const matches = safeQueryAll(doc, next.selector).filter(el => !isBridgeEl(el));
      if (!matches.length) {
        return { where: next, anchorMatched: false, matchedCount: 0 };
      }
      const target = matches[0];
      if (!next.tag) {
        const tag = tagOf(target);
        if (tag) next.tag = tag.slice(0, 40);
      }
      if (!next.headings?.length) {
        const trail = headingTrailFor(index, target);
        if (trail.length) next.headings = trail;
      }
      return { where: next, anchorMatched: true, matchedCount: matches.length };
    }

    if (next.quote) {
      const matchedEl = findDeepestQuoteMatch(doc, next.quote);
      if (matchedEl) {
        const selector = computeUniqueSelector(doc, matchedEl);
        if (selector) {
          next.selector = selector;
          if (!next.tag) {
            const tag = tagOf(matchedEl);
            if (tag) next.tag = tag.slice(0, 40);
          }
          if (!next.headings?.length) {
            const trail = headingTrailFor(index, matchedEl);
            if (trail.length) next.headings = trail;
          }
          return { where: next, anchorMatched: true, matchedCount: 1 };
        }
      }
    }
    return { where: next, anchorMatched: false, matchedCount: 0 };
  }

  return { where: next, anchorMatched: false, matchedCount: 0 };
}
