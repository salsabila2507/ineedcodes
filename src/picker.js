// picker.js: arrow-key list picker for plain terminals (the wizard's model step,
// /model outside the full-screen UI). Zero dependencies: readline keypress
// events in raw mode. Up/Down move, typing filters, Enter picks, Esc falls back
// to typing an id by hand, Ctrl+C cancels. Only ASCII markers and the basic
// cursor sequences libuv also understands on legacy Windows consoles.

import * as readline from 'node:readline';

// interactive only on a real terminal; pipes and tests keep the text prompt
export function canPickInteractive(input = process.stdin, output = process.stdout) {
  if (process.env.INEED_NO_PICKER === '1') return false;
  return Boolean(input?.isTTY && output?.isTTY && typeof input.setRawMode === 'function');
}

// every space-separated word must appear (case-insensitive), in any order
export function filterItems(items, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice();
  return items.filter(it => { const s = String(it).toLowerCase(); return words.every(w => s.includes(w)); });
}

// first visible row so the selection stays in view, roughly centered
export function windowStart(sel, total, rows) {
  if (total <= rows) return 0;
  return Math.max(0, Math.min(sel - Math.floor(rows / 2), total - rows));
}

// Take over keypress events. readline's own handler would act on the same keys
// (Enter would submit a line, Up would walk history), so its listeners step
// aside and come back, with the previous raw-mode state, on restore().
export function takeKeys(onKey, input = process.stdin) {
  readline.emitKeypressEvents(input);
  const saved = input.listeners('keypress');
  input.removeAllListeners('keypress');
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = typeof input.isPaused === 'function' ? input.isPaused() : false;
  try { input.setRawMode?.(true); } catch {}
  try { input.resume?.(); } catch {}
  const handler = (str, key) => onKey(str, key || {});
  input.on('keypress', handler);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    input.removeListener('keypress', handler);
    for (const l of saved) input.on('keypress', l);
    try { input.setRawMode?.(wasRaw); } catch {}
    if (wasPaused) { try { input.pause?.(); } catch {} }
  };
}

// Resolves { value } on Enter, { manual: true, typed } on Esc, { cancelled: true }
// on Ctrl+C. Enter with a filter that matches nothing returns the typed text
// as the value, so an id missing from the list can still be used.
export function pickInteractive(items, { title = 'Pick one', initial = 0, rows = 10, input = process.stdin, output = process.stdout } = {}) {
  return new Promise(resolve => {
    const color = !(process.env.NO_COLOR && process.env.NO_COLOR !== '0');
    let filter = '';
    let list = items.slice();
    let sel = Math.max(0, Math.min(items.length - 1, Number(initial) || 0));
    const height = Math.min(rows, Math.max(1, items.length)) + 2;   // header + rows + hint
    let drawn = false;
    const cols = () => Math.max(20, (output.columns || 80) - 1);
    const fit = s => (s.length > cols() ? s.slice(0, cols() - 3) + '...' : s);
    const draw = () => {
      const view = Math.min(rows, Math.max(1, items.length));
      const start = windowStart(sel, list.length, view);
      const lines = [];
      const range = list.length ? `${start + 1}-${Math.min(list.length, start + view)} of ${list.length}` : 'no match';
      lines.push(fit(`  ${title}  [${range}]  filter: ${filter || '(type to filter)'}`));
      for (let i = 0; i < view; i++) {
        const it = list[start + i];
        if (it === undefined) { lines.push(i === 0 && filter ? fit(`    Enter uses "${filter}" as typed`) : ''); continue; }
        const row = fit(((start + i) === sel ? '  > ' : '    ') + it);
        lines.push((start + i) === sel && color ? '\x1b[7m' + row + '\x1b[0m' : row);
      }
      lines.push(fit('  Up/Down move · Enter pick · type to filter · Esc type an id · Ctrl+C cancel'));
      let out = drawn ? `\r\x1b[${height}A` : '';
      for (const l of lines) out += '\r\x1b[2K' + l + '\n';
      output.write(out);
      drawn = true;
    };
    const finish = result => {
      restore();
      if (drawn) output.write(`\r\x1b[${height}A\x1b[J`);
      resolve(result);
    };
    const refilter = () => { list = filterItems(items, filter); sel = 0; };
    const restore = takeKeys((str, key) => {
      const name = key.name;
      if (key.ctrl && name === 'c') return finish({ cancelled: true });
      if (name === 'escape') return finish({ manual: true, typed: filter });
      if (name === 'return' || name === 'enter') {
        if (list.length) return finish({ value: list[sel] });
        if (filter.trim()) return finish({ value: filter.trim() });
        return;
      }
      if (name === 'up') sel = Math.max(0, sel - 1);
      else if (name === 'down') sel = Math.min(Math.max(0, list.length - 1), sel + 1);
      else if (name === 'pageup') sel = Math.max(0, sel - rows);
      else if (name === 'pagedown') sel = Math.min(Math.max(0, list.length - 1), sel + rows);
      else if (name === 'home') sel = 0;
      else if (name === 'end') sel = Math.max(0, list.length - 1);
      else if (name === 'backspace') { if (!filter) return; filter = filter.slice(0, -1); refilter(); }
      else if (!key.ctrl && !key.meta && typeof str === 'string' && str.length === 1 && str >= ' ' && str !== '\x7f') { filter += str; refilter(); }
      else return;
      draw();
    }, input);
    draw();
  });
}
