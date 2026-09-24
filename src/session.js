// session.js: interactive chat TUI. Flat terminal-native layout: scrolling
// conversation, inline tool/agent activity, live working line, borderless
// composer, and a compact bottom bar (model / reasoning / working directory).
// Falls back to a plain REPL (same commands) when stdout is not a TTY, so tests and pipes keep working.

import * as readline from 'node:readline';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { clearConfig, normalize, saveConfig, addProvider, removeProvider, providerNames } from './config.js';
import { switchProviderLive } from './switch.js';
import { runObjective, pushTurn, MAX_STEPS } from './agent.js';
import { fetchModels } from './provider.js';
import { makeInput, bold, dim, red, green, yellow, cyan, gray, trunc, BANNER, logo, startSpinner, VERSION, userBlock, T, setTheme, getTheme, themeNames, bgOn, fgOn, fgOff, resetOff, screen, visLen, cpWidth } from './ui.js';
import { wizard } from './wizard.js';
import { getMemoryProvider, ICMAdapter } from './memory.js';
import { saveSession, listSessions, loadSession } from './sessions.js';
import * as boost from './boost.js';
import { spawnSync } from 'node:child_process';
import { mcpConfigured } from './mcp.js';
import { listSkills, findSkill, devKeyword, DEFAULT_KEYWORD } from './skills.js';
import { runInit } from './init.js';

function currentBranch(cwd) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const plain = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

const ESC_RE = /^\x1b\[[0-9;?]*[a-zA-Z]/;

// ANSI-aware truncation for painted single lines: escapes carry zero width,
// '...' is part of the n budget, and any open color is closed before the cut
const ansiTrunc = (s, n) => {
  if (visLen(s) <= n) return s;
  const budget = Math.max(0, n - 3);
  let vis = 0, i = 0, out = '';
  while (i < s.length) {
    if (s[i] === '\x1b') {
      // copy whole escape sequences verbatim so the cut never splits one
      const m = ESC_RE.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
      i++;
      continue;
    }
    const c = s.codePointAt(i);
    const cw = cpWidth(c);
    if (vis + cw > budget) {
      if (out.includes('\x1b[')) out += '\x1b[0m';   // keep colors from leaking
      return out + '...';
    }
    out += String.fromCodePoint(c);
    vis += cw;
    i += c > 0xffff ? 2 : 1;
  }
  return out;
};

// like ansiTrunc but pads the visible part up to exactly n columns
const ansiPad = (s, n) => {
  let vis = 0, i = 0, out = '';
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = ESC_RE.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
      i++;
      continue;
    }
    out += s[i];
    vis++;
    i++;
  }
  return out + ' '.repeat(Math.max(0, n - vis));
};

// /home/user/ineedcodes -> ~/ineedcodes (only when actually inside the home dir)
function shortPath(p) {
  const home = os.homedir();
  const s = String(p ?? '');
  if (s === home) return '~';
  if (s.startsWith(home + path.sep)) return '~' + s.slice(home.length);
  return s;
}

// truncate in the middle: long paths and model names must not destroy the layout
function truncMid(s, n) {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  if (n <= 3) return t.slice(0, n);
  const half = Math.floor((n - 3) / 2);
  return t.slice(0, half) + '...' + t.slice(t.length - (n - 3 - half));
}

// 'openai/glm-5.3-flash' -> 'glm-5.3-flash' tail for the bottom bar
function modelTail(model) {
  const s = String(model ?? '');
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
}

// Human phrase for a tool call. Returns [verb, argument, isCommand].
function toolLabel(name, input = {}) {
  const p = v => String(v ?? '');
  switch (name) {
    case 'read_file': return ['Reading', p(input.path)];
    case 'read_file_range': return ['Reading', p(input.path)];
    case 'list_files': return ['Listing', p(input.path) || '.'];
    case 'search_text': return ['Searching', `"${trunc(p(input.pattern), 40)}"`];
    case 'write_file': return ['Writing', p(input.path)];
    case 'edit_file': return ['Editing', p(input.path)];
    case 'delete_file': return ['Deleting', p(input.path)];
    case 'copy_file': return ['Copying', `${p(input.path)} -> ${p(input.to)}`];
    case 'move_file': return ['Moving', `${p(input.path)} -> ${p(input.to)}`];
    case 'shell': return ['Running', trunc(p(input.command), 70), true];
    case 'fetch_url': return ['Fetching', trunc(p(input.url), 60)];
    case 'web_search': return ['Searching web', `"${trunc(p(input.query), 40)}"`];
    case 'todo': return ['Updating', 'checklist'];
    case 'git_status': return ['Checking', 'git status'];
    case 'git_diff': return ['Checking', 'git diff'];
    case 'git_log': return ['Checking', 'git log'];
    case 'git_branch': return ['Listing', 'branches'];
    case 'git_add': return ['Staging', p(input.paths) || '.'];
    case 'git_commit': return ['Committing', trunc(p(input.message), 50)];
    case 'git_restore': return ['Restoring', p(input.path) || '.'];
    case 'process_start': return ['Starting', `${p(input.name)}: ${trunc(p(input.command), 50)}`, true];
    case 'process_output': return ['Reading log', p(input.name)];
    case 'process_stop': return ['Stopping', p(input.name)];
    case 'process_status': return ['Checking', 'background processes'];
    default: return [name, trunc(p(input.command ?? input.path ?? input.url ?? input.query ?? input.objective ?? ''), 50)];
  }
}

// inline tool activity: `• Reading src/auth.ts`
function fmtToolLine(name, input) {
  const [verb, arg, isCmd] = toolLabel(name, input);
  const head = '  ' + T.tool(`• ${verb}${arg ? ' ' : ''}`);
  if (!arg) return head;
  return head + (isCmd ? T.command(arg) : T.path(arg));
}

// real result right below the call that produced it: `✓ exit 0` plus indented
// stdout/stderr for commands, or a one-line summary for every other tool.
export function fmtResultLine(toolName, out) {
  const s = String(out ?? '').replace(/\s+$/, '');
  const cols = process.stdout.columns || 80;
  const w = Math.max(20, cols - 8);
  const bad = /^(Error|Refused|Denied)/i.test(s.trim());
  // a command that failed is a failure, whatever the text says: nonzero exit,
  // a timeout, a killed process, or no exit code at all
  const firstLine = s.split('\n')[0] ?? '';
  const exitCode = /^exit code:\s*(.+)$/.exec(firstLine)?.[1]?.trim() ?? '';
  const exitBad = Boolean(exitCode) && exitCode !== '0';
  const mark = bad || exitBad ? T.error('✗') : T.success('✓');
  if (toolName === 'shell' || toolName === 'process_output') {
    const rows = s.split('\n');
    const head = rows.shift() ?? '';
    const code = /^exit code:\s*(.+)$/.exec(head);
    const headLine = code
      ? mark + T.muted(` exit ${code[1]}`)
      : mark + (head ? ' ' + T.muted(trunc(head, w)) : '');
    const rest = rows.map(l => l.trim()).filter(Boolean);
    const shown = rest.slice(0, 8).map(l => '    ' + T.muted(trunc(l, w)));
    if (rest.length > 8) shown.push(T.muted('    ... +' + (rest.length - 8) + ' more lines'));
    return ['  ' + headLine, ...shown].join('\n');
  }
  const first = s.split('\n')[0] ?? '';
  if (!first) return '  ' + mark;
  return '  ' + mark + ' ' + T.muted(trunc(first, Math.max(20, cols - 6)));
}

// 'openai/glm-5.3-flash' -> 'GLM 5.3 Flash' (compact label for the composer corner)
function prettyModel(model) {
  const tail = String(model || '').split('/').pop();
  return tail
    .split(/[-_]/)
    .filter(Boolean)
    .map(w => (/^[a-z]{1,3}$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// Context compaction (master prompt #32): when the saved conversation grows past the
// cap, summarize the oldest half into a factual checkpoint and drop the raw turns.
const COMPACT_CHARS = 24_000;
async function compactHistory(cfg, history, hooks = {}) {
  const size = history.reduce((n, m) => n + (m.content?.length ?? 0) + 24, 0);
  if ((!hooks.force && size < COMPACT_CHARS) || history.length < 6) return history;
  const cut = Math.floor(history.length / 2);
  const old = history.slice(0, cut);
  const rest = history.slice(cut);
  const digest = old.map(m => `${m.role}: ${String(m.content ?? '').replaceAll('\n', ' ').slice(0, 160)}`).join('\n');
  try {
    const { chat } = await import('./provider.js');
    const msg = await chat({ ...cfg, reasoning: 'low' }, [
      { role: 'user', content: `Summarize this conversation into a factual checkpoint: goals, decisions, files touched, unresolved work. Max 12 lines. No prose flourish.\n---\n${digest.slice(0, 10_000)}` }
    ]);
    const summary = String(msg.content ?? '').trim();
    if (summary.length > 20) {
      hooks.onNote?.(`compacted ${cut} turns into a checkpoint (${(size / 1000).toFixed(0)}k -> ${((summary.length + rest.reduce((n, m) => n + (m.content?.length ?? 0) + 24, 0)) / 1000).toFixed(0)}k chars)`);
      return [{ role: 'user', content: '[conversation checkpoint] ' + summary }, { role: 'assistant', content: 'Checkpoint noted. Continuing from there.' }, ...rest];
    }
  } catch {}
  return history.slice(-10); // provider unavailable: keep the newest turns
}

function wrapLines(text, width) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    let line = raw;
    if (line === '') { out.push(''); continue; }
    while (visLen(line) > width) {
      let vis = 0, i = 0;
      while (i < line.length && vis < width) {
        if (line[i] === '\x1b') {
          // whole sequences (CSI and friends) carry zero width; anything else
          // is copied through and never counted
          const m = ESC_RE.exec(line.slice(i));
          if (m) i += m[0].length;
          else i++;
          continue;
        }
        const c = line.codePointAt(i);
        const cw = cpWidth(c);
        if (vis + cw > width) break;   // wide char does not fit: wrap first
        vis += cw;
        i += c > 0xffff ? 2 : 1;
      }
      // trailing escapes belong to the visible cut (colors stay balanced)
      let end = i;
      let m;
      while ((m = ESC_RE.exec(line.slice(end))) && m.index === 0) end += m[0].length;
      out.push(line.slice(0, end));
      line = line.slice(i);
    }
    out.push(line);
  }
  return out;
}

// plain-text wrap for the composer (typed input carries no ANSI)
function wrapPlain(t, width) {
  const out = [];
  for (const raw of String(t).split('\n')) {
    if (raw === '') { out.push(''); continue; }
    for (let i = 0; i < raw.length; i += width) out.push(raw.slice(i, i + width));
  }
  return out;
}

export async function startSession(cfg, { fresh = false, resume = null } = {}) {
  const state = normalize(cfg);
  setTheme(state.theme);   // theme tokens color the whole TUI from the first paint
  let history = resume?.length ? [...resume] : [];
  let busy = false;
  let activeRun = null;
  let mode = state.mode;
  let lastSigint = 0;
  let closed = false;
  const approved = new Set(); // session-wide "always allow" grants
  const pendingLines = [];
  const steerQueue = [];      // notes typed while a task runs, injected mid-task

  // Full-screen TUI: great in ANSI terminals (Linux/macOS/Windows Terminal), but
  // legacy Windows consoles garble alt-screen sequences. On win32 the TUI turns on
  // when any ANSI-capable host is detected: Windows Terminal (WT_SESSION /
  // WT_PROFILE_ID), ConEmu, mintty/Git Bash (TERM_PROGRAM=mintty), VS Code, or a
  // modern ConPTY host. Modern PowerShell / pwsh reports PowerShell* in TERM and
  // its conhost does translate VT sequences (VirtualTerminalLevel), so it counts
  // too. Force with config "tui": true, disable with "tui": false.
  const noColor = process.env.NO_COLOR && process.env.NO_COLOR !== '0';
  const term = String(process.env.TERM ?? '');
  const windowsAnsi = !!(process.env.WT_SESSION || process.env.WT_PROFILE_ID
    || process.env.ConEmuANSI === 'ON'
    || process.env.TERM_PROGRAM          // vscode, mintty, wezterm, ...
    || /^xterm|powerShell|pwsh/i.test(term)
    || process.env.ANSICON);
  const TUI = process.stdout.isTTY && process.stdin.isTTY && !noColor
    && (state.tui === true || (state.tui === null && (process.platform !== 'win32' || windowsAnsi)));
  let sessionId = null;
  let lastBoost = null;
  let usage = { input: 0, output: 0 };
  // cost visibility: people cannot budget what they cannot see. Tokens are
  // counted per task and for the whole session (price depends on the provider)
  let sessionTokens = 0;
  let taskTokens = 0;
  const kfmt = n => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  var tuiReady = false;
  let spinnerFrame = null;   // current frame of the live working-line spinner
  let spinnerText = null;    // label shown on the live working line
  let workTick = null;       // working-line interval
  let working = false;       // live "Working" status line visible?
  let runStartedAt = 0;
  let lastToolName = null;   // most recent tool call, so its result renders below it

  // ONE readline, ONE dispatcher. Mouse wheel sequences are decoded in the
  // keypress handler below (they arrive as keypress with key.sequence).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let handleRef = null;
  // Piped input arrives in one burst, so a slow command could still be running
  // when the next line shows up (/exit especially). Every line joins one FIFO:
  // a pending question takes it first, the session loop takes the rest, one at
  // a time. Nothing is dropped and nothing overtakes anything.
  let pumpingHeld = false;
  let eofPending = false;
  const pumpHeld = () => {
    if (ask.busy() || ask.held()) return;   // a question owns the next line
    const line = ask.peek();
    if (line == null) {
      if (eofPending && !busy) doExit();
      return;
    }
    if (!handleRef) { setTimeout(pumpHeld, 30); return; }
    // while a task runs, a held line is a live steer and must not wait for it
    if (busy) {
      ask.take();
      void handleRef(line);
      pumpHeld();
      return;
    }
    if (pumpingHeld) return;
    ask.take();
    pumpingHeld = true;
    void (async () => {
      try { await handleRef(line); } catch {}
      finally { pumpingHeld = false; pumpHeld(); }
    })();
  };
  // Bracketed-paste terminals (most modern ones) never get here: the paste
  // arrives as one ESC[200~ ... ESC[201~ burst and is staged atomically above.
  // This coalescer is the fallback for terminals without the markers: pastes
  // land as a burst of lines and readline submits each one. Coalesce the burst
  // into a single input so a 20-line prompt runs as one task, not twenty.
  // Trailing debounce: every arriving line resets the timer, so a slow terminal
  // paste stays in one piece; ~100ms after the last line, it all flushes at once.
  // (TUI only: pipes and tests keep the exact line-by-line behavior.)
  let pasteBuf = [];
  let pasteTimer = null;
  const flushPaste = () => {
    pasteTimer = null;
    const lines = pasteBuf.splice(0);
    if (!lines.length) return;
    const allSlash = lines.every(x => x.startsWith('/'));
    if (allSlash) {
      // separate commands (possibly interleaved with prose-only lines): run each
      // one after another, so /exit cannot race with the command before it
      void (async () => {
        try {
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            if (closed) return;
            await handleRef?.(t);
          }
        } catch (err) { say(red('  ✗ ' + (err?.message ?? String(err)))); }
      })();
      return;
    }
    const joined = lines.join('\n').replace(/^\n+|\n+$/g, '');
    if (joined) handleRef?.(joined);
  };
  const dispatchLine = l => {
    pasteBuf.push(l);
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(flushPaste, 100);
  };
  // The composer repaints the input line itself, so readline must not echo:
  // its output would land as ghost text at whatever row the cursor sits on.
  // While a raw prompt is pending (approval, /model, /resume...) the prompt is
  // printed directly, so echo stays on just for it.
  let askPending = false;
  let rlClosed = false;   // set when readline has closed (EOF) but a task still runs
  // Paste coalescing works on any real terminal (Windows consoles included).
  // Pipes and tests keep the exact line-by-line behavior.
  const ask = makeInput(rl, process.stdout.isTTY ? dispatchLine : (l => { ask.hold(l); pumpHeld(); }), p => { askPending = p; if (!p) pumpHeld(); });
  if (TUI) rl._writeToOutput = s => { if (askPending) process.stdout.write(s); };
  // EOF (Ctrl+D or closed pipe): exit cleanly, unless a task is still running
  rl.on('close', () => {
    rlClosed = true;
    if (ask.peek() != null || pumpingHeld || ask.busy()) {  // piped lines still waiting
      eofPending = true;
      pumpHeld();
      return;
    }
    if (!busy) doExit();
    else {
      // input closed while work is still going: say what is happening and leave
      // a nonzero exit code, because the task did NOT finish
      console.log(yellow('  Input closed while a task is still running.'));
      console.log(dim('  Waiting up to 30s for it to finish, then stopping. Ctrl+C stops now.'));
      const wait = setInterval(() => { if (!busy) { clearInterval(wait); doExit(); } }, 200);
      setTimeout(() => {
        clearInterval(wait);
        activeRun?.abort();
        console.log(yellow('  Stopped before the task finished.'));
        if (TUI) { try { screen.resetRegion(); screen.exit(); } catch {} }
        process.exit(2);
      }, 30_000);
    }
  });

  // plain mode: async output must not bury the half-typed input line (the
  // classic cmd complaint: "I delete/type and can't see what I wrote"). Wipe
  // the current visual line, print, then redraw the prompt WITH the typed
  // buffer so what the user wrote is always visible. During a task (busy)
  // there is no prompt to protect: print plainly, as tests and pipes expect.
  const plainSay = lines => {
    if (closed || rlClosed || busy || !process.stdout.isTTY) return console.log(lines);
    // ASCII-only wipe: legacy conhost may not translate ANSI escapes, so a
    // raw \x1b[2K would print as literal garbage there
    const cols = Math.max(10, (process.stdout.columns || 80) - 1);
    process.stdout.write('\r' + ' '.repeat(cols) + '\r');
    console.log(lines);
    try { rl._refreshLine?.(); } catch { plainPrompt(); }
  };
  const say = TUI ? lines => tuiPrint(lines) : lines => plainSay(lines);

  function doExit() {
    closed = true;
    // a killed process must never leave the terminal in alt-screen with a
    // hidden cursor, so restore it on the way out no matter how we got here
    try { if (TUI) { screen.resetRegion(); screen.exit(); } } catch {}
    // save whatever happened and hand back the resume code
    let code = null;
    if (history.length) {
      try { code = saveSession({ id: sessionId, cwd: process.cwd(), model: state.model, history }); } catch {}
    }
    console.log(dim('Goodbye.'));
    if (code) {
      console.log('');
      console.log(bold(green('Session ' + code)) + dim(`  ${Math.floor(history.length / 2)} turns · ${state.model}`));
      console.log(dim('  Resume it: start ') + bold('ineed') + dim(' and type ') + bold('/resume ' + code));
    }
    process.exit(0);
  }

  async function pickModel() {
    let models = [];
    try { models = await fetchModels(state); } catch (err) { say(red('   ' + err.message)); return; }
    if (models.length === 0) {
      say(yellow('   Server sent no list. Change model by editing ~/.ineedcodes/config.json'));
      return;
    }
    // full list: the picker scrolls, so nothing is hidden beyond a fixed slice
    const list = models;
    // last working model first, so a 403 "deposit required" recovery is one enter away
    const ordered = state.lastGood && list.includes(state.lastGood)
      ? [state.lastGood, ...list.filter(m => m !== state.lastGood)]
      : list;
    say(dim(`   ${list.length} models available.` + (state.lastGood && ordered[0] === state.lastGood ? ' last working is first.' : '')));
    let chosen = null;
    if (TUI) {
      const idx = await pickFromList(ordered);
      if (idx !== null) chosen = ordered[idx];
      else return;   // Esc on the picker cancels, no second prompt
    }
    if (chosen === null) {
      // plain REPL: the numbered list must actually be visible to pick from
      ordered.forEach((m, i) => say(`   ${i + 1}. ${m}`));
      const pick = await ask('   Model (number or full id, empty = keep current): ');
      const t = pick.trim();
      if (!t) return;
      if (/^\d+$/.test(t)) {
        const idx = Number(t);
        if (idx >= 1 && idx <= ordered.length) chosen = ordered[idx - 1];
        else { say(red(`   No model number ${t}. Pick 1-${ordered.length}.`)); return; }
      } else if (/^[A-Za-z0-9._:\/-]{1,120}$/.test(t)) {
        chosen = t;   // full id typed by hand
      } else {
        say(red('   That does not look like a model id.'));
        return;
      }
    }
    Object.assign(state, normalize({ ...state, model: chosen }));
    try { saveConfig(state); } catch {}
    say(green('   Model: ' + state.model));
    if (TUI) drawStatus();
  }

  let lastStreamedForHooks = '';
  let streamFlushTimer = null;
  let streamAnchor = -1;      // chatLines index where the growing answer starts
  let streamPainted = 0;      // lines the last flush painted for this stream
  const chatLines = [];

  function flushStreamed() {
    if (!TUI || !lastStreamedForHooks) return;
    const wrapped = wrapLines(lastStreamedForHooks, Math.max(10, (process.stdout.columns || 80) - 4));
    if (streamAnchor < 0 || streamAnchor > chatLines.length) streamAnchor = chatLines.length;
    // replace only the lines this stream painted; anything said in between
    // (tool lines, notes, approvals) keeps its place below the growing answer
    chatLines.splice(streamAnchor, streamPainted);
    chatLines.splice(streamAnchor, 0, ...wrapped);
    streamPainted = wrapped.length;
    redrawChat();
  }

  // a new reasoning round streams as its own block: the previous round's text
  // stays painted, this round starts a fresh growing answer
  const resetStream = () => {
    lastStreamedForHooks = '';
    streamAnchor = -1;
    streamPainted = 0;
    if (streamFlushTimer) { clearTimeout(streamFlushTimer); streamFlushTimer = null; }
  };

  function hooksForRun(stopSpinner) {
    let spinner = null;
    // phase-level stop: drops the plain-REPL spinner; the TUI working line is
    // owned by the task and keeps ticking across phases (spinnerStop ends it)
    const stop = () => {
      spinner?.stop(); spinner = null;
    };
    // Compact live status line: "• Working (12s · esc to interrupt)". The tick
    // only repaints that one row, so nothing else on screen can smear.
    const boxSpin = label => {
      if (!TUI) return startSpinner(label);
      startWork(label);
      return { stop: () => {} };
    };
    return {
      // task-level stop: also ends the live working line (runTask finally)
      spinnerStop: () => { stop(); stopWork(); },
      onMemoryStart: () => { stop(); spinner = boxSpin('Recalling memory'); },
      onMemoryEnd: () => stop(),
      onThinkingStart: () => { stop(); resetStream(); spinner = boxSpin('Working'); },
      onThinkingEnd: () => stop(),
      onWorkStart: label => { stop(); spinner = boxSpin(label || 'Working'); },
      onWorkEnd: () => stop(),
      onTool: (name, input2) => {
        stop();
        runStartedAt = runStartedAt || Date.now();
        lastToolName = name;
        say(fmtToolLine(name, input2));
      },
      onResult: out => {
        // renders right below the tool event that produced it; spawn_agent and
        // todo results are already reported by onAgentEnd / onTodos
        if (lastToolName === 'spawn_agent' || lastToolName === 'todo') return;
        say(fmtResultLine(lastToolName ?? '', out));
      },
      onText: t => { stop(); },
      onDelta: chunk => {
        // stream into the chat buffer; the full text lands on flushStreamed()
        lastStreamedForHooks += chunk;
        if (TUI && !streamFlushTimer) {
          streamFlushTimer = setTimeout(() => { streamFlushTimer = null; flushStreamed(); }, 120);
        }
      },
      onTodos: list => {
        stop();
        const mark = s => s === 'completed' ? T.success('✓') : s === 'in_progress' ? T.tool('▸') : T.muted('○');
        say(T.muted('  ── checklist ──'));
        for (const t of list.slice(0, 12)) say('  ' + mark(t.status) + ' ' + T.text(trunc(t.content, (process.stdout.columns || 80) - 10)));
      },
      onAgentStart: (id, input) => {
        stop();
        say('  ' + T.tool('•') + ' ' + T.text(id) + T.muted(' ' + (input.role ?? '') + ' · ') + T.muted(trunc(String(input.objective ?? ''), 70)));
      },
      onAgentEnd: (id, r) => {
        stop();
        const bad = r.status !== 'completed';
        say('  ' + (bad ? T.warning('✗') : T.success('✓')) + ' ' + T.text(id) + T.muted(` ${bad ? r.status : 'completed'} · `) + T.muted(trunc(String(r.summary ?? '').replaceAll('\n', ' '), 90)));
      },
      onMCP: names => { if (names.length) say(T.muted('  MCP tools available: ' + names.join(', '))); },
      onMCPResult: (name, out) => { say(fmtResultLine(name, out)); },
        onNote: note => {
          stop();
          if (note.includes('applying your steer')) {
            // drop only the stale partial of the interrupted call; the rest of
            // the transcript (logo, prior turns, tool output) stays intact
            resetStream();
            if (TUI && typeof tuiReady !== 'undefined' && tuiReady) redrawChat();
          }
          say(T.muted('  ◇ ' + note));
        },
        onUsage: u => {
        usage = u;
        taskTokens = (u.input || 0) + (u.output || 0);
        sessionTokens += Math.max(0, taskTokens - taskSeen);
        taskSeen = taskTokens;
        if (TUI) drawStatus();
      },
        drainSteer: () => steerQueue.splice(0),
      onSteer: list => { for (const s of list) say(T.warning('  ↳ steer: ') + T.text(s)); },
      onApprove: async (cat, name, input2) => {
        stop();
        // show what will actually happen: the path or the command, not a slice of JSON
        const detail = input2?.command ? String(input2.command)
          : input2?.url ? String(input2.url)
          : input2?.path ? String(input2.path)
          : trunc(JSON.stringify(input2 ?? {}), 90);
        const overwrites = (name === 'write_file' || name === 'copy_file' || name === 'move_file') && input2?.path
          && fs.existsSync(path.resolve(process.cwd(), String(input2.path))) ? T.warning('  (overwrites an existing file)') : '';
        say(T.warning('  ⚠ approval needed') + ' ' + T.command(name) + T.muted(' ' + detail) + overwrites);
        const a = await ask('     [y] once · [a] this session · [s] always (save) · [n] no: ');
        const c = a.trim().toLowerCase();
        if (c === 's' || c === 'save') {
          approved.add(cat);
          if (cat === 'edit') Object.assign(state, normalize({ ...state, permEdit: 'allow' }));
          if (cat === 'shell') Object.assign(state, normalize({ ...state, permShell: 'allow' }));
          saveConfig(state);
          say(T.muted('     always allowed, saved to config. /perm safe to undo.'));
          return 'always';
        }
        if (c === 'a' || c === 'always') { approved.add(cat); say(T.muted('     always allowed for this session.')); return 'always'; }
        if (c === 'y' || c === 'yes') return true;
        say(T.muted('     denied.'));
        return false;
      },
      approved,
      onRunStart: c => { activeRun = c; },
      onRunEnd: () => { activeRun = null; stop(); }
    };
  }

  async function runTask(input, retries = 0) {
    busy = true;
    resetStream();
    lastToolName = null;
    runStartedAt = Date.now();
    if (TUI) tuiUserLine(input);
    const hooks = hooksForRun();
    const stopSpinner = hooks.spinnerStop;
    startWork('Working');
    let taskSeen = 0;
    let retrying = false;   // the retry's own finally owns the cleanup then
    try {
      const res = await runObjective(state, input, process.cwd(), history, hooks);
      // kill a pending stream flush before painting the verdict, or it would
      // truncate the chat back past the Done line
      if (streamFlushTimer) { clearTimeout(streamFlushTimer); streamFlushTimer = null; }
      if (TUI) flushStreamed();
      if (lastStreamedForHooks && TUI) process.stdout.write('\n');
      history = pushTurn(history, input, res);
      stopSpinner();
      // task over: the working line disappears (or changes to the verdict line)
      stopWork();
      if (TUI) drawInputBox();
      // this model just finished a task cleanly: remember it as the fallback
      if (!res.aborted && state.model !== state.lastGood) {
        Object.assign(state, normalize({ ...state, lastGood: state.model }));
        try { saveConfig(state); } catch {}
      }
      try { history = await compactHistory(state, history, { onNote: n => say(T.muted('  ◇ ' + n)) }); } catch {}
      try { sessionId = saveSession({ id: sessionId, cwd: process.cwd(), model: state.model, history }); } catch {}
      if (res.aborted) {
        if (res.stopReason === 'step_limit') {
          say(T.warning('  ■ Out of steps') + T.muted(` - hit the ${res.maxSteps ?? MAX_STEPS} step limit before finishing.`));
        } else {
          say(T.warning('  ■ Stopped') + T.muted(' - you interrupted the task.'));
        }
        // partial report: what actually happened before the stop, so "partly
        // done" is never a dead end with nothing to show
        if (res.changed?.length) say('  ' + T.muted('files touched: ') + T.text(res.changed.join(', ')));
        if (res.ran?.length) say('  ' + T.muted(`commands run: ${res.ran.length}`) + T.muted(' (last: ') + T.text(trunc(String(res.ran[res.ran.length - 1]), 60)) + T.muted(')'));
        const doneTodos = res.todos?.filter(t => t.status === 'completed').length ?? 0;
        if (res.todos?.length) say('  ' + T.muted(`checklist: ${doneTodos}/${res.todos.length} done`));
        const follow = res.stopReason === 'step_limit' ? ' Say "continue" to pick up where it left off.' : ' Ask me to continue when ready.';
        say(T.muted('  ' + follow.trim()));
      } else {
        // flat summary: no card, just the result line plus the answer text
        const tIn = res.usage?.input ?? 0;
        const tOut = res.usage?.output ?? 0;
        say('  ' + T.success('✓ Done')
          + (res.changed?.length ? T.muted('  files: ' + res.changed.join(', ')) : '')
          + (tIn + tOut ? T.muted('  ' + kfmt(tIn + tOut) + ' tokens') : ''));
        // compare stripped text and use includes(): wrapLines repaints in place,
        // so byte equality is too brittle. Only in TUI, where streaming actually
        // painted something; in plain mode the answer must always be printed
        const answerIsStreamed = TUI && lastStreamedForHooks
          && plain(res.answer ?? '').includes(plain(lastStreamedForHooks));
        if (res.answer && !answerIsStreamed) String(res.answer).split('\n').slice(0, 14).forEach(l => say('  ' + l));
        else if (answerIsStreamed) say(T.muted('  (streamed above)'));
        else if (!res.changed?.length) say(T.muted('  (no output)'));
      }
    } catch (err) {
      if (streamFlushTimer) { clearTimeout(streamFlushTimer); streamFlushTimer = null; }
      stopSpinner();
      stopWork();
      history = pushTurn(history, input, { answer: '(task failed: ' + err.message + ')' });
      try { sessionId = saveSession({ id: sessionId, cwd: process.cwd(), model: state.model, history }); } catch {}
      say(T.error('  ✗ ' + err.message) + T.muted('  context kept.'));
      if (err.partial?.changed?.length) say('  ' + T.muted('files already changed: ') + T.text(err.partial.changed.join(', ')));
      if (err.partial?.ran?.length) say('  ' + T.muted(`commands already run: ${err.partial.ran.length}`) + T.muted(' (last: ') + T.text(trunc(String(err.partial.ran[err.partial.ran.length - 1]), 60)) + T.muted(')'));
      if (err.partial?.changed?.length) say('  ' + T.muted('look at those files before re-running: a half-finished edit may be there'));
      // model/connection trouble: offer the fix right here instead of making the
      // user remember /model (bounded retries so it can never loop forever)
      const recoverable = !err?.stopped
        && retries < 5
        && /HTTP \d{3}|model|timed out|cannot reach|fetch failed|ECONN|ENOTFOUND|network|401|403|404|429|5\d\d/i.test(String(err?.message ?? ''));
      if (recoverable) {
        stopWork();
        if (TUI) drawInputBox();
        const hint = state.lastGood && state.lastGood !== state.model ? ` [l] back to ${prettyModel(state.lastGood)}` : '';
        const a = (await ask(`  [m] pick another model${hint} · [r] retry · [Enter] skip: `)).trim().toLowerCase();
        // awaited so finally does not clear busy/activeRun while the retry runs
        if (a === 'm') { await pickModel(); retrying = true; return await runTask(input, retries + 1); }
        if (a === 'l' && state.lastGood && state.lastGood !== state.model) {
          Object.assign(state, normalize({ ...state, model: state.lastGood }));
          try { saveConfig(state); } catch {}
          say(green('  Model: ' + state.model));
          retrying = true; return await runTask(input, retries + 1);
        }
        if (a === 'r') { retrying = true; return await runTask(input, retries + 1); }
      }
    } finally {
      runStartedAt = 0;
      lastToolName = null;
      working = false;
      stopSpinner();
      busy = false;
      activeRun = null;
      if (!retrying) await afterTask();
    }
  }

  async function afterTask() {
    if (closed) return;
    // notes typed near the end that never reached the model become follow-up tasks
    if (steerQueue.length) pendingLines.unshift(...steerQueue.splice(0));
    if (TUI) { drawStatus(); drawInputBox(); scrollRegion(); }
    else plainPrompt();
    // queued commands/steer notes typed mid-task run now, in both modes
    while (!busy && !closed) {
      const next = pendingLines.shift();
      if (!next) break;
      await handle(next);
    }
  }

  const commands = {
    '/help': () => {
      say('  ' + cyan('/model') + '    pick a model from your provider');
      say('  ' + cyan('/provider') + ' list, switch, add or remove API providers');
      say('  ' + cyan('/plan') + '     plan mode: read only');
      say('  ' + cyan('/build') + '    build mode: real changes (default)');
      say('  ' + cyan('/reason') + '   toggle reasoning low/high');
      say('  ' + cyan('/perm') + '     permissions: /perm auto | /perm safe | /perm');
      say('  ' + cyan('/boost') + '    isolated git-worktree run: /boost <objective>');
      say('  ' + cyan('/config') + '   show provider config (key hidden)');
      say('  ' + cyan('/memory') + '   memory status, /memory on|off to toggle');
      say('  ' + cyan('/status') + '   everything about this session at a glance');
      say('  ' + cyan('/compact') + '  shrink the conversation into a checkpoint');
      say('  ' + cyan('/depth') + '    answer depth: /depth short|normal|deep');
      say('  ' + cyan('/theme') + '    pick a color theme (arrow keys): dark, light, mono, nord, dracula, synthwave');
      say('  ' + cyan('/new') + '     start a fresh session, keep the old saved');
      say('  ' + cyan('/resume') + '   list sessions, /resume <code> like 1425-0609');
      say('  ' + cyan('/skills') + '   list installed skills, /skills <name> shows one');
      say('  ' + cyan('/init') + '     scan this folder and write AGENTS.md for the agent');
      say('  ' + cyan('/mcp') + '     list MCP servers and their tools');
      say('  ' + cyan('/humanizer') + ' natural-writing pass for pages and posts (on/off)');
      say('  ' + cyan('/clear') + '    forget this conversation');
      say('  ' + cyan('/setup') + '    redo provider setup');
      say('  ' + cyan('/reset') + '    clear saved config');
      say('  ' + cyan('/help') + '     this list. Type normally to work, steer mid-task anytime');
      say(dim('  while a task runs: your text is a live steer, /stop cancels it'));
      say('  ' + cyan('/exit') + '     quit');
    },
    // one guided menu instead of a wall of toggles: six things a beginner
    // actually cares about, each a numbered choice in plain language
    '/config': async arg => {
      const yn = v => v ? T.success('on') : T.muted('off');
      const askMode = v => v === 'allow' ? T.success('always allowed') : T.text('asks first');
      const rows = [
        ['1. May it change files?', askMode(state.permEdit), '/perm'],
        ['2. May it run commands?', askMode(state.permShell), '/perm'],
        ['3. May it use the internet?', state.permNet === 'ask' ? T.text('asks first') : T.success('always allowed'), '/perm'],
        ['4. Work mode', mode === 'plan' ? T.text('plan (read only)') : T.text('build (can change files)'), '/plan /build'],
        ['5. Answer length', T.text({ short: 'short', normal: 'normal', deep: 'detailed' }[state.explain] ?? state.explain), '/depth'],
        ['6. Remember past sessions?', yn(state.memory !== false), '/memory']
      ];
      const pickOne = async (question, options) => {
        say(T.muted('   ' + question));
        options.forEach((o, i) => say('   ' + (i + 1) + '. ' + o.label + (o.current ? T.muted('  (current)') : '')));
        const a = (await ask('   pick a number (Enter to cancel): ')).trim();
        if (!a) return null;
        const n = Number(a);
        if (!Number.isInteger(n) || n < 1 || n > options.length) { say(red('   pick 1-' + options.length + '.')); return null; }
        return options[n - 1].value;
      };
      if (arg) {
        // old style still works: /config show, and the raw values stay visible
        const names = rows.map(r => r[2]);
        if (names.includes(arg.trim())) { say(T.muted('  use: ' + arg.trim())); }
      }
      say(T.muted('  ── settings ──'));
      for (const [label, value, cmd] of rows) say('  ' + label.padEnd(30) + value + T.muted('   (' + cmd + ')'));
      say('  ' + T.muted('provider  ') + T.text(state.provider || '(none)') + T.muted('   ' + state.baseUrl));
      say('  ' + T.muted('model     ') + T.text(state.model));
      say('  ' + T.muted('API key   ') + T.muted('saved, hidden'));
      const arg2 = arg?.trim();
      if (!arg2) {
        const n = (await ask('  change what? (number, Enter to quit): ')).trim();
        if (!n) return;
        const num = Number(n);
        if (num === 1 || num === 2 || num === 3) {
          const key = num === 1 ? 'permEdit' : num === 2 ? 'permShell' : 'permNet';
          const v = await pickOne('Permission to ' + ['change files', 'run commands', 'use the internet'][num - 1] + '?', [
            { label: 'always allowed (works without asking)', value: 'allow' },
            { label: 'ask me every time (safest)', value: 'ask' }
          ]);
          if (!v) return;
          Object.assign(state, normalize({ ...state, [key]: v }));
          try { saveConfig(state); } catch {}
          say(green('  now: ') + T.text(v === 'allow' ? 'always allowed' : 'asks first'));
          if (TUI) drawStatus();
          return;
        }
        if (num === 4) {
          const v = await pickOne('May the agent change files?', [
            { label: 'yes (build)', value: 'build' },
            { label: 'read only first (plan)', value: 'plan' }
          ]);
          if (!v) return;
          mode = v;
          Object.assign(state, normalize({ ...state, mode }));
          say(green('  mode: ') + T.text(v === 'plan' ? 'plan (read only)' : 'build (can change files)'));
          if (TUI) drawStatus();
          return;
        }
        if (num === 5) {
          const v = await pickOne('How long should answers be?', [
            { label: 'short (results only)', value: 'short' },
            { label: 'normal', value: 'normal' },
            { label: 'detailed (with explanations)', value: 'deep' }
          ]);
          if (!v) return;
          Object.assign(state, normalize({ ...state, explain: v }));
          try { saveConfig(state); } catch {}
          say(green('  answers: ') + T.text(v));
          if (TUI) drawStatus();
          return;
        }
        if (num === 6) {
          const v = await pickOne('Remember work from past sessions?', [
            { label: 'on', value: true },
            { label: 'off', value: false }
          ]);
          if (v == null) return;
          Object.assign(state, normalize({ ...state, memory: v }));
          try { saveConfig(state); } catch {}
          say(green('  memory: ') + T.text(v ? 'on' : 'off'));
          if (TUI) drawStatus();
          return;
        }
        say(red('  pick 1-6, or Enter to quit.'));
      }
    },
    '/theme': async arg => {
      const apply = v => {
        setTheme(v);
        Object.assign(state, normalize({ ...state, theme: v }));
        try { saveConfig(state); } catch {}
        say(green('  Theme: ' + v));
        if (TUI) { layout({ clear: true }); drawStatus(); }
      };
      const names = themeNames();
      const v = String(arg ?? '').trim().toLowerCase();
      if (names.includes(v)) return apply(v);
      const cur = getTheme();
      if (TUI) {
        // arrow-key picker, same as /model: live preview, Enter to keep
        const labels = names.map(n => n + (n === cur ? '  (current)' : ''));
        const idx = await pickFromList(labels);
        if (idx !== null) apply(names[idx]);
        else say(T.muted('  theme: ' + cur));
        return;
      }
      say('  ' + T.muted('themes (current: ' + cur + '):'));
      names.forEach((n, i) => say(`   ${i + 1}. ${n}`));
      const pick = await ask('   Theme number or name (empty = keep): ');
      const t = pick.trim().toLowerCase();
      if (!t) return;
      if (names.includes(t)) return apply(t);
      const n = Number(t);
      if (Number.isInteger(n) && n >= 1 && n <= names.length) return apply(names[n - 1]);
      say(red('  No theme named ' + t + '.'));
    },
    '/clear': async () => {
      history = [];
      if (sessionId) {
        const { deleteSession } = await import('./sessions.js');
        const answer = (await ask('  Also delete the saved copy on disk? [y/N] ')).trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') {
          deleteSession(sessionId);
          say(dim('Conversation and its saved copy are gone.'));
        } else {
          say(dim('Chat cleared here. The saved copy still exists (/resume ' + sessionId + ').'));
        }
      } else {
        say(dim('Conversation forgotten.'));
      }
    }
  };

    // every dispatch path fires handle() without awaiting it, so it must never
  // reject: a cancelled prompt (Ctrl+C) or a stray error would otherwise end
  // as an unhandled rejection instead of a message on screen
  async function handle(input) {
    try { return await handleInner(input); }
    catch (err) {
      if (closed) return;
      if (err?.aborted) say(dim('  cancelled.'));
      else say(red('  ✗ ' + (err?.message ?? String(err))));
    }
  }

  async function handleInner(input) {
    if (!input) return;
    if (busy) {
      if (input === '/stop' || input.startsWith('/stop ') || input === 'stop') { activeRun?.abort(); say(dim('  (stopping...')); return; }
      if (input.startsWith('/')) { pendingLines.push(input); return; }
      // a plain word like "provider" or "status" is a command, not a steer
      const asCommand = shortcutCommand(input);
      if (asCommand) { pendingLines.push(asCommand); say(T.muted('  (queued: ' + asCommand + ' runs when the task stops)')); return; }
      steerQueue.push(input);
      // interrupt the in-flight provider call so the steer applies immediately
      if (activeRun) activeRun.abort('steer');
      say(dim('  ↳ steer noted, applying it now...'));
      return;
    }
    if (['/exit', '/quit', 'exit', 'quit'].includes(input)) return doExit();
    if (input === '/help' || input === '?') return commands['/help']();
    if (input === '/theme' || input.startsWith('/theme ')) { busy = true; try { await commands['/theme'](input.slice(6).trim()); } finally { busy = false; } return afterTask(); }
    if (input === '/config' || input === '/config show') { busy = true; try { await commands['/config'](''); } finally { busy = false; } return afterTask(); }
    if (input.startsWith('/config ')) {
      // /config <setting> <value>: change one setting and save
      const parts = input.slice(8).trim().split(/\s+/);
      const [setting, value] = parts;
      const persist = () => { Object.assign(state, normalize({ ...state, mode })); saveConfig(state); if (TUI) drawStatus(); };
      const needs = { model: 'run /model', mode: 'run /plan or /build' };
      if (setting === 'model' || setting === 'mode') { say(dim('  ' + (needs[setting]))); return; }
      if (setting === 'reasoning' && ['low', 'high'].includes(value)) { Object.assign(state, normalize({ ...state, reasoning: value })); persist(); say(green('  reasoning: ' + value)); return; }
      if (setting === 'depth' && ['short', 'normal', 'deep'].includes(value)) { Object.assign(state, normalize({ ...state, explain: value })); persist(); say(green('  depth: ' + value)); return; }
      if (setting === 'memory' && ['on', 'off'].includes(value)) { Object.assign(state, normalize({ ...state, memory: value === 'on' })); saveConfig(state); say(green('  memory: ' + value)); return; }
      if (setting === 'humanizer' && ['on', 'off'].includes(value)) { Object.assign(state, normalize({ ...state, humanize: value === 'on' })); saveConfig(state); say(green('  humanizer: ' + value)); return; }
      if (setting === 'net' && ['allow', 'ask'].includes(value)) { Object.assign(state, normalize({ ...state, permNet: value })); persist(); say(green('  net perm: ' + value)); return; }
      if (setting === 'edit' && ['allow', 'ask'].includes(value)) { Object.assign(state, normalize({ ...state, permEdit: value })); persist(); say(green('  edit perm: ' + value)); return; }
      if (setting === 'shell' && ['allow', 'ask'].includes(value)) { Object.assign(state, normalize({ ...state, permShell: value })); persist(); say(green('  shell perm: ' + value)); return; }
      if (setting === 'searchurl') { Object.assign(state, normalize({ ...state, searchUrl: parts.slice(1).join(' ') })); persist(); say(green('  searchUrl set.')); return; }
      if (setting === 'baseurl' || setting === 'url') {
        const url = parts.slice(1).join(' ').trim();
        if (!/^https?:\/\//.test(url)) { say(red('  base URL must start with http:// or https://')); return; }
        Object.assign(state, normalize({ ...state, baseUrl: url }));
        saveConfig(state);
        say(green('  base URL: ' + state.baseUrl) + T.muted('  (provider: ' + (state.provider || 'default') + ', model: ' + state.model + ')'));
        if (TUI) drawStatus();
        return;
      }
      say(dim('  Settings: reasoning|depth|memory|humanizer|edit|shell|net|baseurl|searchurl <value> · providers via /provider · model via /model · mode via /plan /build'));
      return;
    }
    if (input === '/config-menu') {
      // interactive settings menu
      busy = true;
      try {
        const opts = [
          ['model', state.model],
          ['mode', mode],
          ['reasoning', state.reasoning],
          ['depth', state.explain],
          ['edit perm', state.permEdit],
          ['shell perm', state.permShell],
          ['net perm', state.permNet],
          ['memory', state.memory === false ? 'off' : 'on'],
          ['humanizer', state.humanize === false ? 'off' : 'on']
        ];
        opts.forEach((o, i) => say(`   ${i + 1}. ${o[0].padEnd(12)} ${o[1]}`));
        const pick = await ask('   Setting number to change (empty = cancel): ');
        const n = Number(pick);
        if (!n || !opts[n - 1]) { say(dim('   Cancelled.')); busy = false; return afterTask(); }
        const key = opts[n - 1][0];
        if (key === 'model') { busy = false; await pickModel(); busy = true; }
        else if (key === 'mode') { const v = await ask('   mode (plan/build): '); if (['plan', 'build'].includes(v)) { mode = v; Object.assign(state, normalize({ ...state, mode: v })); saveConfig(state); } }
        else if (key === 'reasoning') { const v = await ask('   reasoning (low/high): '); if (['low', 'high'].includes(v)) { Object.assign(state, normalize({ ...state, reasoning: v })); saveConfig(state); } }
        else if (key === 'depth') { const v = await ask('   depth (short/normal/deep): '); if (['short', 'normal', 'deep'].includes(v)) { Object.assign(state, normalize({ ...state, explain: v })); saveConfig(state); } }
        else if (key === 'edit perm') { const v = await ask('   edit perm (allow/ask): '); if (['allow', 'ask'].includes(v)) { Object.assign(state, normalize({ ...state, permEdit: v })); saveConfig(state); } }
        else if (key === 'shell perm') { const v = await ask('   shell perm (allow/ask): '); if (['allow', 'ask'].includes(v)) { Object.assign(state, normalize({ ...state, permShell: v })); saveConfig(state); } }
        else if (key === 'net perm') { const v = await ask('   net perm (allow/ask): '); if (['allow', 'ask'].includes(v)) { Object.assign(state, normalize({ ...state, permNet: v })); saveConfig(state); } }
        else if (key === 'memory') { const v = await ask('   memory (on/off): '); if (['on', 'off'].includes(v)) { Object.assign(state, normalize({ ...state, memory: v === 'on' })); saveConfig(state); } }
        else if (key === 'humanizer') { const v = await ask('   humanizer (on/off): '); if (['on', 'off'].includes(v)) { Object.assign(state, normalize({ ...state, humanize: v === 'on' })); saveConfig(state); } }
        say(green('   Saved.'));
      } catch (err) { say(red('   ' + err.message)); }
      busy = false;
      return afterTask();
    }
    if (input === '/clear') return commands['/clear']();
    if (input === '/provider' || input.startsWith('/provider ')) {
      const arg = input.slice(9).trim();
      const names = providerNames(state);
      const switchTo = async name => {
        const pick = /^\d+$/.test(name) ? names[Number(name) - 1] : name;
        if (!pick || !state.providers[pick]) {
          say(red(`  No provider named ${name || '(empty)'}.`) + T.muted('  choices: ' + (names.join(', ') || '(none yet)')));
          return;
        }
        busy = true;
        say(T.muted('   fetching the model list from ' + state.providers[pick].baseUrl + '...'));
        try {
          const r = await switchProviderLive(state, pick, { signal: activeRun?.signal });
          if (!r.ok) { say(red('  ' + r.error)); return; }
          Object.assign(state, normalize(r.cfg));
          say(green('  Provider: ' + state.provider) + T.muted('  ' + state.baseUrl + '  model: ' + state.model));
          if (r.modelChanged) say(T.muted('   old model is not in that catalog, now using: ') + T.text(r.model));
          if (r.fetchError) {
            say(yellow('   Could not fetch the model list: ' + r.fetchError));
            say(T.muted('   try again: /provider ' + state.provider));
          } else if (r.models.length > 1) {
            say(T.muted('   want another model? type: /model'));
          }
        } catch (err) {
          say(red('  Could not switch provider: ' + (err.message ?? err)));
        } finally {
          busy = false;
          if (TUI) drawStatus();
        }
      };
      if (!arg) {
        say(T.muted('  ── providers ──'));
        if (!names.length) say(yellow('  no providers saved') + T.muted('  · add one: /provider add'));
        names.forEach((n, i) => {
          const p = state.providers[n];
          say('  ' + (n === state.provider ? T.success('* ') : '  ') + T.muted(String(i + 1) + '. ') + T.text(n)
            + T.muted('  ' + p.baseUrl + '  model: ' + (p.model || '(none)')));
        });
        say(T.muted('  pick: /provider <number>  · add: /provider add  · remove: /provider remove <name>'));
        return;
      }
      const parts = arg.split(/\s+/);
      const head = parts[0].toLowerCase();
      if (head === 'use') { await switchTo(parts[1] ?? ''); return; }
      if (head === 'remove') {
        if (!parts[1]) { say(T.muted('  usage: /provider remove <name>')); return; }
        if (!state.providers[parts[1]]) { say(red(`  No provider named ${parts[1]}.`)); return; }
        const ok = (await ask(`   remove provider "${parts[1]}" and its key? [y/N] `)).trim().toLowerCase();
        if (ok !== 'y' && ok !== 'yes') { say(T.muted('   cancelled.')); return; }
        const next = removeProvider(state, parts[1]);
        if (!next) { say(red(`  No provider named ${parts[1]}.`)); return; }
        Object.assign(state, normalize(next));
        say(green(`  Removed "${parts[1]}".`) + (state.provider ? T.muted(' Active: ' + state.provider) : T.muted(' No providers left.')));
        if (TUI) drawStatus();
        return;
      }
      if (head === 'add' || head === 'new') {
        const name = (parts[1] ?? '').trim() || (await ask('   provider name (e.g. openai, local): ')).trim();
        if (!name) return;
        busy = true;
        try {
          say(dim(`   Setting up provider "${name}"...`));
          const prof = await wizard(ask, { fromCommand: true, save: false });
          const next = addProvider(state, name, prof);
          if (!next) throw new Error('could not save the provider');
          Object.assign(state, normalize(next));
          say(green(`   Provider "${name}" saved and active.`) + T.muted('  ' + state.baseUrl + '  model: ' + state.model));
          if (TUI) drawStatus();
        } catch { say(red('   Setup aborted. Nothing changed.')); }
        busy = false;
        return afterTask();
      }
      await switchTo(arg);   // bare name or number switches
      return;
    }
    if (input === '/model') { busy = true; try { await pickModel(); } finally { busy = false; } return afterTask(); }
    if (input === '/plan') { mode = 'plan'; Object.assign(state, normalize({ ...state, mode })); say(yellow('Plan mode: read only.')); if (TUI) drawStatus(); return; }
    if (input === '/build') { mode = 'build'; Object.assign(state, normalize({ ...state, mode })); say(green('Build mode: real changes.')); if (TUI) drawStatus(); return; }
    if (input === '/reason') {
      Object.assign(state, normalize({ ...state, reasoning: state.reasoning === 'high' ? 'low' : 'high' }));
      say(dim('Reasoning effort: ' + state.reasoning));
      if (TUI) drawStatus();
      return;
    }
    if (input === '/perm' || input.startsWith('/perm ')) {
      const arg = input.slice(5).trim();
      const apply = (pe, ps, msg) => {
        Object.assign(state, normalize({ ...state, permEdit: pe, permShell: ps }));
        saveConfig(state);
        say(green(msg));
        if (TUI) drawStatus();
      };
      if (arg === 'auto') return apply('allow', 'allow', 'Permissions: edits and shell run without asking.');
      if (arg === 'safe') return apply('ask', 'ask', 'Permissions: edits and shell ask first.');
      const parts = arg.split(/\s+/);
      if (parts[0] === 'edit' && ['allow', 'ask'].includes(parts[1])) {
        return apply(parts[1], state.permShell, `Edit permission: ${parts[1]}.`);
      }
      if (parts[0] === 'shell' && ['allow', 'ask'].includes(parts[1])) {
        return apply(state.permEdit, parts[1], `Shell permission: ${parts[1]}.`);
      }
      say(T.muted('  ── permissions ──'));
      say('  ' + T.muted('edit') + '   ' + T.text(state.permEdit) + T.muted('  (write_file, edit_file, delete_file)'));
      say('  ' + T.muted('shell') + '   ' + T.text(state.permShell));
      say('  ' + T.muted('granted this session') + '  ' + T.text([...approved].join(', ') || 'none'));
      say('');
      say('  ' + T.muted('/perm auto') + '   never ask (saved)');
      say('  ' + T.muted('/perm safe') + '   ask for edits and shell (saved)');
      say('  ' + T.muted('/perm edit allow|ask   /perm shell allow|ask'));
      return;
    }
    if (input === '/memory' || input.startsWith('/memory ')) {
      const arg = input.split(/\s+/)[1];
      if (arg === 'on' || arg === 'off') {
        Object.assign(state, normalize({ ...state, memory: arg === 'on' }));
        saveConfig(state);
        say(arg === 'on'
          ? green('Memory: on') + dim(' - durable facts are recalled before tasks and stored after real work.')
          : yellow('Memory: off') + dim(' - nothing is recalled or stored.'));
        if (TUI) drawStatus();
        return;
      }
      busy = true;
      const provider = getMemoryProvider(state);
      if (!provider) { say(yellow('Memory is off.') + dim(' Turn it on with /memory on')); busy = false; return afterTask(); }
      const ok = await ICMAdapter.available();
      say(ok ? green('Memory: on') + dim(` via ${provider.name}.`) : yellow('Memory: provider not installed.') + dim(' Install icm to enable.'));
      busy = false;
      return afterTask();
    }
    if (input === '/status') {
      const onOff = v => v === false ? T.muted('off') : T.success('on');
      const askState = v => v === 'allow' ? T.success('always allowed') : T.text('asks first');
      say(T.muted('  ── Current status ──'));
      say('  ' + T.muted('model     ') + T.text(state.model) + T.muted('  at ' + (state.provider || 'default provider')));
      say('  ' + T.muted('address   ') + T.text(state.baseUrl));
      say('  ' + T.muted('mode      ') + (mode === 'plan'
        ? T.text('plan') + T.muted(' (read only, changes nothing)')
        : T.text('build') + T.muted(' (may change files)')) + T.muted('  change: /build or /plan'));
      say('  ' + T.muted('allow     ') + T.muted('edit files ') + askState(state.permEdit)
        + T.muted(' · run commands ') + askState(state.permShell)
        + T.muted(' · use internet ') + (state.permNet === 'ask' ? T.text('asks first') : T.success('always allowed'))
        + T.muted('  change: /perm auto'));
      say('  ' + T.muted('memory    ') + onOff(state.memory) + T.muted(' (notes from earlier sessions)')
        + T.muted('  change: /memory'));
      say('  ' + T.muted('humanizer ') + onOff(state.humanize) + T.muted(' (natural wording in html/md)')
        + T.muted('  change: /humanizer'));
      say('  ' + T.muted('detail    ') + T.text(state.explain) + T.muted(' (how long answers are)')
        + T.muted('  change: /depth'));
      say('  ' + T.muted('thinking  ') + T.text(state.reasoning === 'high' ? 'deeper (slower, costs more)' : 'normal')
        + T.muted('  change: /reason'));
      say('  ' + T.muted('mcp       ') + T.text(mcpConfigured() ? 'extra tools active' : 'no extra tools'));
      const spent = (usage.input || 0) + (usage.output || 0);
      say('  ' + T.muted('tokens    ') + T.text(spent
        ? usage.input + ' in / ' + usage.output + ' out  (this session ' + kfmt(sessionTokens) + ')'
        : '0 so far in this session'));
      say(T.muted('  price depends on your provider; /status shows the raw counts'));
      say('  ' + T.muted('session   ') + T.text(sessionId ?? 'not saved yet'));
      say('  ' + T.muted('folder    ') + T.path(shortPath(process.cwd())));
      say(T.muted('  change model: /model   change provider: /provider   all commands: /help'));
      return;
    }
    if (input === '/compact') {
      busy = true;
      say(dim('   Compacting conversation...'));
      const before = history.reduce((n, m) => n + (m.content?.length ?? 0) + 24, 0);
      history = await compactHistory(state, history, { force: true, onNote: n => say(dim('  ◇ ' + n)) });
      const after = history.reduce((n, m) => n + (m.content?.length ?? 0) + 24, 0);
      say(after < before ? green(`   Compact: ${(before / 1024).toFixed(1)}k -> ${(after / 1024).toFixed(1)}k chars.`) : dim('   Conversation too small to compact further.'));
      busy = false;
      return afterTask();
    }
    if (input === '/depth' || input.startsWith('/depth ')) {
      const arg = input.split(/\s+/)[1];
      if (['short', 'normal', 'deep'].includes(arg)) {
        Object.assign(state, normalize({ ...state, explain: arg }));
        saveConfig(state);
        say(green('Explanation depth: ' + arg));
      } else {
        say(T.muted('  ── explanation depth ──'));
        say('  ' + T.muted('/depth short') + '   results only');
        say('  ' + T.muted('/depth normal') + ' what changed and why (default)');
        say('  ' + T.muted('/depth deep') + '   reasoning, trade-offs, ruled-out paths');
      }
      return;
    }
    if (input === '/humanizer' || input.startsWith('/humanizer ')) {
      const arg = input.split(/\s+/)[1];
      if (arg === 'on' || arg === 'off') {
        Object.assign(state, normalize({ ...state, humanize: arg === 'on' }));
        saveConfig(state);
        say(arg === 'on'
          ? green('Humanizer: on') + dim(' - web pages and posts get a natural-writing pass after they are written.')
          : yellow('Humanizer: off') + dim(' - files are written exactly as the model produces them.'));
        return;
      }
      say(T.muted('  ── humanizer ──'));
      say('  ' + T.muted('status') + '      ' + T.text(state.humanize === false ? 'off' : 'on'));
      say('  ' + T.muted('scope') + '      ' + T.text('.html .htm .md .txt (web pages, posts, docs)'));
      say('  ' + T.muted('never touches') + '  ' + T.text('code, tags, attributes, URLs, JSON, technical values'));
      say('  ' + T.muted('toggle') + '      ' + T.text('/humanizer on | /humanizer off'));
      return;
    }
    if (input === '/boost cancel') {
      if (!lastBoost) { say(dim('No boost run to cancel.')); return; }
      const { dir, branch } = lastBoost;
      boost.cleanupBoost(process.cwd(), dir, branch);
      lastBoost = null;
      say(yellow('Boost worktree and branch removed.'));
      return;
    }
    if (input === '/boost' || input.startsWith('/boost ')) {
      const objective = input.slice(6).trim();
      if (!objective) {
        say(T.muted('  ── boost: isolated execution in a git worktree ──'));
        say('  ' + T.muted('/boost <objective>') + '  run the task away from your tree, review, then merge');
        say('  ' + T.muted('/boost cancel') + '        remove the last boost worktree');
        return;
      }
      busy = true;
      startWork('Boosting');   // boost owns its own working line: nothing else stops it
      try {
        if (!boost.boostAvailable(process.cwd())) { say(yellow('Boost needs a git repository (with a commit).')); return; }
        const b = boost.startBoost(process.cwd());
        if (!b.ok) { say(red('Boost failed: ' + b.error)); return; }
        lastBoost = b;
        say(cyan(`  ⚡ boost ${b.branch}`) + dim(` worktree at ${b.dir}`));
        const res = await runObjective(state, objective, b.dir, [], { ...hooksForRun(), skipMemory: true });
        say((res.aborted ? yellow('  ■ Stopped') : green('  ⚡ Boost task done')) + dim(` in ${b.branch}`));
        boost.commitBoost(b.dir, 'boost: ' + objective.slice(0, 80));
        const d = boost.boostDiff(b.dir);
        if (d.files.length) {
          say(T.muted('  ── boost changes ──'));
          for (const f of d.files) say('  ' + T.path(f));
          const a = await ask(`   [y] merge into ${boost.currentBranch(process.cwd())} · [n] keep worktree: `);
          if (/^y/i.test(a.trim())) {
            const m = boost.mergeBoost(process.cwd(), b.branch);
            if (m.ok) { say(green('Merged into your branch.')); boost.cleanupBoost(process.cwd(), b.dir, b.branch); lastBoost = null; }
            else { say(red('Merge conflict, worktree kept: ' + m.out)); }
          } else {
            say(dim('Worktree kept: ' + b.dir + ' (' + b.branch + '). /boost cancel removes it.'));
          }
        } else {
          say(dim('No file changes came out of the boost run.'));
          boost.cleanupBoost(process.cwd(), b.dir, b.branch);
          lastBoost = null;
        }
      } catch (err) {
        say(red('  ✗ boost failed: ' + err.message));
      } finally {
        stopWork();
        busy = false;
        await afterTask();
      }
      return;
    }
    if (input === '/skills' || input.startsWith('/skills ')) {
      const kw = devKeyword();
      const arg = input.slice(7).trim();
      // the keyword may ride along ("/skills take me to jungle", "/skills sqli take me to jungle"):
      // strip it so the remainder is the actual skill name to look up
      const argClean = kw ? arg.split(kw).join('').trim() : arg;
      if (argClean) {
        const s = findSkill(argClean, process.cwd(), input);
        if (s) {
          say(T.muted(`  ── skill ${s.name} ──`) + T.muted(` (${s.scope}${s.gated ? ', gated' : ''})`));
          say('  ' + T.text(s.description));
          say('');
          say(T.muted('  instructions:'));
          for (const l of s.instructions.slice(0, 1_500).split('\n').slice(0, 40)) say('  ' + T.text(l));
          say(T.muted('Say "use ' + s.name + ' to ..." and the agent follows them.'));
          if (s.gated) say(T.warning('  ⚠ use responsibly: only on targets you are authorized to test.'));
        }
        else say(red(`No skill named ${argClean}.`));
        return;
      }
      // listing unlocks the same way a task does: the objective must contain the
      // keyword (custom or the built-in jungle phrase). A custom unlock shows
      // them even when the input carries nothing special
      const objective = (input.includes(kw) || input.includes(DEFAULT_KEYWORD))
        ? input
        : (kw !== DEFAULT_KEYWORD ? kw : input);
      const all = listSkills(process.cwd(), objective);
      const gated = all.filter(x => x.gated).length;
      say(all.length ? all.map(s => `  ${cyan(s.name)} ${dim('(' + s.scope + ')')} ${s.description}`).join('\n') : yellow('No skills installed.'));
      if (gated > 0) {
        say(dim(`  (+${gated} gated security skills aktif)`));
        say(T.warning('  ⚠ use responsibly: only on systems you are authorized to test.'));
      } else {
        say(dim(`  security skills are missing or locked. Run ${bold('ineed skills-sync')} to download them from the repo, then activate them in a task with ${bold('"take me to jungle"')}`));
      }
      return;
    }
    if (input === '/new') {
      let code = null;
      if (history.length) {
        try { code = saveSession({ id: sessionId, cwd: process.cwd(), model: state.model, history }); } catch {}
      }
      history = [];
      sessionId = null;
      say(code
        ? green('New session started.') + dim(` The old one is saved as ${code}. /resume ${code} brings it back.`)
        : green('New session started.'));
      if (TUI) { chatLines.length = 0; redrawChat(); drawStatus(); }
      return;
    }
    if (input === '/resume' || input.startsWith('/resume ')) {
      const codeArg = input === '/resume' ? '' : input.slice(8).trim();
      busy = true;
      const list = listSessions();
      if (!list.length) { say(yellow('No saved sessions yet.')); busy = false; return afterTask(); }
      if (codeArg) {
        const s = loadSession(codeArg);
        if (s?.history?.length) {
          history = s.history;
          sessionId = s.id;
          renderHistory(s.history);
          say(green(`Resumed ${s.id} (${Math.floor(s.history.length / 2)} turns). Continue where we left off.`));
        } else say(red(`No session with code ${codeArg}. Check /resume for the list of codes.`));
        busy = false;
        return afterTask();
      }
      let pick = '';
      if (TUI) {
        // arrow-key selection; typing anything falls back to the code prompt
        const labels = list.slice(0, 8).map(s =>
          `${s.id}  ${Math.floor((s.history?.length ?? 0) / 2)} turns  ` +
          trunc(String(s.history?.find(m => m.role === 'user')?.content ?? '').replaceAll('\n', ' '), 46));
        const idx = await pickFromList(labels);
        if (idx === null) { busy = false; return afterTask(); }   // Esc cancels
        pick = list[idx].id;
      } else {
        list.slice(0, 8).forEach((s, i) => {
          const first = String(s.history?.find(m => m.role === 'user')?.content ?? '').replaceAll('\n', ' ').slice(0, 70);
          say(`   ${s.id}  ·  ${Math.floor((s.history?.length ?? 0) / 2)} turns  ·  ${first}`);
        });
        pick = await ask('   Resume which? (code, e.g. 1425-0609, empty = newest): ');
      }
      const s = pick ? loadSession(pick.trim()) : list[0];
      if (s?.history?.length) {
        history = s.history;
        sessionId = s.id;
        renderHistory(s.history);
        say(green(`Resumed ${s.id} (${Math.floor(s.history.length / 2)} turns). Continue where we left off.`));
        if (TUI) redrawChat();
      } else say(red(`No session with code ${pick}. Check the list above.`));
      busy = false;
      return afterTask();
    }
    if (input === '/mcp' || input === '/mcp reload') {
      if (!mcpConfigured()) {
        say(yellow('No MCP servers configured.') + dim(' Add them to ~/.ineedcodes/mcp.json, e.g.: {"context7":{"command":"npx","args":["-y","@upstash/context7-mcp"]}}'));
        return;
      }
      busy = true;
      try {
        const { McpManager } = await import('./mcp.js');
        const mgr = new McpManager();
        const errors = await mgr.loadFromConfig();
        for (const e of errors) say(red('  ✗ ' + e));
        const tools = await mgr.allTools();
        if (tools.length) {
          say(green(`  ${mgr.servers.size} MCP server(s), ${tools.length} tool(s):`));
          for (const t of tools) say('  ' + cyan(t.name) + gray(' ' + trunc(t.description, 90)));
        } else if (!errors.length) {
          say(yellow('  Servers connected but exposed no tools.'));
        }
        mgr.killAll();
      } catch (err) { say(red('  ✗ ' + err.message)); }
      busy = false;
      return afterTask();
    }
    if (input === '/setup') {
      // reconfigure the active provider (add or update it), keep the other
      // saved providers untouched
      busy = true;
      try {
        const prof = await wizard(ask, { fromCommand: true, save: false });
        const next = addProvider(state, state.provider || 'default', prof);
        if (!next) throw new Error('could not save the provider');
        Object.assign(state, normalize(next));
        mode = state.mode;
        setTheme(state.theme);
        say(green('Ready. ' + state.provider + ' -> ' + state.model));
        if (TUI) layout();
      } catch { busy = false; say(red('Setup aborted. Nothing changed.')); return afterTask(); }
      busy = false;
      return afterTask();
    }
    if (input === '/reset') {
      clearConfig();
      say(dim('Config cleared. Running setup...'));
      busy = true;
      try {
        const c = await wizard(ask, { fromCommand: true });
        Object.assign(state, normalize(c));
        mode = state.mode;
        setTheme(state.theme);
        say(green('Ready. ' + state.model));
        if (TUI) layout();
      } catch { return doExit(); }
      busy = false;
      return afterTask();
    }
    if (input === '/init') {
      // explicit user command: scan this folder and write AGENTS.md. Pure
      // filesystem work, so it runs even without a reachable provider; it is
      // the user's own action, so plan mode (which restricts the agent) allows it.
      busy = true;
      try {
        const r = runInit(process.cwd());
        say(green(r.updated ? '  AGENTS.md updated.' : '  AGENTS.md created.')
          + dim(`  scanned ${r.scanned} file${r.scanned === 1 ? '' : 's'} -> ${shortPath(r.wrote)}`));
        if (TUI) drawStatus();
      } catch (err) { say(red('  ✗ ' + err.message)); }
      busy = false;
      return afterTask();
    }
    // beginner shortcut: the common words work without the slash, so nobody has
    // to memorize /provider or /model before their first task
    const shortcut = shortcutCommand(input);
    if (shortcut) return handle(shortcut);
    return runTask(input);
  }

  // exact single words (plus one argument for provider/model) map to commands;
  // anything longer stays a real task, because "plan my week" is not a command
  function shortcutCommand(text) {
    const parts = String(text).trim().split(/\s+/);
    const word = parts[0].toLowerCase();
    const rest = parts.slice(1).join(' ');
    const one = {
      help: '/help', '?': '/help', help2: '/help',
      status: '/status', model: '/model', provider: '/provider',
      memory: '/memory', humanizer: '/humanizer', perm: '/perm', permission: '/perm', izin: '/perm',
      plan: '/plan', build: '/build', depth: '/depth', reason: '/reason',
      theme: '/theme', skills: '/skills', init: '/init', compact: '/compact',
      new: '/new', clear: '/clear', reset: '/reset', setup: '/setup',
      exit: '/exit', quit: '/exit', stop: '/stop', mcp: '/mcp', boost: '/boost'
    };
    if (one[word] && !rest) return one[word];
    if ((word === 'provider' || word === 'model') && rest) return '/' + word + ' ' + rest;
    return null;
  }

  const plainPrompt = () => {
    if (closed || rlClosed) return;   // a closed readline cannot take a prompt
    const branch = currentBranch(process.cwd());
    const tok = usage.input || usage.output ? ` ${usage.output >= 1000 ? (usage.output / 1000).toFixed(1) + 'k' : usage.output} tok` : '';
    rl.setPrompt(`\n[${mode}/${state.reasoning}] ${bold(green('ineed'))}${branch ? ' ' + gray('(' + branch + ')') : ''}${tok} ${green('❯')} `);
    rl.prompt();
  };

  const printWelcome = () => {
    const lines = fresh
      ? [
          green(bold('Welcome to ineed!')),
          '  You are all set: any OpenAI-compatible provider, any folder.',
          '  Type what you want in normal language, for example:',
          dim('    "create an animated landing page in this folder"'),
          dim('    "fix the failing tests and tell me what was wrong"'),
          dim('    "explain this repository like I am a beginner"'),
          '  ' + dim('Helpers: /help commands · /perm auto or safe · /model · /memory on|off')
        ]
      : [
          dim('Type what you want. /help for commands.')
            + (state.permEdit === 'ask' || state.permShell === 'ask' ? dim(' Edits and shell ask first: /perm auto to relax.') : '')
        ];
    for (const l of lines) say(l);
  };

  // ── plain REPL mode (pipes, tests, NO_COLOR) ──
  if (!TUI) {
    rl.on('SIGINT', () => {
      if (activeRun) { activeRun.abort(); console.log(dim('\nStopping...')); return; }
      const now = Date.now();
      if (now - lastSigint < 3000) return doExit();
      lastSigint = now;
      console.log(dim('\n(Ctrl+C again to exit)'));
      rl.prompt();
    });
    handleRef = handle;
    pumpHeld();
    // big ANSI-shadow logo wraps on narrow terminals (Windows default 120 is fine,
    // but small windows and split panes are not): fall back to the one-line banner
    const cols = process.stdout.columns || 80;
    if (cols >= 47) console.log(logo());
    else console.log(green(bold('ineed')) + dim(` v${VERSION}`));
    // keep the info tail short so the banner never wraps into a broken layout
    console.log(BANNER() + dim(trunc(` · ${state.model} · ${process.cwd()}`, Math.max(10, cols - 48))));
    if (process.platform === 'win32' && !windowsAnsi && state.tui !== false) {
      console.log(dim('  tip: for the full-screen UI open this folder in Windows Terminal, or set "tui": true in ~/.ineedcodes/config.json'));
    }
    printWelcome();
    plainPrompt();
    return;
  }

  let chatTop = 1, chatBot = 0;   // scroll region rows (conversation viewport)
  let statusRow = 0;              // bottom bar: model / reasoning / working dir
  let composerTop = 0;            // top row of the composer panel
  let composerRows = 5;           // top pad + text rows + bottom pad
  let workRow = 0;                // live working-status row (just above composer)
  let viewStart = 0;              // absolute top line of the viewport while scrolled back
  let followTail = true;

  // ── slash command menu: filters while you type / ──
  const SLASH_COMMANDS = [
    { cmd: '/model', desc: 'pick a model from your provider' },
    { cmd: '/provider', desc: 'list, switch, add or remove API providers' },
    { cmd: '/plan', desc: 'plan mode: read only' },
    { cmd: '/build', desc: 'build mode: real changes (default)' },
    { cmd: '/reason', desc: 'toggle reasoning low/high' },
    { cmd: '/perm', desc: 'permissions: /perm auto | /perm safe' },
    { cmd: '/boost', desc: 'isolated git-worktree run: /boost <objective>' },
    { cmd: '/config', desc: 'show and change settings' },
    { cmd: '/memory', desc: 'memory status, /memory on|off' },
    { cmd: '/mcp', desc: 'list MCP servers and tools' },
    { cmd: '/skills', desc: 'list installed skills' },
    { cmd: '/init', desc: 'scan this folder and write AGENTS.md' },
    { cmd: '/humanizer', desc: 'natural-writing pass on/off' },
    { cmd: '/status', desc: 'session overview' },
    { cmd: '/compact', desc: 'shrink conversation into a checkpoint' },
    { cmd: '/depth', desc: 'answer depth: short|normal|deep' },
    { cmd: '/theme', desc: 'pick a color theme: dark, light, mono, nord, dracula, synthwave' },
    { cmd: '/resume', desc: 'resume a saved session' },
    { cmd: '/new', desc: 'start a fresh session' },
    { cmd: '/clear', desc: 'forget this conversation' },
    { cmd: '/setup', desc: 'redo provider setup' },
    { cmd: '/help', desc: 'all commands' },
    { cmd: '/exit', desc: 'quit' }
  ];
  let menuOpen = false;
  let menuItems = [];
  let menuSelected = 0;
  let menuDrawnRows = 0;

  // first row a floating list/menu may occupy: while the working line is up it
  // must stay visible, so floats anchor above it
  const composerAnchor = () => (working ? composerTop - 1 : composerTop);

  // lowest row the conversation may paint: keeps the working line and any open
  // floating menu clear of streaming output
  const chatFloor = () => {
    const base = composerAnchor() - 1;
    const lift = menuOpen
      ? Math.min(menuItems.length, Math.max(3, composerAnchor() - chatTop - 1))
      : pickerActive
        ? Math.min(pickerItems.length, Math.max(3, composerAnchor() - chatTop - 1))
        : 0;
    return Math.max(chatTop, base - lift);
  };

  function drawMenu() {
    menuDrawnRows = 0;
    if (!menuOpen || !menuItems.length) return;
    const anchor = composerAnchor();        // menu floats just above the composer
    const maxShow = Math.min(menuItems.length, Math.max(3, anchor - chatTop - 1));
    if (anchor - maxShow < 1) return;       // terminal too small for a float
    const start = Math.max(0, Math.min(menuSelected - Math.floor(maxShow / 2), menuItems.length - maxShow));
    const w = Math.min(process.stdout.columns || 80, 64);
    let buf = '';
    for (let i = 0; i < maxShow; i++) {
      const item = menuItems[start + i];
      const sel = start + i === menuSelected;
      const label = (sel ? T.accent('› ') : '  ') + T.accent(item.cmd) + ' ' + T.muted(trunc(item.desc, w - 24));
      buf += `\x1b[${anchor - maxShow + i};1H\x1b[2K` + label;
    }
    menuDrawnRows = maxShow;
    process.stdout.write(buf);
  }

  function clearMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menuItems = [];
    menuSelected = 0;
    menuDrawnRows = 0;
    chatBot = chatFloor(); // give the chat its rows back, repaint the menu zone
    redrawChat();
    drawInputBox();
    scrollRegion();
  }

  function updateMenu(typed) {
    const q = typed.toLowerCase();
    const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(q) || c.desc.toLowerCase().includes(q));
    if (typed.startsWith('/') && matches.length && matches[0].cmd !== typed) {
      menuOpen = true;
      menuItems = matches;
      menuSelected = 0;
      // lift the chat floor so streaming output can't repaint over the floating menu
      if (menuDrawnRows) redrawChat(); // wipe rows left over from a taller menu
      chatBot = chatFloor();
      drawMenu();
      scrollRegion();
    } else if (menuOpen) {
      clearMenu();
    }
  }

  // live status while a task runs: `• Working (27s · esc to interrupt)`.
  // One compact line between the conversation and the composer; no spinner panel.
  function drawWorking() {
    if (!working || !workRow) return;
    const cols = process.stdout.columns || 80;
    const secs = Math.max(0, Math.floor((Date.now() - runStartedAt) / 1000));
    const bullet = spinnerFrame ?? '•';
    const line = ' ' + T.tool(bullet) + ' ' + T.text(spinnerText ?? 'Working')
      + ' ' + T.muted(`(${secs}s · `) + T.muted('esc to interrupt') + T.muted(')');
    screen.at(workRow, 1);
    screen.clearLine();
    // pad to the full width so the previous frame can never peek through
    process.stdout.write(ansiPad(ansiTrunc(line, cols - 1), cols - 1));
  }

  function startWork(label) {
    if (!TUI) return;
    if (!runStartedAt) runStartedAt = Date.now();   // elapsed belongs to the task
    const wasWorking = working;
    working = true;
    spinnerText = label || 'Working';
    if (workTick) clearInterval(workTick);
    const frames = ['·', '•'];
    let i = 0;
    spinnerFrame = frames[0];
    drawWorking();
    workTick = setInterval(() => {
      spinnerFrame = frames[++i % frames.length];
      drawWorking();
    }, 500);
    // first line-up only: pull the chat floor up so the working row can never
    // overwrite the newest conversation line (bug: history got painted over)
    if (!wasWorking) layout({ clear: false });
  }

  function stopWork() {
    if (workTick) { clearInterval(workTick); workTick = null; }
    spinnerFrame = null;
    spinnerText = null;
    if (working) {
      working = false;
      if (workRow) { screen.at(workRow, 1); screen.clearLine(); }
      // hand the row back to the conversation and repaint it from chatLines
      layout({ clear: false });
    }
  }

  // Composer: one wide flat panel. A thin accent rail on the left, a small `>`
  // prompt marker, input blended straight onto a subtle panel background.
  // No top/right/bottom border, no nested input box, no rounded corners, no pill.
  function drawInputBox() {
    if (!composerTop) return;
    const cols = process.stdout.columns || 80;
    // a staged paste wins the box in both states: it is the next message
    const text = stagedPaste || (busy ? typedAhead : (rl.line ?? ''));
    const width = Math.max(10, cols - 7);          // rail + 2 pad + '> ' + cursor margin
    const want = composerRowsFor(text, width, cols);
    if (want !== composerRows) { composerRows = want; layout({ clear: false }); return; }
    const textRows = composerRows - 2;
    const lines = wrapPlain(text, width).slice(-textRows);
    let buf = '';
    const row = (r, content) => {
      // one flat surface: panel background spans the full row, content on top
      const vis = visLen(content);
      buf += `\x1b[${r};1H\x1b[2K` + bgOn('panel') + content + ' '.repeat(Math.max(0, cols - 1 - vis)) + resetOff();
    };
    const rail = working ? fgOn('divider') + '│' + fgOff() : fgOn('focus') + '│' + fgOff();
    row(composerTop, rail);                                        // top pad
    for (let i = 0; i < textRows; i++) {
      const r = composerTop + 1 + i;
      const line = lines[i];
      if (line === undefined) { row(r, rail); continue; }
      const marker = i === 0 ? fgOn('accent') + '>' + fgOff() + ' ' : '  ';
      const body = (i === 0 && !text) ? fgOn('muted') + 'Ask iNeedCodes to do anything' + fgOff() : line;
      row(r, rail + '  ' + marker + body);
    }
    row(composerTop + 1 + textRows, rail);                         // bottom pad
    process.stdout.write(buf);
  }

  function composerRowsFor(text, width, cols) {
    const rows = process.stdout.rows || 24;
    const maxRows = Math.max(3, rows - 3);          // keep chat + status bar visible
    const need = Math.max(3, Math.min(12, wrapPlain(text, width).length));
    return Math.min(need + 2, maxRows);
  }

  // Bottom status: active model, reasoning level, working directory. Real values
  // only; the path is the live cwd with a `~` shorthand inside the home dir.
  function drawStatus() {
    if (!TUI || !statusRow) return;
    const cols = process.stdout.columns || 80;
    let model = trunc(modelTail(state.model), 40);
    const items = ['  ' + T.model(model)];
    if (mode === 'plan') items.push(T.warning('plan'));
    items.push(T.muted(state.reasoning));
    let base = items.join(T.muted('   ')) + T.muted('   ');
    // a very wide terminal can still be beaten by a huge model id: shrink it first
    if (visLen(base) > cols - 10) {
      model = truncMid(model, Math.max(8, cols - 10 - (visLen(base) - visLen(model))));
      base = '  ' + T.model(model) + (mode === 'plan' ? T.muted('   ') + T.warning('plan') : '') + T.muted('   ') + T.muted(state.reasoning) + T.muted('   ');
    }
    const room = Math.max(8, cols - visLen(base) - 1);
    let cwd = shortPath(process.cwd());
    if (visLen(cwd) > room) cwd = truncMid(cwd, room);
    screen.at(statusRow, 1);
    screen.clearLine();
    process.stdout.write(base + T.path(cwd));
  }

  function scrollRegion() {
    screen.region(chatTop, chatBot);
    screen.at(chatBot, 1);
  }

  function redrawChat() {
    // build the whole frame in one buffer, then paint once: no flicker.
    // viewStart is an absolute anchor: while scrolled back, new output must not
    // slide the lines the user is reading.
    const vis = chatBot - chatTop + 1;
    if (followTail || viewStart >= chatLines.length - vis) { followTail = true; viewStart = 0; }
    const show = followTail ? chatLines.slice(-vis) : chatLines.slice(viewStart, viewStart + vis);
    let buf = '';
    for (let i = 0; i < vis; i++) {
      buf += `\x1b[${chatTop + i};1H\x1b[2K` + (show[i] ?? '');
    }
    if (!followTail) {
      const back = Math.max(0, chatLines.length - (viewStart + vis));
      const pos = ` ${back} lines back · mouse down to return `;
      buf += `\x1b[${chatTop};${Math.max(1, (process.stdout.columns || 80) - visLen(pos) - 2)}H` + yellow(pos);
    }
    process.stdout.write(buf);
    scrollRegion();
  }

  const SCROLL_STEP = 3; // lines per wheel tick: fine-grained, recent lines stay visible

  function scrollUp(lines = SCROLL_STEP) {
    const vis = chatBot - chatTop + 1;
    if (chatLines.length <= vis) return; // everything already fits
    if (followTail) { viewStart = Math.max(0, chatLines.length - vis - lines); followTail = false; }
    else viewStart = Math.max(0, viewStart - lines);
    redrawChat();
    drawInputBox();
  }

  function scrollDown(lines = SCROLL_STEP) {
    const vis = chatBot - chatTop + 1;
    if (followTail) return;
    viewStart = Math.min(Math.max(0, chatLines.length - vis), viewStart + lines);
    if (viewStart >= chatLines.length - vis) { followTail = true; viewStart = 0; }
    redrawChat();
    drawInputBox();
  }

  // a page at a time for PageUp/PageDown
  const pageStep = () => Math.max(3, (chatBot - chatTop + 1) >> 1);

  function tuiPrint(text) {
    for (const l of wrapLines(String(text), Math.max(10, (process.stdout.columns || 80) - 4))) chatLines.push(l);
    redrawChat();
  }

  function renderHistory(h) {
    if (!TUI) {
      for (const m of h) {
        const c = String(m.content ?? '').replaceAll('\n', ' ').slice(0, 90);
        if (c) console.log('  ' + gray((m.role === 'user' ? 'you: ' : 'ineed: ') + c));
      }
      return;
    }
    if (!tuiReady) return;
    setTimeout(() => {
      for (const m of h) {
        if (m.role === 'user') tuiUserLine(String(m.content ?? ''));
        else if (m.content) tuiPrint(T.muted('  (earlier) ') + T.muted(trunc(String(m.content).replaceAll('\n', ' '), 90)));
      }
      drawStatus();
      scrollRegion();
    }, 0);
  }

  function tuiUserLine(input) {
    for (const l of wrapLines(userBlock(input), Math.max(10, (process.stdout.columns || 80) - 4))) chatLines.push(l);
    redrawChat();
  }

  // ── arrow-key list picker (TUI): a floating list above the composer, like the slash menu ──
  // Returns the index of the picked item, or null when cancelled/answered by typing.
  let pickerActive = false;
  let pickerItems = [];
  let pickerSelected = 0;
  let pickerRows = 0;
  let pickerResolver = null;

  function drawPicker() {
    if (!pickerActive || !pickerItems.length) return;
    const cols = process.stdout.columns || 80;
    const anchor = composerAnchor();
    const maxShow = Math.min(pickerItems.length, Math.max(3, anchor - chatTop - 1));
    if (anchor - maxShow < 1) return;       // terminal too small for a float
    const start = Math.max(0, Math.min(pickerSelected - Math.floor(maxShow / 2), pickerItems.length - maxShow));
    let buf = '';
    for (let i = 0; i < maxShow; i++) {
      const item = pickerItems[start + i];
      const sel = start + i === pickerSelected;
      const label = (sel ? T.accent('› ') : '  ') + T.command(item);
      buf += `\x1b[${anchor - maxShow + i};1H\x1b[2K` + ansiTrunc(label, cols - 1);
    }
    pickerRows = maxShow;
    process.stdout.write(buf);
  }

  function closePicker(restoreChat = true) {
    if (!pickerActive) return;
    pickerActive = false;
    const rowsWiped = pickerRows;
    pickerItems = []; pickerSelected = 0; pickerRows = 0;
    if (restoreChat) { chatBot = chatFloor(); redrawChat(); drawInputBox(); scrollRegion(); }
    else if (rowsWiped) { /* zone repaint happens on next redraw */ }
  }

  function pickFromList(items) {
    return new Promise(resolve => {
      pickerActive = true;
      pickerItems = items;
      pickerSelected = 0;
      pickerResolver = resolve;
      // lift the chat floor so streaming/approval output cannot paint over the list
      chatBot = chatFloor();
      scrollRegion();
      drawPicker();
    });
  }

  // Geometry: conversation viewport on top, live working line, flat composer,
  // bottom status bar. Everything recomputes on resize; the composer can grow
  // with multiline input and the viewport shrinks to make room.
  const layout = (opts = {}) => {
    const rows = process.stdout.rows || 24;
    statusRow = rows;
    composerRows = composerRowsFor(busy ? typedAhead : (rl.line ?? ''), Math.max(10, (process.stdout.columns || 80) - 7), (process.stdout.columns || 80));
    // composer spans composerRows rows and must end one above the status bar
    composerTop = Math.max(chatTop + 2, statusRow - composerRows);
    workRow = composerTop - 1;                 // live working line above the composer
    chatTop = 1;                               // full-height conversation, no header
    chatBot = chatFloor();
    if (opts.clear) { screen.at(1, 1); process.stdout.write('\x1b[2J'); }
    redrawChat();
    if (menuOpen) drawMenu();
    if (pickerActive) drawPicker();
    drawWorking();
    drawInputBox();
    drawStatus();
    scrollRegion();
  };

  rl.on('resize', () => layout({ clear: true }));

  // typed-ahead input while busy: echo it inside the input box; slash menu when typing /
  let typedAhead = '';
  let wheelBuf = null;
  // ── bracketed paste (the opencode way) ──
  // The terminal wraps pasted text in ESC[200~ ... ESC[201~. We catch the whole
  // burst atomically so readline never sees it as a run of typed lines, then
  // stage it in the composer as one multi-line block. Enter submits it whole;
  // nothing auto-runs on paste. Terminals without the markers still get the
  // debounce coalescer in dispatchLine as a fallback.
  let stagedPaste = '';        // full pasted block waiting for Enter
  let pasteCapture = null;     // non-null while a paste burst is in flight
  let pasteGuard = null;       // flush a paste whose end marker never arrived
  const finishPaste = () => {
    if (pasteGuard) { clearTimeout(pasteGuard); pasteGuard = null; }
    if (!pasteCapture) return;
    const raw = pasteCapture.text;
    pasteCapture = null;
    const clean = String(raw)
      .replace(/\r\n?/g, '\n')                          // normalize newlines
      .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')     // stray CSI sequences
      .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')         // control chars, keep \n
      .replace(/^\n+|\n+$/g, '');
    if (!clean) { drawInputBox(); return; }
    if (askPending) {
      // a raw prompt (approval, /model, /resume...) owns the line: fill it as
      // one line; Enter still submits, nothing runs on paste
      origWrite(clean.replace(/\n+/g, ' '));
      return;
    }
    stagedPaste = clean;
    drawInputBox();
    updateMenu(stagedPaste);
    scrollRegion();
  };
  // keypress events are emitted on the INPUT stream, not the readline interface.
  // readline also listens there and copies printable keys into its line buffer,
  // so SGR mouse fragments (digits, final M/m) leak into the prompt as stray
  // numbers while scrolling. We take over the routing: mouse bytes are decoded
  // here and never reach readline; every other key is forwarded unchanged.
  const readlineKeypress = process.stdin.listeners('keypress');
  process.stdin.removeAllListeners('keypress');
  // a real terminal sends \r for Enter ("return"); a pipe or a script harness
  // sends \n ("enter"). Both must submit, or pasted blocks cannot be sent.
  const ENTER = key => key?.name === 'return' || key?.name === 'enter';
  process.stdin.on('keypress', (ch, key) => {
    if (!key) return;
    const forward = () => { for (const fn of readlineKeypress) fn.call(process.stdin, ch, key); };
    // paste markers first: they must not reach the mouse decoder or readline
    if (key.sequence === '\x1b[200~') {
      pasteCapture = { text: '' };
      pasteGuard = setTimeout(finishPaste, 3000);   // end marker lost: flush anyway
      return;
    }
    if (key.sequence === '\x1b[201~') { finishPaste(); return; }
    if (pasteCapture) {
      // swallow the whole burst: accumulate raw text, feed nothing to readline
      pasteCapture.text += ENTER(key) ? '\n' : (key.sequence ?? ch ?? '');
      return;
    }
    // SGR mouse arrives in pieces: ESC[< then digits/; then final M/m
    if (key.sequence === '\x1b[<') { wheelBuf = ''; return; }
    if (wheelBuf !== null) {
      const cstr = String(ch);
      if (/^[0-9;]+$/.test(cstr)) { wheelBuf += cstr; return; }
      if (cstr === 'M' || cstr === 'm') {
        const btn = Number(wheelBuf.split(';')[0]);
        if (btn === 64) scrollUp();
        else if (btn === 65) scrollDown();
        wheelBuf = null;
        return;
      }
      // not a mouse continuation: recover instead of swallowing every keypress
      wheelBuf = null;
      // fall through to normal key handling
    }
    // keyboard scrollback: PageUp/PageDown, shift+arrows.
    // Old conversation stays readable while a task streams below.
    if (key.name === 'pageup' || (key.shift && key.name === 'up')) { scrollUp(pageStep()); return; }
    if (key.name === 'pagedown' || (key.shift && key.name === 'down')) { scrollDown(pageStep()); return; }
    if (pickerActive) {
      // the list selector owns up/down/enter/esc; everything else goes to readline
      if (key.name === 'up') { pickerSelected = Math.max(0, pickerSelected - 1); drawPicker(); return; }
      if (key.name === 'down') { pickerSelected = Math.min(pickerItems.length - 1, pickerSelected + 1); drawPicker(); return; }
      if (key.name === 'return') {
        const picked = pickerSelected;
        const r = pickerResolver; pickerResolver = null;
        closePicker();
        r?.(picked);
        return;
      }
      if (key.name === 'escape') {
        const r = pickerResolver; pickerResolver = null;
        closePicker();
        r?.(null);
        return;
      }
      // any other key: cancel the picker so the user can type an id by hand
      const r = pickerResolver; pickerResolver = null;
      closePicker();
      r?.(null);
      forward();
      return;
    }
    if (menuOpen && key.name === 'up') { menuSelected = Math.max(0, menuSelected - 1); drawMenu(); return; }
    if (menuOpen && key.name === 'down') { menuSelected = Math.min(menuItems.length - 1, menuSelected + 1); drawMenu(); return; }
    if (menuOpen && key.name === 'tab' && menuItems[menuSelected]) {
      // pick BEFORE clearing: clearMenu resets the list, so read the item first
      const picked = menuItems[menuSelected].cmd;
      menuOpen = false; menuItems = []; menuSelected = 0; menuDrawnRows = 0;
      chatBot = chatFloor(); // lift the menu zone back, wipe leftover menu rows
      redrawChat();
      // replace whatever partial is typed: the picked command takes its place,
      // in the real readline buffer so Enter submits exactly what is shown
      if (stagedPaste) {
        stagedPaste = picked;
        drawInputBox();
        updateMenu(picked);
        return;
      }
      if (!busy) {
        rl.write(null, { name: 'u', ctrl: true });   // clear the line, then fill it
        rl.write(picked);
      } else {
        rl.write(null, { name: 'u', ctrl: true });
        rl.write(picked);
        typedAhead = picked;
      }
      drawInputBox();
      return;
    }
    // Esc: drops a staged paste when one is open, closes an open menu when idle,
    // interrupts the running task when busy
    if (key.name === 'escape' && !key.ctrl && !key.meta) {
      if (busy && activeRun) { activeRun.abort(); tuiPrint(T.muted('  (stopping...')); return; }
      if (stagedPaste) { stagedPaste = ''; drawInputBox(); updateMenu(''); return; }
      if (menuOpen) { clearMenu(); return; }
      return; // swallow, do not insert anything into the input
    }
    if (!busy) {
      // a staged paste waits in the composer: Enter submits it whole, editing
      // keys work on the block, everything else is appended to it
      if (stagedPaste) {
        if (ENTER(key)) {
          const text = stagedPaste;
          stagedPaste = '';
          if (menuOpen) clearMenu();
          drawInputBox();
          void handleRef?.(text);   // one input, one task
          return;
        }
        if (key.ctrl && key.name === 'u') { stagedPaste = ''; drawInputBox(); updateMenu(''); return; }
        if (key.name === 'backspace') { stagedPaste = stagedPaste.slice(0, -1); drawInputBox(); updateMenu(stagedPaste); return; }
        if (key.ctrl || !ch || ch < ' ') { forward(); return; }
        stagedPaste += ch;
        drawInputBox();
        updateMenu(stagedPaste);
        return;
      }
      // idle: readline owns the input; just update the box text and menu from rl.line
      if (ENTER(key)) { typedAhead = ''; if (menuOpen) clearMenu(); }
      forward();
      setImmediate(() => { drawInputBox(); updateMenu(rl.line ?? ''); });
      return;
    }
    // busy: a staged paste is the queued message; Enter submits it whole
    if (stagedPaste) {
      if (ENTER(key)) {
        const text = stagedPaste;
        stagedPaste = '';
        if (menuOpen) clearMenu();
        drawInputBox();
        void handleRef?.(text);
        return;
      }
      if (key.ctrl && key.name === 'u') { stagedPaste = ''; drawInputBox(); updateMenu(''); return; }
      if (key.name === 'backspace') { stagedPaste = stagedPaste.slice(0, -1); drawInputBox(); updateMenu(stagedPaste); scrollRegion(); return; }
      if (key.ctrl || !ch || ch < ' ') { forward(); return; }
      stagedPaste += ch;
      drawInputBox();
      updateMenu(stagedPaste);
      scrollRegion();
      return;
    }
    if (key.name === 'backspace') typedAhead = typedAhead.slice(0, -1);
    else if (ENTER(key)) { typedAhead = ''; if (menuOpen) clearMenu(); }
    else if (key.ctrl || !ch || ch < ' ') { forward(); return; }
    else typedAhead += ch;
    drawInputBox();
    updateMenu(typedAhead);
    scrollRegion();
    forward();
  });

  // keep Ctrl+Z from suspending us in raw mode: swallow the key, tell the user
  const origWrite = rl.write.bind(rl);
  rl.write = (d, key) => {
    if (key && key.ctrl && key.name === 'z') { tuiPrint(dim('  (Ctrl+Z is disabled here. Use /exit, or Ctrl+C twice.)')); return; }
    return origWrite(d, key);
  };

  rl.on('SIGINT', () => {
    if (activeRun) { activeRun.abort(); return; }
    const now = Date.now();
    if (now - lastSigint < 3000) return doExit();
    lastSigint = now;
    // same affordance as the plain REPL: tell the user how to actually quit
    tuiPrint(T.muted('  (Ctrl+C again to exit)'));
  });

  handleRef = handle;
  pumpHeld();

  screen.enter();
  // SIGTERM, uncaught exceptions and normal exit all have to give the terminal back
  const restoreTerminal = () => { try { screen.resetRegion(); screen.exit(); } catch {} };
  for (const sig of ['SIGTERM', 'SIGHUP', 'uncaughtException']) {
    process.on(sig, err => {
      restoreTerminal();
      if (sig === 'uncaughtException') {
        console.error(red('  ✗ ' + (err?.message ?? err)));
        process.exit(1);
      }
      process.exit(0);
    });
  }
  screen.mouse(true);
  layout({ clear: true });
  // first-open brand block: the ANSI-shadow logo leads the conversation once,
  // then scrolls away naturally. Falls back to the one-liner on narrow terms.
  const bootCols = process.stdout.columns || 80;
  if (bootCols >= 47) for (const l of logo().split('\n')) chatLines.push(l);
  else chatLines.push(green(bold('ineed')));
  chatLines.push(BANNER() + dim(trunc(` · ${state.model} · ${shortPath(process.cwd())}`, Math.max(10, bootCols - 48))));
  chatLines.push('');
  printWelcome();
  redrawChat();
  scrollRegion();
  tuiReady = true;   // history rendering and stream-reset hooks may paint from here
}
