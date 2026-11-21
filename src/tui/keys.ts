/**
 * Key names the TUI understands, normalised from Node's readline keypress events.
 *
 * Printable characters are passed through as themselves ("a", "L", ":", "?", "5").
 * Special keys use names: up, down, left, right, enter, escape, backspace, tab, ctrl-c,
 * ctrl-d, ctrl-u (clear field). Anything else is ignored.
 */

/** A normalised key. */
export type Key = string;

/** The subset of readline's keypress `key` object we read. */
export interface RawKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

const NAMED: Record<string, Key> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  return: 'enter',
  enter: 'enter',
  escape: 'escape',
  backspace: 'backspace',
  delete: 'backspace',
  tab: 'tab',
};

/**
 * Turn a readline keypress (`str`, `key`) into a `Key`, or null when it should be ignored.
 * Control characters other than the few we bind are dropped so they can never end up in
 * a text field (or on screen) as raw escape codes.
 */
export function normalizeKey(str: string | undefined, key: RawKey | undefined): Key | null {
  if (key?.ctrl) {
    if (key.name === 'c') return 'ctrl-c';
    if (key.name === 'd') return 'ctrl-d';
    if (key.name === 'u') return 'ctrl-u';
    return null;
  }
  if (key?.name && NAMED[key.name]) return NAMED[key.name];
  if (key?.meta) return null;
  if (typeof str === 'string' && str.length === 1) {
    const code = str.charCodeAt(0);
    // Not C0, DEL or C1 controls (0x80-0x9f: some terminals act on them like ESC).
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) return str;
  }
  return null;
}

/** True for a key that types a character into a text field. */
export function isPrintable(key: Key): boolean {
  return Array.from(key).length === 1;
}
