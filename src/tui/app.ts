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
import {
  moveCursor,
  rememberCursor,
  renderMenu,
  stableCursor,
  viewCursor,
} from './components/list.js';
import { QUIT, type Effect } from './effects.js';
import { broadcast, commandSend } from './flows/send.js';
import { broadcastTx } from './flows/tx.js';
import { commandWrap } from './flows/wrap.js';
import { decryptAll, lockNow, refreshEth, reload } from './flows/data.js';
import { loadHistory } from './flows/manage.js';
import { findBusy } from './flows/find.js';
import { spinner } from './format.js';
import { openFromRoot } from './nav.js';
import { indexForDigit, isItem, selectable, type ScreenView } from './screen.js';
import { SCREENS } from './screens/registry.js';
import { BLANK } from './screens/common.js';
import {
  back,
  goHome,
  inSetup,
  lockWallet,
  sendInProgress,
  top,
  type AppState,
  type Frame,
} from './state.js';
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
  ['pgup pgdn', 'Scroll a long list (home / end: top / bottom)'],
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
    case 'wrap':
      if (inSetup(s)) {
        s.flash = flashLine('Finish setup first.', 'yellow');
        return [];
      }
      return commandWrap(s, cmd);
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * PgUp/PgDn (one window) and Home/End (all the way): scroll the screen's list, move a
 * multi-select cursor, or move the cursor through a long menu.
 */
function pageKey(view: ScreenView, f: Frame, key: Key): void {
  const dir = key === 'pageup' || key === 'home' ? -1 : 1;
  const far = key === 'home' || key === 'end';
  const page = Math.max(1, f.page ?? 10);
  if (view.multiSelect !== undefined) {
    if (view.multiSelect)
      f.cur = clamp(f.cur + dir * (far ? view.multiSelect : page), 0, view.multiSelect - 1);
  } else if (view.list?.length) {
    f.scroll = clamp(
      (f.scroll ?? 0) + dir * (far ? view.list.length : page),
      0,
      view.list.length - 1,
    );
  } else {
    const sel = selectable(view.items);
    const at = sel.indexOf(f.cur);
    if (sel.length) f.cur = sel[clamp(at + dir * (far ? sel.length : 10), 0, sel.length - 1)];
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

/** How a key arrived. */
export interface KeyOptions {
  /**
   * The key came with others in one read (a script, a paste the terminal did not
   * bracket, very fast typing). Quit then only arms and asks for a second press.
   */
  burst?: boolean;
}

/**
 * Handle one key. Mutates `s` and returns effects for the shell to run.
 */
export function handleKey(s: AppState, key: Key, opts: KeyOptions = {}): Effect[] {
  const wasSending = sendInProgress(s);
  const effects = handleKeyInner(s, key, opts);
  // The cursor is where the key left it: remember that item, so effects that add or
  // remove items before the next frame do not move it (stableCursor).
  if (!s.quit) {
    const v = currentView(s);
    const f = top(s);
    f.cur = viewCursor(v, f.cur);
    rememberCursor(v, f);
  }
  // "Every action" unlock mode: whatever route left the send (Esc, a shortcut, the
  // command bar, a menu jump), the key and any prepared send go with it.
  if (wasSending && !sendInProgress(s) && s.data.prefs.unlockMinutes === 0) lockWallet(s);
  return effects;
}

/** Quit from a burst of keys: only arm it, so pasted text containing 0 or q cannot quit. */
function quitFromKey(s: AppState, opts: KeyOptions): Effect[] {
  if (!opts.burst || s.quitArmed) return requestQuit(s);
  s.quitArmed = true;
  s.flash = flashLine('Press 0 again to quit.');
  return [];
}

function handleKeyInner(s: AppState, key: Key, opts: KeyOptions): Effect[] {
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
  f.cur = stableCursor(view, f);

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
    f.scroll = 0;
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
    } else if (s.stack.some((f) => /^(send-|tx-)/.test(f.id))) {
      // Only a send or transaction in progress was "cancelled".
      goHome(s, flashLine('Cancelled. Back at Home. Nothing was signed.'));
    } else {
      goHome(s);
    }
    return [];
  }
  // Any other key disarms the double Ctrl+C.
  s.quitArmed = s.quitArmed && (key === '0' || key === 'q');

  if (key === 'escape') {
    back(s);
    return [];
  }

  if (key === 'pageup' || key === 'pagedown' || key === 'home' || key === 'end') {
    pageKey(view, f, key);
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
      if (item.zero) return quitFromKey(s, opts);
      return item.act(s) ?? [];
    }
    return [];
  }
  const hit = view.items.find((e) => isItem(e) && e.key === key);
  if (hit && isItem(hit)) {
    if (hit.zero) return quitFromKey(s, opts);
    return hit.act(s) ?? [];
  }
  return [];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Pasted text as one line: line breaks at the ends are dropped (a copied line often
 * ends in one; it must never act as Enter), the ones inside become spaces, and other
 * control characters are removed.
 */
export function pasteText(raw: string): string {
  return Array.from(raw.replace(/^[\r\n]+|[\r\n]+$/g, '').replace(/[\r\n\t]+/g, ' '))
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    })
    .join('');
}

/** True when pasted text is one Ethereum address (surrounding spaces allowed). */
export function isPastedAddress(text: string): boolean {
  return ADDRESS.test(text.trim());
}

/**
 * Handle a paste (one event for the whole text, see input.ts). It goes into whatever
 * takes text: the command bar, the list filter, or the screen's field, through the same
 * checks as typing (accepted characters, maximum length; secret fields stay masked and
 * are cleared as usual). A screen without a field may take it (`onPaste`: Send ›
 * Recipient opens the paste step with the address filled in, so the checksum,
 * look-alike and first-time checks still run on Continue); anywhere else the paste is
 * ignored with a note. Pasted text never runs as shortcuts and never presses Enter.
 */
export function handlePaste(s: AppState, raw: string): Effect[] {
  if (s.quit) return [];
  const text = pasteText(raw);
  if (!text) return [];
  if (s.help) {
    s.help = false;
    return [];
  }
  if (s.cmd !== null) {
    s.cmd = Array.from(s.cmd + text)
      .slice(0, 200)
      .join('');
    return [];
  }
  const view = currentView(s);
  const f = top(s);
  f.cur = viewCursor(view, f.cur);
  if (s.filtering !== null) {
    const field = s.filtering;
    s.inputs[field] = Array.from((s.inputs[field] ?? '') + text.trim())
      .slice(0, 40)
      .join('');
    f.cur = 0;
    return [];
  }
  if (view.bare) return []; // the countdown ignores everything but Esc and Ctrl+C
  if (view.input) {
    const spec = view.input;
    // Secrets keep their spaces exactly; anything else is trimmed.
    const chars = Array.from(spec.secret ? text : text.trim());
    for (const c of chars) typeInto(s, view, c);
    return [];
  }
  if (view.onPaste) {
    const r = view.onPaste(s, text.trim());
    if (r.handled) return r.effects ?? [];
  }
  s.flash = isPastedAddress(text)
    ? [
        ...flashLine('Pasted address ignored: this screen has no text field.'),
        dimLine('  To send to it: Send (s), then Paste an address (p).'),
      ]
    : flashLine('Pasted text ignored: this screen has no text field.');
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
  // A send ended unconfirmed a while ago: look again (balances, ETH, history).
  if (s.recheckAt && now >= s.recheckAt) {
    s.recheckAt = null;
    return [reload(s), refreshEth(s), ...decryptAll(s), ...(s.history ? loadHistory(s) : [])];
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
    s.wrap.loading ||
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

/** Most rows a list window keeps even on a short terminal. */
const MIN_LIST_ROWS = 3;

/**
 * The visible part of a scrolling list: `height` rows from `start`, the last row being
 * a "rows a-b of n" note when the list does not fit. `cursor` (a multi-select row) is
 * kept in view. Updates the frame's scroll and page so PgUp/PgDn step a full window.
 */
function listWindow(f: Frame, rows: Line[], height: number, cursor?: number): Line[] {
  if (rows.length <= height) {
    f.scroll = 0;
    f.page = rows.length;
    return rows;
  }
  const shown = Math.max(1, height - 1);
  let start = Math.max(0, Math.min(f.scroll ?? 0, rows.length - shown));
  if (cursor !== undefined && cursor >= 0) {
    if (cursor < start) start = cursor;
    else if (cursor >= start + shown) start = cursor - shown + 1;
  }
  f.scroll = start;
  f.page = shown;
  const end = Math.min(rows.length, start + shown);
  const more: string[] = [];
  if (start > 0) more.push('pgup');
  if (end < rows.length) more.push('pgdn');
  return [
    ...rows.slice(start, end),
    dimLine(`  rows ${start + 1}-${end} of ${rows.length} · ${more.join('/')} scroll`),
  ];
}

/**
 * The part of a menu that fits in `height` rows around the cursor, with "↑ n more" /
 * "↓ n more" in place of the cut ends.
 */
function menuWindow(lines: Line[], cursorLine: number, height: number): Line[] {
  if (lines.length <= height) return lines;
  const h = Math.max(3, height);
  const at = Math.max(0, cursorLine);
  // Centre the cursor, so it never lands on a "more" row.
  const start = Math.max(0, Math.min(at - Math.floor(h / 2), lines.length - h));
  const end = Math.min(lines.length, start + h);
  const out = lines.slice(start, end);
  if (start > 0) out[0] = dimLine(`   ↑ ${start + 1} more`);
  if (end < lines.length) out[out.length - 1] = dimLine(`   ↓ ${lines.length - end + 1} more`);
  return out;
}

/** Render the whole screen to `size.rows` lines of at most `size.cols` columns. */
export function render(s: AppState, size: Size): Line[] {
  const cols = size.cols > 0 ? size.cols : FALLBACK_SIZE.cols;
  const rows = size.rows > 0 ? size.rows : FALLBACK_SIZE.rows;
  s.size = { cols, rows };
  const view = currentView(s);
  const f = top(s);
  f.cur = stableCursor(view, f);
  rememberCursor(view, f);

  const head: Line[] = [statusBar(s, cols), BLANK];
  // Above the list: notices, the flash, the filter line and the body (wrapped).
  const above: Line[] = [];
  // Below the list: the screen's notes, field errors and the busy spinner (wrapped).
  const below: Line[] = [];
  let listRows: Line[] = [];
  let menu: { lines: Line[]; cursorLine: number } = { lines: [], cursorLine: -1 };

  if (s.help) {
    above.push(...helpLines(view, cols));
  } else {
    if (s.notice && f.id === 'home' && s.stack.length === 1) {
      above.push(...s.notice, BLANK);
    } else if (s.notice) {
      above.push([...s.notice[0], seg('   · details on Home', 'dim')], BLANK);
    }
    if (s.flash) above.push(...s.flash, BLANK);
    if (view.filter && (s.filtering === view.filter || s.inputs[view.filter])) {
      const typing = s.filtering === view.filter;
      above.push(
        line(
          seg('  / ', 'cyan bold'),
          seg(s.inputs[view.filter] ?? '', 'bold'),
          typing ? seg(' ', 'cursor') : seg(''),
          seg(typing ? '   enter keeps · esc clears' : '   / to change', 'dim'),
        ),
        BLANK,
      );
    }
    above.push(...view.body);
    listRows = view.list ?? [];
    below.push(...(view.after ?? []));
    if (s.fieldError) {
      below.push(BLANK, line('  ', seg(s.fieldError[0], 'red')), dimLine(`  ${s.fieldError[1]}`));
    }
    if (s.busy) below.push(BLANK, line('  ', seg(`${spinner(s.now)} ${s.busy}…`, 'cyan')));
    if (view.items.length) {
      if (view.body.length || listRows.length || below.length) below.push(BLANK);
      // Menu rows are cut, not wrapped (a wrapped item would look like two items).
      menu = renderMenu(view.items, f.cur, cols);
    }
  }

  const foot: Line[] =
    s.cmd !== null
      ? [
          dimLine(`  ${COMMAND_EXAMPLES.join(' · ')}`),
          line(seg(' : ', 'cyan bold'), seg(s.cmd, 'bold'), seg(' ', 'cursor')),
        ]
      : [BLANK, dimLine(` ${s.help ? 'any key closes help' : view.hint}`)];

  // Wrap long lines (links, hints) rather than cutting them.
  const wrapAll = (ls: Line[]) => ls.flatMap((l) => wrapLine(l, cols));
  const top0 = wrapAll(above);
  const bottom = wrapAll(below);
  const room = Math.max(0, rows - head.length - foot.length);

  // Fit the middle part. A long list shrinks to a scrolling window first, then a long
  // menu to a window around the cursor; the body, the notes and the filter line stay.
  let middle: Line[];
  const fixed = top0.length + bottom.length;
  const listRoom = room - fixed - menu.lines.length;
  if (listRows.length && fixed + MIN_LIST_ROWS <= room) {
    const height = Math.max(MIN_LIST_ROWS, Math.min(listRows.length, listRoom));
    const shown = listWindow(f, listRows, height, view.listCursor);
    const menuRoom = room - fixed - shown.length;
    middle = [...top0, ...shown, ...bottom, ...menuWindow(menu.lines, menu.cursorLine, menuRoom)];
  } else if (!listRows.length && menu.lines.length && fixed + 3 <= room) {
    middle = [...top0, ...bottom, ...menuWindow(menu.lines, menu.cursorLine, room - fixed)];
  } else {
    // Even the fixed part does not fit: keep the cursor's line in view, as before.
    const all = [...top0, ...listRows, ...bottom, ...menu.lines];
    const cursorRow =
      menu.cursorLine >= 0 ? top0.length + listRows.length + bottom.length + menu.cursorLine : -1;
    const start = cursorRow >= room ? cursorRow - room + 1 : 0;
    middle = all.slice(start, start + room);
  }
  middle = middle.slice(0, room);
  while (middle.length < room) middle = [...middle, BLANK];

  const all = [...head, ...middle, ...foot].slice(0, rows);
  return all.map((l) => clipLine(l, cols));
}
