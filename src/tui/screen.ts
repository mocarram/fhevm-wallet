/**
 * What a screen module provides, and the menu model shared by every screen.
 */

import type { Effect } from './effects.js';
import type { AppState } from './state.js';
import type { Line } from './text.js';

/** What an action returns: effects for the shell to run (or nothing). */
export type ActionResult = Effect[] | void;

/** A menu entry. */
export interface Item {
  label: string;
  act: (s: AppState) => ActionResult;
  /** Letter shortcut, shown dimmed after the label. */
  key?: string;
  /** Not numbered (keeps the numbers of the other items stable when it comes and goes). */
  nonum?: boolean;
  /** Bound to 0 instead of a number (Quit). */
  zero?: boolean;
  /** Extra text after the label, e.g. "last used". */
  value?: string;
  valueStyle?: string;
  /** Dim note after the value, e.g. "repeat last send". */
  note?: string;
  /** Shown dimmed; still numbered so numbers stay stable once it is enabled. */
  disabled?: boolean;
}

/** A divider line between groups of items. */
export interface Separator {
  sep: true;
}

export type MenuEntry = Item | Separator;

/** A text field on a screen. Printable keys type into it instead of acting as shortcuts. */
export interface InputSpec {
  field: string;
  /** Mask the text with `*`. */
  secret?: boolean;
  placeholder?: string;
  /** Characters accepted; others are ignored. Defaults to any printable character. */
  accept?: RegExp;
  maxLength?: number;
  /** Prompt shown before the field. */
  label?: string;
}

/** Everything needed to draw a screen and handle its keys. */
export interface ScreenView {
  body: Line[];
  items: MenuEntry[];
  /** One-line key hint at the bottom. */
  hint: string;
  /** Extra rows for the `?` help overlay: [keys, description]. */
  help?: Array<[string, string]>;
  input?: InputSpec;
  /**
   * The list on this screen can be filtered with `/`: the text field id that holds the
   * filter. The screen itself applies `s.inputs[filter]` to its rows (`matchesFilter`).
   */
  filter?: string;
  /**
   * Rows of the screen's multi-select list (`components/list.ts`), when it has one. The
   * frame cursor then indexes that list, not `items`, and is only clamped to its length.
   */
  multiSelect?: number;
  /** Full-screen view without a menu (countdown). */
  bare?: boolean;
  /**
   * Take a paste on a screen without a text field (the text is one line, trimmed).
   * Return handled: false to fall back to "Pasted text ignored".
   */
  onPaste?: (s: AppState, text: string) => { handled: boolean; effects?: Effect[] };
  /** Handle keys before the generic keymap. Return true when the key was used. */
  onKey?: (s: AppState, key: string) => { handled: boolean; effects?: Effect[] };
}

/** A screen module: breadcrumb, view and what to load when it opens. */
export interface ScreenDef {
  /** Breadcrumb after "Home", e.g. ["Send", "Amount"]. */
  crumb: string[];
  view: (s: AppState) => ScreenView;
  /** Effects to run when the screen is opened (not when returning to it with Esc). */
  onEnter?: (s: AppState) => Effect[];
}

/** True for a selectable entry. */
export function isItem(e: MenuEntry): e is Item {
  return !('sep' in e);
}

/** Indices of selectable entries. */
export function selectable(items: MenuEntry[]): number[] {
  return items.flatMap((e, i) => (isItem(e) ? [i] : []));
}

/**
 * Number each entry: 1..9 for ordinary items in order, 0 for the `zero` item, null for
 * unnumbered ones. Numbers depend only on the screen's own item list, never on the cursor,
 * so they are stable and can be learned.
 */
export function numbering(items: MenuEntry[]): Array<number | null> {
  let n = 0;
  return items.map((e) => {
    if (!isItem(e)) return null;
    if (e.zero) return 0;
    if (e.nonum) return null;
    n += 1;
    return n <= 9 ? n : null;
  });
}

/** Index of the entry a digit key selects, or -1. */
export function indexForDigit(items: MenuEntry[], digit: number): number {
  return numbering(items).indexOf(digit);
}
