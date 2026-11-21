/**
 * Reusable list components.
 *
 * - The menu: numbered items with stable numbers (see `numbering`), an unnumbered slot
 *   for optional items, `0` for Quit, separators, values, notes and letter shortcuts.
 *   Every screen's `items` are drawn and navigated with these helpers.
 * - The multi-select list: Space toggles the item under the cursor, `a` selects all (or
 *   none when all are selected), Enter confirms. Used by "Remove tokens" today and by
 *   "Find tokens" in Phase 4. Its picks live in the frame's params, so they survive Esc
 *   into a sub-screen and back like any other input.
 *
 * Everything here is pure: (state, key) → state, (state, width) → lines.
 */

import { isItem, numbering, selectable, type MenuEntry } from '../screen.js';
import type { Frame } from '../state.js';
import { pad, seg, width, type Line, type Style } from '../text.js';

/** Move the cursor to the next (+1) or previous (-1) selectable entry, wrapping around. */
export function moveCursor(items: MenuEntry[], cur: number, dir: 1 | -1): number {
  const sel = selectable(items);
  if (!sel.length) return cur;
  const at = sel.indexOf(cur);
  if (at < 0) return sel[0];
  return sel[(at + dir + sel.length) % sel.length];
}

/** The cursor, corrected to point at a selectable entry (screens change their items). */
export function validCursor(items: MenuEntry[], cur: number): number {
  const sel = selectable(items);
  if (!sel.length) return 0;
  return sel.includes(cur) ? cur : sel[0];
}

/**
 * The frame cursor for `view`: inside its multi-select list when it has one (whose rows
 * are not menu items, so `validCursor` would reset it to 0 on every key), else on a
 * selectable menu item.
 */
export function viewCursor(
  view: { items: MenuEntry[]; multiSelect?: number },
  cur: number,
): number {
  if (view.multiSelect === undefined) return validCursor(view.items, cur);
  return Math.max(0, Math.min(cur, view.multiSelect - 1));
}

function styles(text: string | undefined): Style[] {
  return text ? (text.split(' ').filter(Boolean) as Style[]) : [];
}

/**
 * Draw a menu. Returns the lines and the index of the line that holds the cursor, so the
 * caller can keep it visible when the screen is too short.
 */
export function renderMenu(
  items: MenuEntry[],
  cur: number,
  cols: number,
): { lines: Line[]; cursorLine: number } {
  const nums = numbering(items);
  const labelW = Math.min(
    Math.max(12, ...items.map((e) => (isItem(e) ? width(e.label) : 0))) + 1,
    Math.max(12, cols - 24),
  );
  let cursorLine = -1;
  const lines = items.map((e, i): Line => {
    if (!isItem(e)) return [seg('  ─────────────', 'dim')];
    const on = i === cur;
    if (on) cursorLine = i;
    const n = nums[i];
    const num = n === null ? '   ' : `${n}  `;
    const base: Style[] = on ? ['sel', 'bold'] : e.disabled ? ['dim'] : [];
    const out: Line = [{ t: ` ${on ? '❯ ' : '  '}${num}${pad(e.label, labelW)}`, s: base }];
    if (e.value) {
      const vs = styles(e.valueStyle || 'cyan');
      out.push({ t: ` ${e.value} `, s: on ? ['sel', ...vs] : vs });
    }
    if (e.note) out.push({ t: ` ${e.note} `, s: on ? ['sel', 'dim'] : ['dim'] });
    if (e.key) out.push(seg(`  ${e.key}`, 'dim'));
    return out;
  });
  return { lines, cursorLine };
}

/** One option of a multi-select list. */
export interface MultiOption {
  id: string;
  label: string;
  /** Dim text after the label, e.g. "unverified". */
  note?: string;
  noteStyle?: string;
}

/** The ids picked in a multi-select list on `frame`. */
export function picked(frame: Frame): Set<string> {
  const raw = frame.params.picked ?? '';
  return new Set(raw ? raw.split(',') : []);
}

function setPicked(frame: Frame, ids: Set<string>, options: MultiOption[]): void {
  // Keep the options' order so the confirm callback sees a stable list. Picks hidden by
  // the list filter are kept (after the visible ones): filtering must not unselect them.
  const visible = new Set(options.map((o) => o.id));
  const hidden = [...picked(frame)].filter((id) => !visible.has(id));
  frame.params.picked = [...options.map((o) => o.id).filter((id) => ids.has(id)), ...hidden].join(
    ',',
  );
}

/** What a key did in a multi-select list. */
export type MultiKeyResult =
  | { kind: 'moved' }
  | { kind: 'toggled' }
  | { kind: 'confirm'; ids: string[] }
  | { kind: 'ignored' };

/**
 * Handle a key in a multi-select list on `frame` (cursor = frame.cur over `options`).
 * Ids must not contain commas (addresses and names used here never do).
 */
export function multiSelectKey(frame: Frame, options: MultiOption[], key: string): MultiKeyResult {
  const n = options.length;
  if (key === 'up' || key === 'k') {
    if (n) frame.cur = (frame.cur - 1 + n) % n;
    return { kind: 'moved' };
  }
  if (key === 'down' || key === 'j') {
    if (n) frame.cur = (frame.cur + 1) % n;
    return { kind: 'moved' };
  }
  if (key === ' ') {
    const opt = options[frame.cur];
    if (!opt) return { kind: 'ignored' };
    const ids = picked(frame);
    if (ids.has(opt.id)) ids.delete(opt.id);
    else ids.add(opt.id);
    setPicked(frame, ids, options);
    return { kind: 'toggled' };
  }
  if (key === 'a') {
    const ids = picked(frame);
    const all = options.every((o) => ids.has(o.id));
    setPicked(frame, all ? new Set() : new Set(options.map((o) => o.id)), options);
    return { kind: 'toggled' };
  }
  if (key === 'enter') {
    const ids = picked(frame);
    const visible = options.map((o) => o.id).filter((id) => ids.has(id));
    return {
      kind: 'confirm',
      ids: [...visible, ...[...ids].filter((id) => !visible.includes(id))],
    };
  }
  return { kind: 'ignored' };
}

/** Draw a multi-select list: `❯ [x] label  note`. */
export function renderMultiSelect(frame: Frame, options: MultiOption[]): Line[] {
  const ids = picked(frame);
  const labelW = Math.max(12, ...options.map((o) => width(o.label))) + 1;
  return options.map((o, i): Line => {
    const on = i === frame.cur;
    const box = ids.has(o.id) ? '[x]' : '[ ]';
    const out: Line = [
      { t: ` ${on ? '❯ ' : '  '}${box} ${pad(o.label, labelW)}`, s: on ? ['sel', 'bold'] : [] },
    ];
    if (o.note) out.push({ t: ` ${o.note}`, s: styles(o.noteStyle || 'dim') });
    return out;
  });
}

/** Help rows for a multi-select list. */
export const MULTI_SELECT_HELP: Array<[string, string]> = [
  ['space', 'Select or unselect the item under the cursor'],
  ['a', 'Select all, or none when all are selected'],
  ['enter', 'Confirm the selection'],
];

/**
 * True when `text` matches the list filter: every word of `query` appears in it, in any
 * case. An empty query matches everything.
 */
export function matchesFilter(text: string, query: string | undefined): boolean {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Multi-select options matching the filter; keeps the frame's cursor on the list. */
export function filterOptions(
  frame: Frame,
  options: MultiOption[],
  query: string | undefined,
): MultiOption[] {
  const out = options.filter((o) => matchesFilter(`${o.label} ${o.note ?? ''}`, query));
  if (frame.cur >= out.length) frame.cur = 0;
  return out;
}
