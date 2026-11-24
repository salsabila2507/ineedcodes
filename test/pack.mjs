// pack.mjs: pack the package, install it in a sandbox, prove the binary works.
// This is the test v0.2.0 failed (ERR_MODULE_NOT_FOUND from missing files).

import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ineed-pack-'));

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' | ' + String(detail).slice(0, 300) : '')); }
};

// 1. npm pack
execSync('npm pack --pack-destination ' + JSON.stringify(TMP), { cwd: ROOT, stdio: 'pipe' });
const tarball = fs.readdirSync(TMP).find(f => f.endsWith('.tgz'));
check('npm pack produces tarball', Boolean(tarball));

// 2. tarball contents: clean core only, no bundled skills (registry policy:
//    skills are an opt-in download via `ineed skills-sync`)
const listing = execSync('tar -tzf ' + path.join(TMP, tarball), { encoding: 'utf8' });
// Windows bsdtar writes CRLF lines: split on both, or every path ends with \r
const files = listing.trim().split(/\r?\n/).map(f => f.replace(/^package\//, '')).filter(f => f && !f.endsWith('/'));
const expected = ['LICENSE', 'README.md', 'package.json',
  ...fs.readdirSync(path.join(ROOT, 'src')).map(f => 'src/' + f)
];
const missing = expected.filter(f => !files.includes(f));
check('tarball has all runtime files', missing.length === 0, 'missing: ' + missing.join(', '));
check('tarball ships no bundled skills (opt-in via skills-sync)', !files.some(f => f.startsWith('skills/') || f.startsWith('optional/')),
  'found: ' + files.filter(f => f.startsWith('skills/') || f.startsWith('optional/')).slice(0, 3).join(', '));
const extra = files.filter(f => !expected.includes(f) && !f.startsWith('skills/') && !f.startsWith('optional/'));
check('tarball has no junk', extra.length === 0, 'extra: ' + extra.join(', '));

// 3. install into sandbox prefix
const prefix = path.join(TMP, 'prefix');
execSync(`npm install --prefix ${JSON.stringify(prefix)} --no-audit --no-fund --silent ${JSON.stringify(path.join(TMP, tarball))}`, { stdio: 'pipe' });

// 4. run the installed binary. npm ships three shims; POSIX execs the shebang
// script directly, Windows needs the .cmd one (spawnSync of an extensionless
// sh file fails there, and exec bits are a POSIX concept).
const win = process.platform === 'win32';
const bin = path.join(prefix, 'node_modules', '.bin', win ? 'ineed.cmd' : 'ineed');
check('installed bin exists and is executable', fs.existsSync(bin) && (win || !!(fs.statSync(bin).mode & 0o111)));
const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000, shell: win });
check('installed bin --version works', v.status === 0 && v.stdout.includes('ineed ' + VERSION), v.stdout + v.stderr);
const h = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 30_000, shell: win });
check('installed bin --help works', h.status === 0 && h.stdout.includes('--reset') && h.stdout.includes('ineed "'), h.stdout + h.stderr);

// 5. no ERR_MODULE_NOT_FOUND on any import path (the v0.2.0 killer)
const installedSrc = path.join(prefix, 'node_modules', 'ineedcodes', 'src');
const modules = fs.readdirSync(installedSrc).filter(f => f.endsWith('.js') && f !== 'cli.js').concat('cli.js');
const urls = modules.map(f => pathToFileURL(path.join(installedSrc, f)).href);
const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
  process.argv[2] = '--version';
  for (const url of ${JSON.stringify(urls)}) await import(url);
`], { cwd: TMP, encoding: 'utf8', timeout: 30_000, input: '' });
check('installed runtime modules import cleanly', probe.status === 0 && probe.stdout?.includes('ineed ' + VERSION), probe.error || probe.stderr);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
