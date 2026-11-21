/**
 * The pure core of the TUI: `handleKey(state, key) → effects`, `tick(state, now) →
 * effects` and `render(state, size) → lines`.
 *
 * Nothing here touches the terminal, the disk or the network. Keys and time change the
 * state; I/O is returned as effects for the shell (shell.ts) to run. Unit tests drive the
 * whole UI through these three functions.
 *
 * Key precedence (docs/ui-design.md): help overlay → command bar → the screen's own
 * `onKey` → Ctrl+C → Esc → arrows/Enter → text field → global keys (`:` `?` `L`, digits,
 * letter shortcuts). Text fields swallow printable keys, so shortcuts never fire while
 * typing a password or an amount.
 */

import { parseCommand, COMMAND_EXAMPLES } from './commandParser.js';
import { moveCursor, renderMenu, validCursor } from './components/list.js';
import { QUIT, type Effect } from './effects.js';
import { broadcast, commandSend } from './flows/send.js';
import { broadcastTx } from './flows/tx.js';
import { lockNow } from './flows/data.js';
import { findBusy } from './flows/find.js';
import { spinner } from './format.js';
import { openFromRoot } from './nav.js';
import { indexForDigit, isItem, type ScreenView } from './screen.js';
import { SCREENS } from './screens/registry.js';
import { BLANK } from './screens/common.js';
import { back, goHome, inSetup, lockWallet, sendInProgress, top, type AppState } from './state.js';
import { statusBar } from './statusBar.js';
import { clipLine, dimLine, line, pad, seg, wrapLine, type Line } from './text.js';
import { isPrintable, type Key } from './keys.js';

/** Terminal size. Zero (some CI terminals and detached ptys report 0×0) means unknown. */
export interface Size {
  cols: number;
  rows: number;
}

/** Size used when the terminal reports 0 (or nonsense) for a dimension. */
export const FALLBACK_SIZE: Size = { cols: 80, rows: 24 };

/** The current screen's view. Unknown ids fall back to an explanation, never a crash. */
export function currentView(s: AppState): ScreenView {
  const def = SCREENS[top(s).id];
  if (!def) {
    return {
      body: [dimLine(`  This screen (${top(s).id}) does not exist. Press Esc.`)],
      items: [],
      hint: 'esc back',
    };
  }
  return def.view(s);
}

/** Help rows every screen shares, after the screen's own. */
export const GLOBAL_HELP: Array<[string, string]> = [
  ['↑ ↓  enter', 'Move and select'],
  ['1-9', 'Jump to a numbered item'],
  ['esc', 'Back one step (keeps what you typed)'],
  ['ctrl+c', 'Cancel to Home; twice on Home quits'],
  [':', 'Command bar, e.g. send bob 25 cusdc'],
  ['L', 'Lock now'],
  ['?', 'This help'],
  ['/', 'Filter the list (on long lists)'],
];

function flashLine(text: string, style = 'dim'): Line[] {
  return [line('  ', seg(text, style))];
}

/** Ask to quit. A send still confirming gets one warning first. */
function requestQuit(s: AppState): Effect[] {
  if (s.pending.length && !s.quitArmed) {
    s.quitArmed = true;
    s.flash = [
      line('  ', seg('! A send is still waiting for its confirmation.', 'yellow')),
      dimLine('    It confirms on-chain without the wallet open. Press 0 again to quit anyway.'),
    ];
    return [];
  }
  return [QUIT];
}

/** Run the text in the command bar. */
function runCommand(s: AppState, text: string): Effect[] {
  const cmd = parseCommand(text);
  switch (cmd.type) {
    case 'none':
      return [];
    case 'error':
      s.flash = flashLine(cmd.message, 'red');
      return [];
    case 'help':
      s.help = true;
      return [];
    case 'quit':
      return requestQuit(s);
    case 'lock':
      if (!s.wallet) s.flash = flashLine('There is no wallet to lock yet.');
      else lockNow(s);
      return [];
    case 'go':
      if (inSetup(s)) {
        s.flash = flashLine('Finish setup first.', 'yellow');
        return [];
      }
      return openFromRoot(s, cmd.screen);
    case 'send':
      if (inSetup(s)) {
        s.flash = flashLine('Finish setup first.', 'yellow');
        return [];
      }
      return commandSend(s, cmd);
  }
}

/** Type `key` into the focused text field. Returns true when the key was used. */
function typeInto(s: AppState, view: ScreenView, key: Key): boolean {
  const spec = view.input;
  if (!spec) return false;
  const current = s.inputs[spec.field] ?? '';
  if (key === 'backspace') {
    s.inputs[spec.field] = Array.from(current).slice(0, -1).join('');
    s.fieldError = null;
    return true;
  }
  if (key === 'ctrl-u') {
    s.inputs[spec.field] = '';
    s.fieldError = null;
    return true;
  }
  if (!isPrintable(key)) return false;
  if (spec.accept && !spec.accept.test(key)) return true; // swallowed: never a shortcut
  if (spec.maxLength !== undefined && Array.from(current).length >= spec.maxLength) return true;
  s.inputs[spec.field] = current + key;
  s.fieldError = null;
  // Typing puts the cursor back on the field's main action (Continue / Unlock / …).
  const first = view.items.findIndex(isItem);
  if (first >= 0) top(s).cur = first;
  return true;
}

/**
 * Handle one key. Mutates `s` and returns effects for the shell to run.
 */
export function handleKey(s: AppState, key: Key): Effect[] {
  const wasSending = sendInProgress(s);
  const effects = handleKeyInner(s, key);
  // "Every action" unlock mode: whatever route left the send (Esc, a shortcut, the
  // command bar, a menu jump), the key and any prepared send go with it.
  if (wasSending && !sendInProgress(s) && s.data.prefs.unlockMinutes === 0) lockWallet(s);
  return effects;
}

function handleKeyInner(s: AppState, key: Key): Effect[] {
  if (s.quit) return [];

  if (s.help) {
    s.help = false;
    return [];
  }

  if (s.cmd !== null) {
    if (key === 'escape' || key === 'ctrl-c') {
      s.cmd = null;
      return [];
    }
    if (key === 'enter') {
      const text = s.cmd;
      s.cmd = null;
      return runCommand(s, text);
    }
    if (key === 'backspace') {
      s.cmd = Array.from(s.cmd).slice(0, -1).join('');
      return [];
    }
    if (key === 'ctrl-u') {
      s.cmd = '';
      return [];
    }
    if (isPrintable(key) && Array.from(s.cmd).length < 200) s.cmd += key;
    return [];
  }

  const view = currentView(s);
  const f = top(s);
  f.cur = validCursor(view.items, f.cur);

  // The list filter swallows keys while it is being typed (before the screen's keys).
  if (s.filtering !== null) {
    const field = s.filtering;
    const current = s.inputs[field] ?? '';
    if (key === 'escape' || key === 'ctrl-c') {
      delete s.inputs[field];
      s.filtering = null;
    } else if (key === 'enter') {
      s.filtering = null;
    } else if (key === 'backspace') {
      s.inputs[field] = Array.from(current).slice(0, -1).join('');
    } else if (key === 'ctrl-u') {
      s.inputs[field] = '';
    } else if (isPrintable(key) && Array.from(current).length < 40) {
      s.inputs[field] = current + key;
    }
    f.cur = 0;
    return [];
  }
  if (key === '/' && view.filter && !view.input) {
    s.filtering = view.filter;
    s.inputs[view.filter] = s.inputs[view.filter] ?? '';
    return [];
  }

  if (view.onKey) {
    const r = view.onKey(s, key);
    if (r.handled) return r.effects ?? [];
  }

  if (key === 'ctrl-c') {
    if (s.stack.length === 1) {
      if (s.quitArmed) return [QUIT];
      s.quitArmed = true;
      s.flash = s.pending.length
        ? [
            ...flashLine('Press Ctrl+C again to quit.'),
            dimLine('  A send is still confirming; it continues on-chain without the wallet open.'),
          ]
        : flashLine('Press Ctrl+C again to quit.');
      return [];
    }
    if (inSetup(s)) {
      goHome(s, flashLine('Back at the start of this setup step.'));
    } else {
      goHome(s, flashLine('Cancelled. Back at Home. Nothing was signed.'));
    }
    return [];
  }
  // Any other key disarms the double Ctrl+C.
  s.quitArmed = s.quitArmed && (key === '0' || key === 'q');

  if (key === 'escape') {
    back(s);
    return [];
  }

  if (key === 'up' || key === 'down' || (!view.input && (key === 'k' || key === 'j'))) {
    f.cur = moveCursor(view.items, f.cur, key === 'up' || key === 'k' ? -1 : 1);
    return [];
  }

  if (key === 'enter') {
    const item = view.items[f.cur];
    if (item && isItem(item)) return item.act(s) ?? [];
    return [];
  }

  if (view.input) {
    typeInto(s, view, key);
    return [];
  }

  if (key === ':') {
    s.cmd = '';
    return [];
  }
  if (key === '?') {
    s.help = true;
    return [];
  }
  if (key === 'L' || key === 'l') {
    if (s.wallet) lockNow(s);
    return [];
  }
  if (key === 'backspace') {
    back(s);
    return [];
  }
  if (/^[0-9]$/.test(key)) {
    const idx = indexForDigit(view.items, Number(key));
    const item = idx >= 0 ? view.items[idx] : undefined;
    if (item && isItem(item)) {
      f.cur = idx;
      if (item.zero) return requestQuit(s);
      return item.act(s) ?? [];
    }
    return [];
  }
  const hit = view.items.find((e) => isItem(e) && e.key === key);
  if (hit && isItem(hit)) {
    if (hit.zero) return requestQuit(s);
    return hit.act(s) ?? [];
  }
  return [];
}

/**
 * Advance time. Finishes the countdown (→ broadcast) and auto-locks when the unlock
 * period is over. Returns effects to run.
 */
export function tick(s: AppState, now: number): Effect[] {
  s.now = now;
  if (s.countdown && now >= s.countdown.endsAt) {
    return s.countdown.for === 'tx' ? broadcastTx(s) : broadcast(s);
  }
  // Auto-lock, except while a countdown holds an already-checked send.
  if (s.signer && s.unlockedUntil !== null && s.unlockedUntil <= now && !s.countdown) {
    lockNow(s, 'Locked automatically.');
  }
  return [];
}

/** True while something on screen animates (the shell then redraws ~8 times a second). */
export function isAnimating(s: AppState): boolean {
  return Boolean(
    s.pending.length ||
    s.decrypting ||
    s.busy ||
    s.countdown ||
    s.send.checking ||
    s.history?.loading ||
    s.history?.decrypting ||
    s.txAction?.checking ||
    s.operators?.loading ||
    s.disclose?.loading ||
    (top(s).id === 'doctor' && !s.doctor) ||
    findBusy(s) ||
    (top(s).id === 'setup-gas' && (!s.doctor || !s.eth)),
  );
}

function helpLines(view: ScreenView, cols: number): Line[] {
  const rows = [...(view.help ?? []), ...GLOBAL_HELP];
  const w = Math.max(20, Math.min(64, cols - 4));
  const out: Line[] = [line('  ', seg(pad('  Keys on this screen', w), 'bar bold'))];
  out.push(line('  ', seg(' '.repeat(w), 'bar')));
  for (const [k, d] of rows) {
    // Long descriptions wrap inside the box instead of running past its edge.
    const wrapped = wrapLine([{ t: d }], w - 16).map((r) =>
      r
        .map((g) => g.t)
        .join('')
        .trimStart(),
    );
    wrapped.forEach((part, i) => {
      out.push(
        line('  ', seg(`  ${pad(i ? '' : k, 14)}`, 'bar bold'), seg(pad(part, w - 16), 'bar')),
      );
    });
  }
  out.push(line('  ', seg(' '.repeat(w), 'bar')));
  out.push(line('  ', seg(pad('  Press any key to close', w), 'bar dim')));
  return out;
}

/** Render the whole screen to `size.rows` lines of at most `size.cols` columns. */
export function render(s: AppState, size: Size): Line[] {
  const cols = size.cols > 0 ? size.cols : FALLBACK_SIZE.cols;
  const rows = size.rows > 0 ? size.rows : FALLBACK_SIZE.rows;
  const view = currentView(s);
  const f = top(s);
  f.cur = validCursor(view.items, f.cur);

  const head: Line[] = [statusBar(s, cols), BLANK];
  const content: Line[] = [];
  let cursorAt = -1;
  // Menu rows are cut, not wrapped (a wrapped item would look like two items).
  let menuStart = Number.MAX_SAFE_INTEGER;

  if (s.help) {
    content.push(...helpLines(view, cols));
  } else {
    if (s.notice && f.id === 'home' && s.stack.length === 1) {
      content.push(...s.notice, BLANK);
    } else if (s.notice) {
      content.push([...s.notice[0], seg('   · details on Home', 'dim')], BLANK);
    }
    if (s.flash) content.push(...s.flash, BLANK);
    if (view.filter && (s.filtering === view.filter || s.inputs[view.filter])) {
      const typing = s.filtering === view.filter;
      content.push(
        line(
          seg('  / ', 'cyan bold'),
          seg(s.inputs[view.filter] ?? '', 'bold'),
          typing ? seg(' ', 'cursor') : seg(''),
          seg(typing ? '   enter keeps · esc clears' : '   / to change', 'dim'),
        ),
        BLANK,
      );
    }
    content.push(...view.body);
    if (s.fieldError) {
      content.push(BLANK, line('  ', seg(s.fieldError[0], 'red')), dimLine(`  ${s.fieldError[1]}`));
    }
    if (s.busy) content.push(BLANK, line('  ', seg(`${spinner(s.now)} ${s.busy}…`, 'cyan')));
    if (view.items.length) {
      if (view.body.length || s.fieldError || s.busy) content.push(BLANK);
      const menu = renderMenu(view.items, f.cur, cols);
      menuStart = content.length;
      if (menu.cursorLine >= 0) cursorAt = content.length + menu.cursorLine;
      content.push(...menu.lines);
    }
  }

  const foot: Line[] =
    s.cmd !== null
      ? [
          dimLine(`  ${COMMAND_EXAMPLES.join(' · ')}`),
          line(seg(' : ', 'cyan bold'), seg(s.cmd, 'bold'), seg(' ', 'cursor')),
        ]
      : [BLANK, dimLine(` ${s.help ? 'any key closes help' : view.hint}`)];

  // Wrap long lines (links, hints) rather than cutting them, keeping track of the cursor.
  const wrapped: Line[] = [];
  let cursorRow = -1;
  content.forEach((l, i) => {
    if (i === cursorAt) cursorRow = wrapped.length;
    if (i >= menuStart) wrapped.push(l);
    else wrapped.push(...wrapLine(l, cols));
  });

  // Fit the middle part; when it is too long, keep the cursor's line in view.
  const room = Math.max(0, rows - head.length - foot.length);
  let middle = wrapped;
  if (wrapped.length > room) {
    const start = cursorRow >= room ? cursorRow - room + 1 : 0;
    middle = wrapped.slice(start, start + room);
  }
  while (middle.length < room) middle = [...middle, BLANK];

  const all = [...head, ...middle, ...foot].slice(0, rows);
  return all.map((l) => clipLine(l, cols));
}
