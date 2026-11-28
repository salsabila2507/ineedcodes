// humanize.js: post-processing pass for prose content. Scope is strict:
// it rewrites marketing/marketing-adjacent copy inside HTML pages and plain prose files
// (landing pages, posts, README-style text). It never touches code, attributes, URLs,
// JSON, YAML, or technical values. Meaning and facts are preserved.

import * as fs from 'node:fs';
import { chat } from './provider.js';
import { safeProjectPath } from './tools.js';

const PROSE_EXT = new Set(['.html', '.htm', '.md', '.markdown']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml', '.css', '.scss', '.py', '.rb', '.go', '.rs', '.java', '.php', '.sh', '.sql', '.toml', '.xml', '.svg']);

export function isHumanizableFile(absPath) {
  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase();
  if (CODE_EXT.has(ext)) return false;
  return PROSE_EXT.has(ext);
}

// Rule-based cleanups that are safe everywhere inside prose text nodes.
const RULES = [
  [/ ?\u2014 ?/g, ', '],
  [/ ?\u2013 ?/g, ', '],
  [/\bgame-?changer\b/gi, 'a real improvement'],
  [/\bcutting-?edge\b/gi, 'new'],
  [/\brevolutionar(y|ily)\b/gi, 'genuinely new'],
  [/\bseamless(ly)?\b/gi, 'smooth'],
  [/\bunlock(ing)? the (full )?potential\b/gi, 'get more out of it'],
  [/\btake .{0,20} to the next level\b/gi, 'go further'],
  [/\bdive (deep )?into\b/gi, 'look at'],
  [/\blet.s (get )?started\b/gi, 'here is how'],
  [/\bworld-?class\b/gi, 'top'],
  [/\bblazing(ly)? (fast|quick)\b/gi, 'fast'],
  [/\bwhisper-?quiet\b/gi, 'quiet'],
  [/\bwe understand that\b/gi, ''],
  [/\bin today.s (fast-?paced )?(digital|modern) world\b/gi, ''],
  [/\blook no further\b/gi, ''],
  [/\bdreams? (come|become) (true|reality)\b/gi, 'happens'],
  [/\bempower(s|ing|ed)?\b/gi, 'help'],
  [/\bcrucial|pivotal\b/gi, 'important'],
  [/\bmost importantly,?/gi, ''],
  [/!{2,}/g, '!']
];

function applyRules(text) {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  out = out.replace(/(\S)[ \t]{2,}/g, '$1 ');
  out = out.replace(/ +([.,!?])/g, '$1');
  out = out.replace(/ \n/g, '\n');
  return out;
}

// Markdown: fenced blocks, indented blocks and inline code spans stay byte for
// byte; the rules only see the prose between them.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function rulesOutsideCode(text) {
  const out = [];
  let prose = [], fence = null, hasCode = false;
  const flush = () => {
    if (!prose.length) return;
    const parts = prose.join('\n').split(/(`+[^`\n]*`+)/);
    if (parts.length > 1) hasCode = true;
    out.push(parts.map((part, i) => i % 2 ? part : applyRules(part)).join(''));
    prose = [];
  };
  for (const line of text.split('\n')) {
    const open = FENCE.exec(line);
    if (fence) {
      out.push(line);
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.slice(open[0].length).trim()) fence = null;
    } else if (open || /^(?: {4}|\t)/.test(line)) {
      flush();
      hasCode = true;
      if (open) fence = open[1];
      out.push(line);
    } else prose.push(line);
  }
  flush();
  return { text: out.join('\n'), hasCode };
}

// Only rewrite unambiguous prose spans in well-nested, ordinary HTML. Keep
// the source itself as the template; unsupported markup is left untouched.
function copySpans(html) {
  const spans = [], stack = [];
  const prose = /^(?:p|h[1-6]|li|a|span|strong|em|b|i|button|label|figcaption|blockquote|div|body)$/;
  const tag = /<(\/?)(([a-z][\w-]*))((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/iy;
  let pos = 0;
  while (pos < html.length) {
    if (html[pos] !== '<') {
      const end = html.indexOf('<', pos);
      const text = html.slice(pos, end < 0 ? html.length : end);
      const trimmed = text.trim();
      if (prose.test(stack.at(-1)?.name) && !stack.at(-1)?.skip && /\p{L}/u.test(trimmed) && !/[&\r\n]/.test(trimmed)) {
        const start = pos + text.indexOf(trimmed);
        spans.push({ start, end: start + trimmed.length, text: trimmed });
      }
      pos += text.length;
      continue;
    }
    if (html.startsWith('<!--', pos)) {
      const end = html.indexOf('-->', pos + 4);
      if (end < 0 || html.slice(pos + 4, end).includes('--')) return [];
      pos = end + 3; continue;
    }
    const decl = /^<!doctype\s+html\s*>/i.exec(html.slice(pos));
    if (decl) { pos += decl[0].length; continue; }
    tag.lastIndex = pos;
    const m = tag.exec(html);
    if (!m) return [];
    const name = m[2].toLowerCase();
    pos = tag.lastIndex;
    if (m[1]) { if (stack.pop()?.name !== name) return []; continue; }
    if (/^(?:svg|math|plaintext|noscript|xmp|noembed|noframes|iframe|template)$/.test(name)) return [];
    if (/^(?:script|style|textarea|title)$/.test(name)) {
      const close = new RegExp('</' + name + '\\s*>', 'ig'); close.lastIndex = pos;
      if (!close.exec(html) || (name === 'script' && html.slice(pos, close.lastIndex).includes('<!--'))) return [];
      pos = close.lastIndex; continue;
    }
    if (/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name)) continue;
    if (m[5]) return [];
    stack.push({ name, skip: stack.at(-1)?.skip || /^(?:head|pre|code|kbd|samp)$/.test(name) || /\s(?:hidden|style|aria-hidden)\b/i.test(m[4]) });
  }
  return stack.length ? [] : spans;
}

function renderCopy(html, spans, lines) {
  let out = html;
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end, text } = spans[i];
    if (lines[i] === text) continue;
    const safe = lines[i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    out = out.slice(0, start) + safe + out.slice(end);
  }
  return out;
}

async function humanizeWithModel(cfg, text, kind, signal) {
  const prompt = (kind === 'html'
    ? `Below is the text content of an HTML page. Rewrite ONLY the marketing copy so it reads like a human wrote it: drop AI cliches ("game-changer", "cutting-edge", "unlock", "seamless"), filler openers, and excessive enthusiasm. Never use em dashes. Keep the message, facts, product names, numbers, and the original language exactly. Reply with ONLY the rewritten text, same line structure. If nothing needs changing, reply with the text unchanged.`
    : `Rewrite the text below so it reads like a human wrote it: drop AI cliches and filler, keep it natural and direct. Never use em dashes. Keep the message, facts, names, numbers, and language exactly. Keep the same line structure. Reply with ONLY the rewritten text. If nothing needs changing, reply with it unchanged.`)
    + `\n---\n${text}`;
  const msg = await chat({ ...cfg, reasoning: 'low' }, [{ role: 'user', content: prompt }], undefined, signal);
  const out = String(msg.content ?? '').trim();
  return out || text;
}

export async function humanizeFile(cfg, absPath, signal, hooks = {}) {
  if (!isHumanizableFile(absPath)) return { changed: false, reason: 'not a prose file' };
  const safe = () => !signal?.aborted && (!hooks.root || safeProjectPath(absPath, hooks.root));
  if (!safe()) return { changed: false, reason: 'path changed or task stopped' };
  let src;
  try { src = fs.readFileSync(absPath, 'utf8'); } catch (err) { return { changed: false, reason: err.message }; }
  if (src.length < 40) return { changed: false, reason: 'too short' };
  if (hooks.expected !== undefined && src !== hooks.expected) return { changed: false, reason: 'file changed' };
  if (src.length > 8000) return { changed: false, reason: 'document exceeds rewrite limit' };

  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase();
  const isHtml = ext === '.html' || ext === '.htm';
  const kind = isHtml ? 'html' : 'text';

  // step 1: deterministic rules
  const spans = isHtml ? copySpans(src) : [];
  if (isHtml && !spans.length) return { changed: false, reason: 'no eligible HTML copy' };
  const lines = spans.map(s => applyRules(s.text));
  const md = isHtml ? null : rulesOutsideCode(src);
  let next = isHtml ? renderCopy(src, spans, lines) : md.text;

  // step 2: model pass (skipped in plan mode or when no hooks provide a provider)
  const before = next;
  if (cfg?.apiKey && !hooks.skipModel && !md?.hasCode) {
    try {
      if (isHtml) {
        const rewritten = await humanizeWithModel(cfg, lines.join('\n'), kind, signal);
        const replacements = rewritten.split(/\r?\n/).map(line => applyRules(line.trim()));
        if (replacements.length === spans.length && replacements.every(Boolean)) next = renderCopy(src, spans, replacements);
        else hooks.onNote?.('humanizer model pass skipped: reply looked wrong');
      } else {
        const rewritten = await humanizeWithModel(cfg, next, kind, signal);
        if (rewritten.length >= Math.max(20, next.length * 0.4)) next = rewritten;
        else hooks.onNote?.('humanizer model pass skipped: reply looked wrong');
      }
      // final sanitization: the model pass may reintroduce cliches or em dashes
      if (!isHtml) next = rulesOutsideCode(next).text;
    } catch (err) {
      hooks.onNote?.(`humanizer model pass skipped: ${err.message}`);
    }
  }

  if (next !== src && next.trim()) {
    if (!safe()) return { changed: false, reason: 'path changed or task stopped' };
    // Pin the existing file. Never recreate a deleted document or write via a
    // reopened path after comparing the snapshot.
    const fd = fs.openSync(absPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (fs.readFileSync(fd, 'utf8') !== src) return { changed: false, reason: 'file changed' };
      const bytes = Buffer.from(next);
      let pos = 0;
      while (pos < bytes.length) pos += fs.writeSync(fd, bytes, pos, bytes.length - pos, pos);
      fs.ftruncateSync(fd, bytes.length);
    } finally { fs.closeSync(fd); }
    return { changed: true, before, after: next };
  }
  return { changed: false, reason: 'already clean' };
}
