// skills.js: portable SKILL.md system (master prompt #16-18).
// Resolution priority: project (.ineedcodes/skills) > global (~/.ineedcodes/skills) > builtin.
// Frontmatter: name, description, tools (optional restriction), instructions body below.
//
// GATED SKILLS: SKILL.md files whose frontmatter carries "gated: true" stay invisible
// unless the objective text contains the developer keyword. The keyword itself lives
// OUTSIDE this repository: in the INEED_DEV_KEYWORD environment variable or in
// ~/.ineedcodes/keyword (chmod 600). A fresh install cannot unlock gated skills.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { fileURLToPath } from 'node:url';
import * as url from 'node:url';
const PKG_SKILLS = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'skills');

const KEYWORD_FILE = path.join(CONFIG_DIR, 'keyword');

export function devKeyword() {
  if (process.env.INEED_DEV_KEYWORD) return String(process.env.INEED_DEV_KEYWORD).trim();
  try { return fs.readFileSync(KEYWORD_FILE, 'utf8').trim(); } catch { return ''; }
}

const BUILTIN = [
  {
    name: 'humanizer',
    description: 'Rewrite prose so it reads like a human wrote it. For pages, posts, docs. Never for code or technical values.',
    scope: 'builtin',
    instructions: `When asked to humanize text or files: strip AI cliches (game-changer, cutting-edge, unlock, seamless, revolutionary), filler openers, and em dashes. Vary sentence length. Keep facts, names, numbers, structure, and language. Never alter code, tags, attributes, URLs, or technical values.`
  }
];

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!meta.name) return null;
  return {
    name: meta.name,
    description: meta.description ?? '',
    tools: meta.tools ? meta.tools.split(',').map(s => s.trim()).filter(Boolean) : null,
    gated: meta.gated === 'true' || meta.gated === 'yes',
    instructions: m[2].trim()
  };
}

function loadDir(dir, scope, out, forceGated = false) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    try {
      const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      if (parsed && !out.some(x => x.name === parsed.name)) out.push({ ...parsed, scope, gated: parsed.gated || forceGated });
    } catch {}
  }
}

function isUnlocked(objective) {
  const kw = devKeyword();
  if (!kw || !objective) return false;
  return String(objective).includes(kw);
}

export function listSkills(cwd, objective = '') {
  const out = [];
  loadDir(path.join(cwd ?? process.cwd(), '.ineedcodes', 'skills'), 'project', out);
  loadDir(path.join(CONFIG_DIR, 'skills'), 'global', out);
  loadDir(PKG_SKILLS, 'gated', out, true);
  for (const b of BUILTIN) if (!out.some(s => s.name === b.name)) out.push(b);
  // project > global > builtin: later entries lose to earlier ones with the same name
  if (!isUnlocked(objective)) return out.filter(s => !s.gated);
  return out;
}

export function findSkill(name, cwd, objective = '') {
  const s = listSkills(cwd, objective).find(s => s.name === name) ?? null;
  if (s?.gated && !isUnlocked(objective)) return null;
  return s;
}
