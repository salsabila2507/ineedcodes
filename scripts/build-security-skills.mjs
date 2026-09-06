#!/usr/bin/env node
// build-security-skills.mjs: converts the three security skill sources into ineed
// SKILL.md format under the DEVELOPER skills directory. Never shipped in npm.
// Sources must be cloned to /tmp/opencode/skills-src first.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const SRC = '/tmp/opencode/skills-src';
const OUT = path.join(process.env.HOME, '.ineedcodes', 'skills'); // global developer dir
const TIERS = new Set(); // name -> scope marker

let made = 0;

function writeSkill(dir, name, description, body, extra = '') {
  const d = path.join(OUT, dir);
  fs.mkdirSync(d, { recursive: true });
  const fm = [
    '---',
    `name: ${name}`,
    'description: >-',
    ...description.split('\n').map(l => '  ' + l.trim()).filter(l => l !== '  '),
    '---',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(d, 'SKILL.md'), fm + body.trim() + '\n' + extra);
  made++;
}

function descFromFrontmatter(txt, fallback) {
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return fallback;
  const dm = m[1].match(/description:\s*>-?\s*\n([\s\S]*?)(?=\n\w+:|\n---)/);
  if (dm) return dm[1].split('\n').map(l => l.trim()).join(' ').trim().slice(0, 300);
  const sm = m[1].match(/description:\s*(.+)/);
  if (sm) return sm[1].trim().slice(0, 300);
  return fallback;
}

// ── 1. hack-skills: 102 dirs each with SKILL.md, convert verbatim ──
const hackDir = path.join(SRC, 'hack-skills', 'skills');
let hackCount = 0;
for (const e of fs.readdirSync(hackDir, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const src = path.join(hackDir, e.name, 'SKILL.md');
  if (!fs.existsSync(src)) continue;
  const raw = fs.readFileSync(src, 'utf8');
  const name = e.name;
  const desc = descFromFrontmatter(raw, `Security skill: ${name} (from yaklang/hack-skills)`);
  // keep body without frontmatter, add provenance footer
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  writeSkill(name, name, desc, body, '\n> Source: yaklang/hack-skills (MIT), converted for ineed. Authorized security work only.\n');
  hackCount++;
}

// ── 2. Bug-Bounty-Agents: 43 flat .md files, one skill each ──
const bbaDir = path.join(SRC, 'Bug-Bounty-Agents');
const skipBba = new Set(['AGENTS.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'README.md', 'SECURITY.md', 'LICENSE']);
let bbaCount = 0;
for (const f of fs.readdirSync(bbaDir)) {
  if (!f.endsWith('.md') || skipBba.has(f)) continue;
  const raw = fs.readFileSync(path.join(bbaDir, f), 'utf8');
  const name = f.replace(/\.md$/, '');
  if (name.startsWith('_')) continue; // _scope-guard is meta
  const desc = descFromFrontmatter(raw, `Bug bounty agent playbook: ${name} (from matty69v/Bug-Bounty-Agents)`);
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  writeSkill('bba-' + name, 'bba-' + name, desc, body, '\n> Source: matty69v/Bug-Bounty-Agents, converted for ineed. Authorized security work only.\n');
  bbaCount++;
}

// ── 3. vulnerability-research: cheatsheets + methodology as reference skills ──
const vrDir = path.join(SRC, 'vulnerability-research');
let vrCount = 0;
const vrParts = [
  ['cheatsheets', 'vr-cheatsheet'],
  ['methodology', 'vr-methodology'],
  ['templates', 'vr-template'],
  ['write-ups', 'vr-writeup']
];
for (const [sub, prefix] of vrParts) {
  const dir = path.join(vrDir, sub);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const base = f.replace(/\.md$/, '');
    const name = `${prefix}-${base}`;
    const desc = `Vulnerability research reference: ${base} (from skraft9/vulnerability-research)`;
    writeSkill(name, name, desc, raw, '\n> Source: skraft9/vulnerability-research, converted for ineed. Authorized security work only.\n');
    vrCount++;
  }
}

console.log(`Converted: hack-skills=${hackCount}, bba=${bbaCount}, vuln-research=${vrCount}, total=${made}`);
console.log(`Output: ${OUT} (developer machine only, never in npm)`);
