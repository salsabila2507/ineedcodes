// ui.js: terminal helpers. No dependencies, respects NO_COLOR and non-TTY.

export const VERSION = '1.7.3';

const USE_COLOR = process.stdout.isTTY && !(process.env.NO_COLOR && process.env.NO_COLOR !== '0');
const wrap = (code, t) => USE_COLOR ? `\x1b[${code}m${t}\x1b[0m` : String(t);

export const bold = t => wrap('1', t);
export const dim = t => wrap('2', t);
export const red = t => wrap('31', t);
export const green = t => wrap('32', t);
export const yellow = t => wrap('33', t);
export const cyan = t => wrap('36', t);
export const gray = t => wrap('90', t);

export const trunc = (s, n = 120) => {
  const o = String(s).replaceAll('\n', ' ');
  return o.length > n ? o.slice(0, n - 1) + '...' : o;
};

// Terminal-safe markdown: **bold** becomes ANSI bold (or disappears without color),
// headers lose their hashes. Files keep their markdown; only the screen is cleaned.
export const mdTerm = t => {
  let s = String(t);
  if (USE_COLOR) s = s.replace(/\*\*([^*\n]+)\*\*/g, `\x1b[1m$1\x1b[0m`);
  else s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/(^|\n)#{1,6} /g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  return s;
};

const plain = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// Rounded box around lines. Width follows the longest line, capped to the terminal.
export function box(lines, colorFn = t => t) {
  const cols = process.stdout.columns || 80;
  const inner = Math.min(cols - 4, Math.max(10, ...lines.map(l => plain(l).length)) + 2);
  const top = colorFn('╭' + '─'.repeat(inner) + '╮');
  const bot = colorFn('╰' + '─'.repeat(inner) + '╯');
  const mid = lines.map(l => colorFn('│') + ' ' + l + ' '.repeat(Math.max(0, inner - plain(l).length - 1)) + colorFn('│'));
  return [top, ...mid, bot].join('\n');
}

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Spinner for TTYs only. In pipes and tests it becomes a no-op.
export function startSpinner(text = 'thinking') {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return { stop: () => {} };
  let i = 0;
  let stopped = false;
  const line = () => `\r${cyan(SPIN_FRAMES[i++ % SPIN_FRAMES.length])} ${dim(text + '...')}  `;
  process.stdout.write(line());
  const iv = setInterval(() => process.stdout.write(line()), 90);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(iv);
      process.stdout.write('\r' + ' '.repeat(plain(text).length + 20) + '\r');
    }
  };
}

export const RULE = () => dim('─'.repeat(Math.min(process.stdout.columns || 80, 64)));

// user bubble: quoted, colored, compact
export const userBubble = text => {
  const w = Math.min(process.stdout.columns || 80, 60);
  const wrapped = [];
  for (const raw of String(text).split('\n')) {
    let line = raw;
    while (line.length > w - 4) {
      wrapped.push('  ' + yellow('│ ') + line.slice(0, w - 4));
      line = line.slice(w - 4);
    }
    wrapped.push('  ' + yellow('│ ') + line);
  }
  return wrapped.join('\n') + '\n  ' + yellow('╰' + '─'.repeat(w - 4) + '╯');
};

// ── raw screen plumbing for the full-screen chat layout ──
export const screen = {
  enter() { process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J'); },
  exit() { process.stdout.write('\x1b[r\x1b[?25h\x1b[?1006l\x1b[?1000l\x1b[?1049l'); },
  mouse(on) { process.stdout.write(on ? '\x1b[?1006h\x1b[?1000h' : '\x1b[?1006l\x1b[?1000l'); },
  region(top, bot) { process.stdout.write(`\x1b[${top};${bot}r`); },
  resetRegion() { process.stdout.write('\x1b[r'); },
  at(row, col = 1) { process.stdout.write(`\x1b[${row};${col}H`); },
  clearLine() { process.stdout.write('\x1b[2K'); }
};

export const BANNER = () =>
  bold(green('ineed')) + dim(` v${VERSION}`) + dim(' · your terminal, now autonomous');

// Big startup logo, ANSI-shadow style. Six fixed-width lines.
const LOGO_LINES = [
  '██╗ ███╗   ██╗  ███████╗  ███████╗  ██████╗ ',
  '██║ ████╗  ██║  ██╔════╝  ██╔════╝  ██╔══██╗',
  '██║ ██╔██╗ ██║  █████╗    █████╗    ██║  ██║',
  '██║ ██║╚██╗██║  ██╔══╝    ██╔══╝    ██║  ██║',
  '██║ ██║ ╚████║  ███████╗  ███████╗  ██████╔╝',
  '╚═╝ ╚═╝  ╚═══╝  ╚══════╝  ╚══════╝  ╚═════╝ '
];
export const LOGO = LOGO_LINES.join('\n');
export const logo = () => LOGO_LINES.map(l => green(bold(l))).join('\n');

// Ask a question and await one line. `secret` hides typed characters.
// onLine: receiver for lines typed when no question is pending (REPL dispatch).
export function makeInput(rl, onLine) {
  let pending = null;
  let closed = false;
  const queue = [];

  rl.on('line', line => {
    const l = line.trim();
    if (pending) { const r = pending; pending = null; r(l); return; }
    if (onLine) { onLine(l); return; }
    queue.push(l);
  });
  rl.on('close', () => {
    closed = true;
    if (pending) { const r = pending; pending = null; r(''); }
  });

  const ask = (q, { secret = false } = {}) => new Promise(res => {
    process.stdout.write(q + ' ');
    let prevEcho = null;
    if (secret && process.stdout.isTTY) {
      prevEcho = rl._writeToOutput;
      rl._writeToOutput = () => {}; // hide keystrokes while the user types
    }
    const deliver = v => {
      if (prevEcho) rl._writeToOutput = prevEcho;
      else if (secret) delete rl._writeToOutput;
      if (secret) process.stdout.write('\n');
      res(v);
    };
    if (queue.length > 0) deliver(queue.shift());
    else if (closed) deliver('');
    else pending = deliver;
  });

  // push a line as if typed: lands on a pending question, or waits in the queue
  ask.feed = l => {
    if (pending) { const r = pending; pending = null; r(l); return; }
    queue.push(l);
  };
  return ask;
}
