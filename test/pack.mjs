// pack.mjs: pack the package, install it in a sandbox, prove the binary works.
// This is the test v0.2.0 failed (ERR_MODULE_NOT_FOUND from missing files).

import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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

// 2. tarball contents: exactly what ships
const listing = execSync('tar -tzf ' + path.join(TMP, tarball), { encoding: 'utf8' });
const files = listing.trim().split('\n').map(f => f.replace(/^package\//, '')).filter(f => f && !f.endsWith('/'));
const expected = ['LICENSE', 'README.md', 'package.json', ...fs.readdirSync(path.join(ROOT, 'src')).map(f => 'src/' + f)];
const missing = expected.filter(f => !files.includes(f));
const extra = files.filter(f => !expected.includes(f));
check('tarball has all runtime files', missing.length === 0, 'missing: ' + missing.join(', '));
check('tarball has no junk', extra.length === 0, 'extra: ' + extra.join(', '));

// 3. install into sandbox prefix
const prefix = path.join(TMP, 'prefix');
execSync(`npm install --prefix ${JSON.stringify(prefix)} --no-audit --no-fund --silent ${JSON.stringify(path.join(TMP, tarball))}`, { stdio: 'pipe' });

// 4. run the installed binary
const bin = path.join(prefix, 'node_modules', '.bin', 'ineed');
check('installed bin exists and is executable', fs.existsSync(bin) && !!(fs.statSync(bin).mode & 0o111));
const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
check('installed bin --version works', v.status === 0 && v.stdout.includes('ineed 1.1.0'), v.stdout + v.stderr);
const h = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 30_000 });
check('installed bin --help works', h.status === 0 && h.stdout.includes('one-shot task'), h.stdout + h.stderr);

// 5. no ERR_MODULE_NOT_FOUND on any import path (the v0.2.0 killer)
const probe = spawnSync(process.execPath, ['-e', `
  import(${JSON.stringify(path.join(prefix, 'node_modules', 'ineedcodes', 'src', 'cli.js'))}).catch(e => { console.error(e.code || e.message); process.exit(1); });
`], { encoding: 'utf8', timeout: 30_000, input: '' });
check('cli.js imports cleanly from installed package', !String(probe.stderr).includes('ERR_MODULE_NOT_FOUND'), probe.stderr);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
