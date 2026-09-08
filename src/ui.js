// ui.js: terminal helpers. No dependencies, respects NO_COLOR and non-TTY.

export const VERSION = '1.7.14';

const USE_COLOR = process.stdout.isTTY && !(process.env.NO_COLOR && process.env.NO_COLOR !== '0');
const wrap = (code, t) => USE_COLOR ? `\x1b[${code}m${t}\x1b[0m` : String(t);

// ── semantic theme tokens ──
// Every TUI color goes through these. Components never hardcode a palette color;
// they pick a token (accent, muted, error...) and the active theme maps it to
// an SGR parameter. Values are raw SGR params so backgrounds can carry 256-color
// codes ("48;5;236"). NO_COLOR and non-TTY degrade everything to plain text.
const THEMES = {
  dark: {
    background: '49',  panel: '48;5;236',  userBg: '48;5;238',
    text: '39',        muted: '90',        accent: '36',
    success: '32',     warning: '33',      error: '31',
    divider: '90',     focus: '36',        command: '97',
    tool: '96',        model: '94',        path: '36'
  },
  light: {
    background: '49',  panel: '48;5;254',  userBg: '48;5;252',
    text: '39',        muted: '90',        accent: '34',
    success: '32',     warning: '33',      error: '31',
    divider: '90',     focus: '34',        command: '30',
    tool: '34',        model: '32',        path: '34'
  },
  mono: {
    background: '49',  panel: '49',        userBg: '49',
    text: '39',        muted: '2',         accent: '1',
    success: '1',      warning: '2',       error: '7',
    divider: '2',      focus: '1',         command: '1',
    tool: '2',         model: '2',         path: '2'
  },
  nord: {
    background: '49',  panel: '48;5;235',  userBg: '48;5;237',
    text: '97',        muted: '38;5;245',  accent: '38;5;111',
    success: '38;5;113', warning: '38;5;179', error: '38;5;174',
    divider: '38;5;240', focus: '38;5;111', command: '97',
    tool: '38;5;111',  model: '38;5;129',  path: '38;5;109'
  },
  dracula: {
    background: '49',  panel: '48;5;236',  userBg: '48;5;60',
    text: '97',        muted: '38;5;245',  accent: '38;5;141',
    success: '38;5;120', warning: '38;5;215', error: '38;5;210',
    divider: '38;5;238', focus: '38;5;141', command: '38;5;117',
    tool: '38;5;141',  model: '38;5;117',  path: '38;5;151'
  },
  synthwave: {
    background: '49',  panel: '48;5;54',   userBg: '48;5;53',
    text: '97',        muted: '38;5;146',  accent: '38;5;213',
    success: '38;5;49', warning: '38;5;201', error: '38;5;203',
    divider: '38;5;98', focus: '38;5;213', command: '38;5;51',
    tool: '38;5;213',  model: '38;5;51',   path: '38;5;189'
  }
};

let themeName = 'dark';
let palette = THEMES.dark;

export function setTheme(name) {
  if (THEMES[name]) { themeName = name; palette = THEMES[name]; }
  return themeName;
}
export const getTheme = () => themeName;
export const themeNames = () => Object.keys(THEMES);

// token -> wrapper. Self-contained: sets the attribute, then resets it.
export const tBackground = t => wrap(palette.background, t);
export const tPanel = t => wrap(palette.panel, t);
export const tText = t => wrap(palette.text, t);
export const tMuted = t => wrap(palette.muted, t);
export const tAccent = t => wrap(palette.accent, t);
export const tSuccess = t => wrap(palette.success, t);
export const tWarning = t => wrap(palette.warning, t);
export const tError = t => wrap(palette.error, t);
export const tDivider = t => wrap(palette.divider, t);
export const tFocus = t => wrap(palette.focus, t);
export const tCommand = t => wrap(palette.command, t);
export const tTool = t => wrap(palette.tool, t);
export const tModel = t => wrap(palette.model, t);
export const tPath = t => wrap(palette.path, t);

// live token functions: always paint with the currently active theme, so a
// /theme switch recolors everything painted afterwards without a restart.
export const T = {
  background: tBackground, panel: tPanel, text: tText, muted: tMuted,
  accent: tAccent, success: tSuccess, warning: tWarning, error: tError,
  divider: tDivider, focus: tFocus, command: tCommand, tool: tTool,
  model: tModel, path: tPath
};

// primitives for mixed-attribute rows (panel/rail/box painting): turn one
// attribute on without resetting the others, so a background can survive
// inline foreground changes. resetOff() closes the row.
export const bgOn = token => USE_COLOR ? `\x1b[${palette[token]}m` : '';
export const fgOn = token => USE_COLOR ? `\x1b[${palette[token]}m` : '';
export const fgOff = () => USE_COLOR ? `\x1b[39m` : '';
export const resetOff = () => USE_COLOR ? `\x1b[0m` : '';

export const bold = t => wrap('1', t);
export const dim = t => wrap('2', t);
export const red = t => wrap('31', t);
export const green = t => wrap('32', t);
export const yellow = t => wrap('33', t);
export const cyan = t => wrap('36', t);
export const gray = t => wrap('90', t);

export const trunc = (s, n = 120) => {
  const o = String(s).replaceAll('\n', ' ');
  return o.length > n ? o.slice(0, n - 3) + '...' : o;
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

// Square flat box around lines. Width follows the longest line, capped to the
// terminal. Used by command views; crisp corners, no web-style rounding.
export function box(lines, colorFn = t => t) {
  const cols = process.stdout.columns || 80;
  const inner = Math.min(cols - 4, Math.max(10, ...lines.map(l => plain(l).length)) + 2);
  const top = colorFn('┌' + '─'.repeat(inner) + '┐');
  const bot = colorFn('└' + '─'.repeat(inner) + '┘');
  const mid = lines.map(l => colorFn('│') + ' ' + l + ' '.repeat(Math.max(0, inner - plain(l).length - 1)) + colorFn('│'));
  return [top, ...mid, bot].join('\n');
}

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Spinner for TTYs only. In pipes and tests it becomes a no-op.
export function startSpinner(text = 'thinking') {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return { stop: () => {} };
  let i = 0;
  let stopped = false;
  const line = () => `\r${tAccent(SPIN_FRAMES[i++ % SPIN_FRAMES.length])} ${tMuted(text + '...')}  `;
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

export const RULE = () => tDivider('─'.repeat(Math.min(process.stdout.columns || 80, 64)));

// user message: one wide horizontal band. Subtle full-width background, a small
// `>` marker on the left, no rounded bubble, no thick border, no nested card.
// Fills most of the terminal width. Each painted row is exactly cols-4 visible
// columns, matching the chat wrap width, so wrapLines never splits the band.
export function userBlock(text) {
  const cols = process.stdout.columns || 80;
  const width = Math.max(20, cols - 4);          // same budget as tuiPrint wrapping
  const inner = width - 5;                       // '  > ' head + trailing pad column
  const band = s => USE_COLOR ? bgOn('userBg') + s + resetOff() : s;
  const marker = USE_COLOR ? fgOn('accent') + '>' + fgOff() + ' ' : '> ';
  const lines = [];
  let first = true;
  for (const raw of String(text).split('\n')) {
    let line = raw;
    do {
      const cut = line.slice(0, inner);
      const head = first ? '  ' + marker : '    ';
      lines.push(band(head + cut + ' '.repeat(Math.max(0, inner - cut.length)) + ' '));
      first = false;
      line = line.slice(inner);
    } while (line.length > 0);
  }
  return lines.join('\n');
}

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
export function makeInput(rl, onLine, onPending = null) {
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
    let wasPending = false;
    const deliver = v => {
      if (prevEcho) rl._writeToOutput = prevEcho;
      else if (secret) delete rl._writeToOutput;
      if (secret) process.stdout.write('\n');
      if (wasPending) { wasPending = false; onPending?.(false); }
      res(v);
    };
    if (queue.length > 0) deliver(queue.shift());
    else if (closed) deliver('');
    else { pending = deliver; wasPending = true; onPending?.(true); }
  });

  // push a line as if typed: lands on a pending question, or waits in the queue
  ask.feed = l => {
    if (pending) { const r = pending; pending = null; r(l); return; }
    queue.push(l);
  };
  return ask;
}
