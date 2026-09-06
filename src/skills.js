// skills.js: portable SKILL.md system (master prompt #16-18).
// Resolution priority: project (.ineedcodes/skills) > global (~/.ineedcodes/skills) > builtin.
// Frontmatter: name, description, tools (optional restriction), instructions body below.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR } from './config.js';

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
  return { name: meta.name, description: meta.description ?? '', tools: meta.tools ? meta.tools.split(',').map(s => s.trim()).filter(Boolean) : null, instructions: m[2].trim() };
}

function loadDir(dir, scope, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    try {
      const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      if (parsed) out.push({ ...parsed, scope });
    } catch {}
  }
}

export function listSkills(cwd) {
  const out = [];
  loadDir(path.join(cwd ?? process.cwd(), '.ineedcodes', 'skills'), 'project', out);
  loadDir(path.join(CONFIG_DIR, 'skills'), 'global', out);
  for (const b of BUILTIN) if (!out.some(s => s.name === b.name)) out.push(b);
  // project > global > builtin: later entries lose to earlier ones with the same name
  return out;
}

export function findSkill(name, cwd) {
  return listSkills(cwd).find(s => s.name === name) ?? null;
}
