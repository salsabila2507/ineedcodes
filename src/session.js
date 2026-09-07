// session.js: interactive chat TUI. Fixed logo header, scrolling chat area, fixed status + input footer.
// Falls back to a plain REPL (same commands) when stdout is not a TTY, so tests and pipes keep working.

import * as readline from 'node:readline';
import { clearConfig, normalize, saveConfig } from './config.js';
import { runObjective, pushTurn } from './agent.js';
import { fetchModels } from './provider.js';
import { makeInput, bold, dim, red, green, yellow, cyan, gray, trunc, BANNER, logo, box, startSpinner, VERSION, RULE, userBubble, screen } from './ui.js';
import { wizard } from './wizard.js';
import { getMemoryProvider, ICMAdapter } from './memory.js';
import { saveSession, listSessions, loadSession } from './sessions.js';
import * as boost from './boost.js';
import { spawnSync } from 'node:child_process';
import { mcpConfigured } from './mcp.js';
import { listSkills, findSkill, devKeyword } from './skills.js';

function currentBranch(cwd) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const plain = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

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
    while (plain(line).length > width) {
      let vis = 0, i = 0;
      while (i < line.length && vis < width) {
        if (line[i] === '\x1b') { while (i < line.length && line[i] !== 'm') i++; }
        else vis++;
        i++;
      }
      out.push(line.slice(0, i));
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
  // legacy Windows consoles garble alt-screen sequences. Auto: on everywhere except
  // win32, unless an ANSI-capable Windows terminal is detected: Windows Terminal
  // (WT_SESSION / WT_PROFILE_ID), ConEmu, VS Code terminal (TERM_PROGRAM=vscode)
  // or anything that sets TERM=xterm-*. Force with config "tui": true, disable
  // with "tui": false.
  const noColor = process.env.NO_COLOR && process.env.NO_COLOR !== '0';
  const windowsAnsi = !!(process.env.WT_SESSION || process.env.WT_PROFILE_ID
    || process.env.ConEmuANSI === 'ON'
    || process.env.TERM_PROGRAM === 'vscode'
    || /^xterm/.test(process.env.TERM || ''));
  const TUI = process.stdout.isTTY && !noColor
    && (state.tui === true || (state.tui === null && (process.platform !== 'win32' || windowsAnsi)));
  let sessionId = null;
  let lastBoost = null;
  let usage = { input: 0, output: 0 };
  var tuiReady = false;
  let boxSpinner = null;   // TUI spinner interval
  let spinnerText = null;
  let spinnerFrame = null;

  // ONE readline, ONE dispatcher. Mouse wheel sequences are decoded in the
  // keypress handler below (they arrive as keypress with key.sequence).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let handleRef = null;
  // Pastes land as a burst of lines and readline submits each one. Coalesce the
  // burst into a single input so a 20-line prompt runs as one task, not twenty.
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
      for (const line of lines) { const t = line.trim(); if (t) handleRef?.(t); }
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
  // Paste coalescing works on any real terminal (Windows consoles included).
  // Pipes and tests keep the exact line-by-line behavior.
  const ask = makeInput(rl, process.stdout.isTTY ? dispatchLine : (l => handleRef?.(l)), p => { askPending = p; });
  if (TUI) rl._writeToOutput = s => { if (askPending) process.stdout.write(s); };
  // EOF (Ctrl+D or closed pipe): exit cleanly, unless a task is still running
  rl.on('close', () => {
    if (!busy) doExit();
    else {
      const wait = setInterval(() => { if (!busy) { clearInterval(wait); doExit(); } }, 200);
      setTimeout(() => { clearInterval(wait); doExit(); }, 30_000);
    }
  });

  const say = TUI ? lines => tuiPrint(lines) : (lines => console.log(lines));

  function doExit() {
    closed = true;
    // save whatever happened and hand back the resume code
    let code = null;
    if (history.length) {
      try { code = saveSession({ id: sessionId, cwd: process.cwd(), model: state.model, history }); } catch {}
    }
    if (TUI) { screen.resetRegion(); screen.exit(); }
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
    }
    if (chosen === null) {
      const pick = await ask('   Model (number or full id, empty = keep current): ');
      if (!pick) return;
      const idx = Number(pick);
      chosen = Number.isInteger(idx) && idx >= 1 && idx <= list.length ? list[idx - 1] : pick;
    }
    Object.assign(state, normalize({ ...state, model: chosen }));
    try { saveConfig(state); } catch {}
    say(green('   Model: ' + state.model));
    if (TUI) drawStatus();
  }

  let lastStreamedForHooks = '';
  let streamFlushTimer = null;
  let streamFlushedCount = 0;
  let streamBaseLines = null;
  const chatLines = [];

  function flushStreamed() {
    if (!TUI || !lastStreamedForHooks) return;
    if (streamBaseLines === null) streamBaseLines = chatLines.length;
    chatLines.length = streamBaseLines; // re-render the growing answer in place
    for (const l of wrapLines(lastStreamedForHooks, Math.max(10, (process.stdout.columns || 80) - 4))) chatLines.push(l);
    redrawChat();
  }

  function hooksForRun(stopSpinner) {
    let spinner = null;
    const stop = () => {
      spinner?.stop(); spinner = null;
      if (boxSpinner) { clearInterval(boxSpinner); boxSpinner = null; }
    };
    // TUI spinner lives inside the input box (a ticking interval would smear the screen)
    const boxSpin = label => {
      if (!TUI) return startSpinner(label);
      if (boxSpinner) clearInterval(boxSpinner);
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let i = 0;
      spinnerText = label;
      spinnerFrame = frames[0];
      boxSpinner = setInterval(() => { spinnerFrame = frames[++i % frames.length]; drawInputBox(); }, 90);
      return { stop: () => { spinnerText = null; spinnerFrame = null; drawInputBox(); } };
    };
    return {
      spinnerStop: stop,
      onMemoryStart: () => { stop(); spinner = boxSpin('recalling memory'); },
      onMemoryEnd: () => stop(),
      onThinkingStart: () => { stop(); spinner = boxSpin('thinking'); },
      onThinkingEnd: () => stop(),
      onWorkStart: label => { stop(); spinner = boxSpin(label || 'working'); },
      onWorkEnd: () => stop(),
      onTool: (name, input2) => { stop(); say(cyan('  ● ' + name) + gray(' ' + trunc(JSON.stringify(input2), 90))); },
      onResult: out => { say(gray('    ' + trunc(out, 110))); },
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
        const mark = s => s === 'completed' ? green('✔') : s === 'in_progress' ? cyan('▸') : dim('○');
        say(box([bold('To-do'), ...list.map(t => '  ' + mark(t.status) + ' ' + t.content)]));
      },
      onAgentStart: (id, input) => { stop(); say(cyan('  ◆ spawn ' + id) + gray(` role=${input.role ?? '?'} task=${trunc(String(input.objective ?? ''), 70)}`)); },
      onAgentEnd: (id, r) => { stop(); say((r.status === 'completed' ? green('  ◆ ' + id + ' done') : yellow('  ◆ ' + id + ' ' + r.status)) + gray(' ' + trunc(String(r.summary ?? '').replaceAll('\n', ' '), 90))); },
      onMCP: names => { if (names.length) say(dim('  MCP tools available: ' + names.join(', '))); },
      onMCPResult: (name, out) => { say(gray('    mcp result: ' + trunc(out, 100))); },
        onNote: note => { stop(); if (note.includes('applying your steer')) { lastStreamedForHooks = ''; streamFlushedCount = 0; streamBaseLines = null; if (typeof tuiReady !== 'undefined' && tuiReady) { chatLines.length = 0; redrawChat(); } } say(dim('  ◇ ' + note)); },
        onUsage: u => { usage = u; if (TUI) drawStatus(); },
        drainSteer: () => steerQueue.splice(0),
      onSteer: list => { for (const s of list) say(yellow('  ↳ steer: ') + s); },
      onApprove: async (cat, name, input2) => {
        stop();
        say(yellow('  ⚠ approval needed') + ' ' + cyan(name) + gray(' ' + trunc(JSON.stringify(input2), 80)));
        const a = await ask('     [y] once · [a] this session · [s] always (save) · [n] no: ');
        const c = a.trim().toLowerCase();
        if (c === 's' || c === 'save') {
          approved.add(cat);
          if (cat === 'edit') Object.assign(state, normalize({ ...state, permEdit: 'allow' }));
          if (cat === 'shell') Object.assign(state, normalize({ ...state, permShell: 'allow' }));
          saveConfig(state);
          say(dim('     always allowed, saved to config. /perm safe to undo.'));
          return 'always';
        }
        if (c === 'a' || c === 'always') { approved.add(cat); say(dim('     always allowed for this session.')); return 'always'; }
        if (c === 'y' || c === 'yes') return true;
        say(dim('     denied.'));
        return false;
      },
      approved,
      onRunStart: c => { activeRun = c; },
      onRunEnd: () => { activeRun = null; stop(); }
    };
  }

  async function runTask(input, retries = 0) {
    busy = true;
    lastStreamedForHooks = '';
    streamFlushedCount = 0;
    if (TUI) tuiUserLine(input);
    const hooks = hooksForRun();
    const stopSpinner = hooks.spinnerStop;
    try {
      const res = await runObjective(state, input, process.cwd(), history, hooks);
      if (lastStreamedForHooks && TUI) process.stdout.write('\n');
      history = pushTurn(history, input, res);
      stopSpinner();
      // this model just finished a task cleanly: remember it as the fallback
      if (!res.aborted && state.model !== state.lastGood) {
        Object.assign(state, normalize({ ...state, lastGood: state.model }));
        try { saveConfig(state); } catch {}
      }
      try { history = await compactHistory(state, history, { onNote: n => say(dim('  ◇ ' + n)) }); } catch {}
      try { sessionId = saveSession({ id: sessionId, cwd: process.cwd(), model: state.model, history }); } catch {}
      if (res.aborted) {
        say(yellow('  ■ Stopped') + dim(' - partly done. Ask me to continue.'));
      } else {
        const rows = [green(bold('■ Done'))];
        if (res.changed?.length) rows.push(dim('  files: ') + res.changed.join(', '));
        const answerIsStreamed = lastStreamedForHooks && res.answer === lastStreamedForHooks;
        if (res.answer && !answerIsStreamed) String(res.answer).split('\n').slice(0, 14).forEach(l => rows.push('  ' + l));
        else if (answerIsStreamed) rows.push(dim('  (streamed above)'));
        else if (!res.changed?.length) rows.push(dim('  (no output)'));
        say(box(rows));
      }
    } catch (err) {
      stopSpinner();
      history = pushTurn(history, input, { answer: '(task failed: ' + err.message + ')' });
      try { sessionId = saveSession({ id: sessionId, cwd: process.cwd(), model: state.model, history }); } catch {}
      say(red('  ✗ ' + err.message) + dim('  context kept.'));
      // model/connection trouble: offer the fix right here instead of making the
      // user remember /model (bounded retries so it can never loop forever)
      const recoverable = !err?.stopped
        && retries < 5
        && /HTTP \d{3}|model|timed out|cannot reach|fetch failed|ECONN|ENOTFOUND|network|401|403|404|429|5\d\d/i.test(String(err?.message ?? ''));
      if (recoverable) {
        spinnerFrame = null;
        spinnerText = null;
        if (TUI) drawInputBox();
        const hint = state.lastGood && state.lastGood !== state.model ? ` [l] back to ${prettyModel(state.lastGood)}` : '';
        const a = (await ask(`  [m] pick another model${hint} · [r] retry · [Enter] skip: `)).trim().toLowerCase();
        if (a === 'm') { await pickModel(); return runTask(input, retries + 1); }
        if (a === 'l' && state.lastGood && state.lastGood !== state.model) {
          Object.assign(state, normalize({ ...state, model: state.lastGood }));
          try { saveConfig(state); } catch {}
          say(green('  Model: ' + state.model));
          return runTask(input, retries + 1);
        }
        if (a === 'r') return runTask(input, retries + 1);
      }
    } finally {
      busy = false;
      activeRun = null;
      stopSpinner();
      await afterTask();
    }
  }

  async function afterTask() {
    if (closed) return;
    // notes typed near the end that never reached the model become follow-up tasks
    if (steerQueue.length) pendingLines.unshift(...steerQueue.splice(0));
    if (TUI) { drawStatus(); drawInputBox(); scrollRegion(); return; }
    plainPrompt();
    while (!busy && !closed) {
      const next = pendingLines.shift();
      if (!next) break;
      await handle(next);
    }
  }

  const commands = {
    '/help': () => {
      say('  ' + cyan('/model') + '    pick a model from your provider');
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
      say('  ' + cyan('/new') + '     start a fresh session, keep the old saved');
      say('  ' + cyan('/resume') + '   list sessions, /resume <code> like 1425-0609');
      say('  ' + cyan('/skills') + '   list installed skills, /skills <name> shows one');
      say('  ' + cyan('/mcp') + '     list MCP servers and their tools');
      say('  ' + cyan('/humanizer') + ' natural-writing pass for pages and posts (on/off)');
      say('  ' + cyan('/clear') + '    forget this conversation');
      say('  ' + cyan('/setup') + '    redo provider setup');
      say('  ' + cyan('/reset') + '    clear saved config');
      say('  ' + cyan('/help') + '     this list. Type normally to work, steer mid-task anytime');
      say(dim('  while a task runs: your text is a live steer, /stop cancels it'));
      say('  ' + cyan('/exit') + '     quit');
    },
    '/config': () => {
      say(box([
        bold('Provider config') + dim('  ~/.ineedcodes/config.json'),
        dim('base URL') + '   ' + state.baseUrl,
        dim('model') + '      ' + state.model,
        dim('reasoning') + '  ' + state.reasoning,
        dim('mode') + '        ' + mode,
        dim('memory') + '      ' + (state.memory === false ? 'off' : 'on (icm)'),
        dim('edit perm') + '   ' + state.permEdit,
        dim('shell perm') + '  ' + state.permShell,
        dim('API key') + '     saved, hidden'
      ]));
    },
    '/clear': () => { history = []; say(dim('Conversation forgotten.')); }
  };

  async function handle(input) {
    if (!input) return;
    if (busy) {
      if (input === '/stop' || input.startsWith('/stop ') || input === 'stop') { activeRun?.abort(); say(dim('  (stopping...')); return; }
      if (input.startsWith('/')) { pendingLines.push(input); return; }
      steerQueue.push(input);
      // interrupt the in-flight provider call so the steer applies immediately
      if (activeRun) activeRun.abort('steer');
      say(dim('  ↳ steer noted, applying it now...'));
      return;
    }
    if (['/exit', '/quit', 'exit', 'quit'].includes(input)) return doExit();
    if (input === '/help' || input === '?') return commands['/help']();
    if (input === '/config' || input === '/config show') { busy = true; try { commands['/config'](); } finally { busy = false; } return afterTask(); }
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
      if (['permEdit', 'permShell', 'permNet'].includes('perm' + setting.charAt(0).toUpperCase() + setting.slice(1)) === false && setting === 'net' && ['allow', 'ask'].includes(value)) { Object.assign(state, normalize({ ...state, permNet: value })); persist(); say(green('  net perm: ' + value)); return; }
      if (setting === 'edit' && ['allow', 'ask'].includes(value)) { Object.assign(state, normalize({ ...state, permEdit: value })); persist(); say(green('  edit perm: ' + value)); return; }
      if (setting === 'shell' && ['allow', 'ask'].includes(value)) { Object.assign(state, normalize({ ...state, permShell: value })); persist(); say(green('  shell perm: ' + value)); return; }
      if (setting === 'searchurl') { Object.assign(state, normalize({ ...state, searchUrl: parts.slice(1).join(' ') })); persist(); say(green('  searchUrl set.')); return; }
      say(dim('  Settings: reasoning|depth|memory|humanizer|edit|shell|net|searchurl <value> · model via /model · mode via /plan /build'));
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
      say(box([
        bold('Permissions'),
        dim('edit') + '   ' + state.permEdit + dim('  (write_file, edit_file, delete_file)'),
        dim('shell') + '   ' + state.permShell,
        dim('granted this session') + '  ' + ([...approved].join(', ') || 'none'),
        '',
        dim('/perm auto') + '   never ask (saved)',
        dim('/perm safe') + '   ask for edits and shell (saved)',
        dim('/perm edit allow|ask   /perm shell allow|ask')
      ]));
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
      say(box([
        bold('Status'),
        dim('model') + '      ' + state.model,
        dim('mode') + '       ' + mode + dim(' / reasoning ' + state.reasoning + ' / depth ' + state.explain),
        dim('perms') + '       edit:' + state.permEdit + ' shell:' + state.permShell + ' net:' + state.permNet,
        dim('memory') + '      ' + (state.memory === false ? 'off' : 'on (icm)'),
        dim('humanizer') + '   ' + (state.humanize === false ? 'off' : 'on'),
        dim('mcp') + '        ' + (mcpConfigured() ? 'configured' : 'not configured'),
        dim('tokens') + '      ' + (usage.input || usage.output ? usage.input + ' in / ' + usage.output + ' out' : '-'),
        dim('session') + '     ' + (sessionId ?? 'not saved yet'),
        dim('cwd') + '        ' + process.cwd()
      ]));
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
        say(box([
          bold('Explanation depth'),
          dim('/depth short') + '   results only',
          dim('/depth normal') + ' what changed and why (default)',
          dim('/depth deep') + '   reasoning, trade-offs, ruled-out paths'
        ]));
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
      say(box([
        bold('Humanizer') + dim('  ' + (state.humanize === false ? 'off' : 'on')),
        dim('scope') + '      .html .htm .md .txt (web pages, posts, docs)',
        dim('never touches') + '  code, tags, attributes, URLs, JSON, technical values',
        dim('toggle') + '      /humanizer on | /humanizer off'
      ]));
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
        say(box([
          bold('Boost') + dim('  isolated execution in a git worktree'),
          dim('/boost <objective>') + '  run the task away from your tree, review, then merge',
          dim('/boost cancel') + '        remove the last boost worktree'
        ]));
        return;
      }
      busy = true;
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
          say(box([bold('Boost changes'), ...d.files.map(f => '  ' + f)]));
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
        busy = false;
        await afterTask();
      }
      return;
    }
    if (input === '/skills' || input.startsWith('/skills ')) {
      const arg = input.slice(7).trim();
      if (arg) {
        const s = findSkill(arg, process.cwd(), input);
        if (s) { say(box([bold(`Skill ${s.name}`) + dim(` (${s.scope}${s.gated ? ', gated' : ''})`), s.description, '', dim('Instructions:'), s.instructions.slice(0, 1_500)])); say(dim('Say "use ' + s.name + ' to ..." and the agent follows them.')); }
        else say(red(`No skill named ${arg}.`));
        return;
      }
      const machineUnlocked = devKeyword() !== '';
      const all = listSkills(process.cwd(), machineUnlocked ? devKeyword() : input);
      const gated = machineUnlocked ? all.filter(x => x.gated).length : -1;
      say(all.length ? all.map(s => `  ${cyan(s.name)} ${dim('(' + s.scope + ')')} ${s.description}`).join('\n') : yellow('No skills installed.'));
      if (gated > 0) say(dim(`  (+${gated} gated security skills unlocked on this machine)`));
      else if (!machineUnlocked) say(dim(`  gated security skills are locked on this machine - run ${bold('ineed unlock')} to enable`));
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
        pick = idx !== null ? list[idx].id : '';
        if (!pick) pick = await ask('   Resume which? (code, e.g. 1425-0609, empty = newest): ');
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
    if (input === '/setup' || input === '/reset') {
      clearConfig();
      say(dim('Config cleared. Running setup...'));
      busy = true;
      try {
        const c = await wizard(ask, { fromCommand: true });
        Object.assign(state, normalize(c));
        mode = state.mode;
        say(green('Ready. ' + state.model));
        if (TUI) { drawHeader(); drawStatus(); }
      } catch { return doExit(); }
      busy = false;
      return afterTask();
    }
    return runTask(input);
  }

  const plainPrompt = () => {
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
    console.log(logo());
    console.log(BANNER() + dim(` · ${state.model} · ${process.cwd()}`));
    printWelcome();
    plainPrompt();
    return;
  }

  let chatTop = 0, chatBot = 0;   // scroll region rows
  let statusRow = 0;
  let inputBoxTop = 0;            // top row of the composer panel
  let composerRows = 6;           // model row + gap + text rows
  const COMPOSER_ROWS = 6;
  let viewStart = 0;              // absolute top line of the viewport while scrolled back
  let followTail = true;

  // ── slash command menu (like opencode): filters while you type / ──
  const SLASH_COMMANDS = [
    { cmd: '/model', desc: 'pick a model from your provider' },
    { cmd: '/plan', desc: 'plan mode: read only' },
    { cmd: '/build', desc: 'build mode: real changes (default)' },
    { cmd: '/reason', desc: 'toggle reasoning low/high' },
    { cmd: '/perm', desc: 'permissions: /perm auto | /perm safe' },
    { cmd: '/boost', desc: 'isolated git-worktree run: /boost <objective>' },
    { cmd: '/config', desc: 'open the settings menu' },
    { cmd: '/memory', desc: 'memory status, /memory on|off' },
    { cmd: '/mcp', desc: 'list MCP servers and tools' },
    { cmd: '/skills', desc: 'list installed skills' },
    { cmd: '/humanizer', desc: 'natural-writing pass on/off' },
    { cmd: '/status', desc: 'session overview' },
    { cmd: '/compact', desc: 'shrink conversation into a checkpoint' },
    { cmd: '/depth', desc: 'answer depth: short|normal|deep' },
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

  function drawMenu() {
    menuDrawnRows = 0;
    if (!menuOpen || !menuItems.length) return;
    const rows = process.stdout.rows || 24;
    const anchor = inputBoxTop;             // menu floats just above the prompt rule
    const maxShow = Math.min(menuItems.length, Math.max(3, anchor - chatTop - 1));
    const start = Math.max(0, Math.min(menuSelected - Math.floor(maxShow / 2), menuItems.length - maxShow));
    const w = Math.min(process.stdout.columns || 80, 64);
    let buf = '';
    for (let i = 0; i < maxShow; i++) {
      const item = menuItems[start + i];
      const sel = start + i === menuSelected;
      const label = (sel ? green('› ') : '  ') + cyan(item.cmd) + ' ' + gray(trunc(item.desc, w - 24));
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
    chatBot = inputBoxTop - 1; // give the chat its rows back, repaint the menu zone
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
      chatBot = inputBoxTop - 1 - Math.min(matches.length, Math.max(3, inputBoxTop - chatTop - 1));
      if (menuDrawnRows) redrawChat(); // wipe rows left over from a taller menu
      drawMenu();
      scrollRegion();
    } else if (menuOpen) {
      clearMenu();
    }
  }

  function drawHeader() {
    const rows = 6;
    const lines = logo().split('\n');
    for (let i = 0; i < rows; i++) {
      screen.at(i + 1, 1);
      screen.clearLine();
      process.stdout.write(lines[i] ?? '');
    }
  }

  // Composer: one borderless panel. A thin accent rail on the left, the model
  // label top-right, and the input text blended straight onto the background.
  // No top/right/bottom border, no inner card, no rounded corners.
  function drawInputBox() {
    const cols = process.stdout.columns || 80;
    const rail = gray('│');
    const text = busy ? typedAhead : (rl.line ?? '');
    const spin = busy && spinnerFrame && !typedAhead ? cyan(spinnerFrame) + ' ' + dim(spinnerText ?? 'working') : '';
    const model = dim(prettyModel(state.model));
    const textRows = composerRows - 2;
    const width = Math.max(10, cols - 5);          // rail + 2 padding + cursor column
    let lines = wrapPlain(text, width);
    if (lines.length > textRows) lines = lines.slice(lines.length - textRows);
    let buf = '';
    // model, top-right of the panel
    buf += `\x1b[${inputBoxTop};1H\x1b[2K` + rail + ' '.repeat(Math.max(1, cols - 2 - plain(model).length)) + model;
    // breathing room between the model line and the text
    buf += `\x1b[${inputBoxTop + 1};1H\x1b[2K` + rail;
    // text rows: cursor and text start top-left, continuation lines align under them
    for (let i = 0; i < textRows; i++) {
      buf += `\x1b[${inputBoxTop + 2 + i};1H\x1b[2K` + rail;
      if (spin && i === 0) { buf += '  ' + spin; continue; }
      if (i >= lines.length) continue;
      if (i === 0 && !busy && !text) buf += '  ' + green(bold('▌')) + ' ' + dim('Type message...');
      else if (i === 0) buf += '  ' + green(bold('▌')) + ' ' + lines[0];
      else buf += ' '.repeat(4) + lines[i];
    }
    process.stdout.write(buf);
  }

  function drawStatus() {
    const cols = process.stdout.columns || 80;
    const branch = currentBranch(process.cwd());
    const ctxK = (history.reduce((n, m) => n + (m.content?.length ?? 0) + 24, 0) / 1024).toFixed(1) + 'k';
    const tok = usage.input || usage.output ? ` ${dim(usage.output >= 1000 ? (usage.output / 1000).toFixed(1) + 'k' : usage.output + '')} tok` : '';
    const left = ` ${bold(green('ineed'))} ${dim(`v${VERSION}`)}${branch ? ' ' + cyan('(' + branch + ')') : ''}`;
    const right =
      ` ${mode === 'plan' ? yellow('plan') : green('build')} ${dim('/')} ${dim(state.reasoning)}` +
      ` ${dim('/')} ${dim(ctxK + ' ctx')}${tok}` +
      ` ${dim('/')} ${dim('mem:' + (state.memory === false ? 'off' : 'on'))}` +
      ` ${dim('/')} ${mode === 'plan' ? dim('perm') : state.permEdit === 'ask' ? green('perm:ask') : dim('perm:auto')} `;
    screen.at(statusRow, 1);
    screen.clearLine();
    process.stdout.write(dim('─'.repeat(Math.max(0, cols - plain(left).length - plain(right).length))) + left + right);
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
      buf += `\x1b[${chatTop};${Math.max(1, (process.stdout.columns || 80) - plain(pos).length - 2)}H` + yellow(pos);
    }
    process.stdout.write(buf);
    scrollRegion();
  }

  const SCROLL_STEP = 3; // lines per wheel tick: fine-grained, recent lines stay visible

  function scrollUp() {
    const vis = chatBot - chatTop + 1;
    if (chatLines.length <= vis) return; // everything already fits
    if (followTail) { viewStart = Math.max(0, chatLines.length - vis - SCROLL_STEP); followTail = false; }
    else viewStart = Math.max(0, viewStart - SCROLL_STEP);
    redrawChat();
    drawInputBox();
  }

  function scrollDown() {
    const vis = chatBot - chatTop + 1;
    if (followTail) return;
    viewStart = Math.min(Math.max(0, chatLines.length - vis), viewStart + SCROLL_STEP);
    if (viewStart >= chatLines.length - vis) { followTail = true; viewStart = 0; }
    redrawChat();
    drawInputBox();
  }

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
        else if (m.content) tuiPrint(box([dim('  (earlier) ') + trunc(String(m.content).replaceAll('\n', ' '), 90)]));
      }
      drawStatus();
      scrollRegion();
    }, 0);
  }

  function tuiUserLine(input) {
    for (const l of wrapLines(userBubble(input), Math.max(10, (process.stdout.columns || 80) - 4))) chatLines.push(l);
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
    const maxShow = Math.min(pickerItems.length, Math.max(3, inputBoxTop - chatTop - 1));
    const start = Math.max(0, Math.min(pickerSelected - Math.floor(maxShow / 2), pickerItems.length - maxShow));
    let buf = '';
    for (let i = 0; i < maxShow; i++) {
      const item = pickerItems[start + i];
      const sel = start + i === pickerSelected;
      const label = (sel ? green('› ') : '  ') + cyan(item);
      buf += `\x1b[${inputBoxTop - maxShow + i};1H\x1b[2K` + trunc(label, cols - 1);
    }
    pickerRows = maxShow;
    process.stdout.write(buf);
  }

  function closePicker(restoreChat = true) {
    if (!pickerActive) return;
    pickerActive = false;
    const rowsWiped = pickerRows;
    pickerItems = []; pickerSelected = 0; pickerRows = 0;
    if (restoreChat) { chatBot = inputBoxTop - 1; redrawChat(); drawInputBox(); scrollRegion(); }
    else if (rowsWiped) { /* zone repaint happens on next redraw */ }
  }

  function pickFromList(items) {
    return new Promise(resolve => {
      pickerActive = true;
      pickerItems = items;
      pickerSelected = 0;
      pickerResolver = resolve;
      // lift the chat floor so streaming/approval output cannot paint over the list
      chatBot = inputBoxTop - 1 - Math.min(items.length, Math.max(3, inputBoxTop - chatTop - 1));
      scrollRegion();
      drawPicker();
    });
  }

  const layout = () => {
    const rows = process.stdout.rows || 24;
    const headerRows = 6;
    statusRow = rows - 1;
    composerRows = Math.min(COMPOSER_ROWS, Math.max(4, rows - headerRows - 3));
    inputBoxTop = statusRow - composerRows;    // composer sits right above the status line
    chatTop = Math.min(headerRows + 1, inputBoxTop - 1);
    chatBot = inputBoxTop - 1 - (menuOpen ? Math.min(menuItems.length, Math.max(3, inputBoxTop - chatTop - 1)) : 0);
    screen.at(1, 1);
    process.stdout.write('\x1b[2J');
    drawHeader();
    redrawChat();
    drawInputBox();
    drawStatus();
    scrollRegion();
  };

  rl.on('resize', layout);

  // typed-ahead input while busy: echo it inside the input box; slash menu when typing /
  let typedAhead = '';
  let wheelBuf = null;
  // keypress events are emitted on the INPUT stream, not the readline interface.
  // readline also listens there and copies printable keys into its line buffer,
  // so SGR mouse fragments (digits, final M/m) leak into the prompt as stray
  // numbers while scrolling. We take over the routing: mouse bytes are decoded
  // here and never reach readline; every other key is forwarded unchanged.
  const readlineKeypress = process.stdin.listeners('keypress');
  process.stdin.removeAllListeners('keypress');
  process.stdin.on('keypress', (ch, key) => {
    if (!key) return;
    const forward = () => { for (const fn of readlineKeypress) fn.call(process.stdin, ch, key); };
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
      }
      return; // swallowed: readline never sees mouse bytes
    }
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
      chatBot = inputBoxTop - 1; // lift the menu zone back, wipe leftover menu rows
      redrawChat();
      // fill the readline buffer with the picked command and repaint
      if (!busy) { rl.write(picked); }
      else typedAhead = picked;
      drawInputBox();
      return;
    }
    if (!busy) {
      // idle: readline owns the input; just update the box text and menu from rl.line
      if (key.name === 'return') { typedAhead = ''; if (menuOpen) clearMenu(); }
      forward();
      setImmediate(() => { drawInputBox(); updateMenu(rl.line ?? ''); });
      return;
    }
    if (key.name === 'backspace') typedAhead = typedAhead.slice(0, -1);
    else if (key.name === 'return') { typedAhead = ''; if (menuOpen) clearMenu(); }
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
  });

  handleRef = handle;

  screen.enter();
  screen.mouse(true);
  layout();
  printWelcome();
  scrollRegion();
  tuiReady = true;   // history rendering and stream-reset hooks may paint from here
}
