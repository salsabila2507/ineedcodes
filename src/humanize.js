// humanize.js: post-processing pass for prose content. Scope is strict:
// it rewrites marketing/marketing-adjacent copy inside HTML pages and plain prose files
// (landing pages, posts, README-style text). It never touches code, attributes, URLs,
// JSON, YAML, or technical values. Meaning and facts are preserved.

import * as fs from 'node:fs';
import { chat } from './provider.js';

const PROSE_EXT = new Set(['.html', '.htm', '.md', '.markdown', '.txt']);
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
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/ +([.,!?])/g, '$1');
  out = out.replace(/ \n/g, '\n');
  return out;
}

// Extract copy blocks from HTML: between > and < (text nodes). Tag names, attributes,
// scripts, styles, and comments are left byte-identical.
function humanizeHtmlTextNodes(html, fn) {
  return html.replace(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->)/gi, m => '\x00BLOCK' + Buffer.from(m).toString('base64') + '\x00')
    .replace(/>([^<>]+)</g, (m, text) => {
      if (!/[a-zA-Z]/.test(text)) return m;
      const next = fn(text);
      return next === text ? m : '>' + next + '<';
    })
    .replace(/\x00BLOCK([A-Za-z0-9+/=]+)\x00/g, (_, b64) => Buffer.from(b64, 'base64').toString());
}

async function humanizeWithModel(cfg, text, kind, signal) {
  const prompt = (kind === 'html'
    ? `Below is the text content of an HTML page. Rewrite ONLY the marketing copy so it reads like a human wrote it: drop AI cliches ("game-changer", "cutting-edge", "unlock", "seamless"), filler openers, and excessive enthusiasm. Never use em dashes. Keep the message, facts, product names, numbers, and language (id vs en) exactly. Reply with ONLY the rewritten text, same line structure. If nothing needs changing, reply with the text unchanged.`
    : `Rewrite the text below so it reads like a human wrote it: drop AI cliches and filler, keep it natural and direct. Never use em dashes. Keep the message, facts, names, numbers, and language exactly. Keep the same line structure. Reply with ONLY the rewritten text. If nothing needs changing, reply with it unchanged.`)
    + `\n---\n${text.slice(0, 8000)}`;
  const msg = await chat({ ...cfg, reasoning: 'low' }, [{ role: 'user', content: prompt }], undefined, signal);
  const out = String(msg.content ?? '').trim();
  return out || text;
}

export async function humanizeFile(cfg, absPath, signal, hooks = {}) {
  if (!isHumanizableFile(absPath)) return { changed: false, reason: 'not a prose file' };
  let src;
  try { src = fs.readFileSync(absPath, 'utf8'); } catch (err) { return { changed: false, reason: err.message }; }
  if (src.length < 40) return { changed: false, reason: 'too short' };

  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase();
  const isHtml = ext === '.html' || ext === '.htm';
  const kind = isHtml ? 'html' : 'text';

  // step 1: deterministic rules
  let next = isHtml
    ? humanizeHtmlTextNodes(src, applyRules)
    : applyRules(src);

  // step 2: model pass (skipped in plan mode or when no hooks provide a provider)
  const before = next;
  if (cfg?.apiKey && !hooks.skipModel) {
    try {
      if (isHtml) {
        next = humanizeHtmlTextNodes(next, t => t); // normalize markers once
        const plain = next; // model sees text-node friendly form already
        const rewritten = await humanizeWithModel(cfg, stripTagsForPrompt(plain), kind, signal);
        // sanity: refuse junk replies (too short or structure-destroying)
        const okLen = rewritten.length >= Math.max(20, plain.length * 0.4);
        if (okLen) next = applyModelToTextNodes(next, rewritten);
        else hooks.onNote?.('humanizer model pass skipped: reply looked wrong');
      } else {
        const rewritten = await humanizeWithModel(cfg, next, kind, signal);
        if (rewritten.length >= Math.max(20, next.length * 0.4)) next = rewritten;
        else hooks.onNote?.('humanizer model pass skipped: reply looked wrong');
      }
      // final sanitization: the model pass may reintroduce cliches or em dashes
      next = isHtml ? humanizeHtmlTextNodes(next, applyRules) : applyRules(next);
    } catch (err) {
      hooks.onNote?.(`humanizer model pass skipped: ${err.message}`);
    }
  }

  if (next !== src && next.trim()) {
    fs.writeFileSync(absPath, next);
    return { changed: true, before, after: next };
  }
  return { changed: false, reason: 'already clean' };
}

function stripTagsForPrompt(html) {
  return html.replace(/<[^>]+>/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

// Map model-rewritten plain text back onto HTML text nodes: greedy line pairing.
// Structure is preserved; if pairing fails, the node text is left unchanged.
function applyModelToTextNodes(html, modelText) {
  const lines = modelText.split('\n').map(l => l.trim()).filter(Boolean);
  let li = 0;
  return html.replace(/>([^<>]+)</g, (m, text) => {
    const trimmed = text.trim();
    if (li < lines.length && /[a-zA-Z]/.test(trimmed) && trimmed.length > 2) {
      const candidate = lines[li++];
      if (candidate && candidate !== trimmed && candidate.length > 2) {
        return '>' + text.replace(trimmed, candidate) + '<';
      }
    }
    return m;
  });
}
