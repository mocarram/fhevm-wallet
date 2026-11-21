/**
 * Raw terminal input → TUI keys and paste events.
 *
 * Replaces readline's `emitKeypressEvents`, which waits 500 ms after a lone Esc to see
 * whether an escape sequence follows (every Esc felt slow) and turns Esc followed by a
 * quickly typed key into one "meta" key that the TUI then dropped (Esc+s lost the s).
 *
 * - A lone Esc is reported once the chunk ends, or `ESC_WAIT_MS` later when the chunk
 *   ends inside a sequence that may still be arriving (slow links split sequences).
 * - Esc followed by an ordinary character (Alt+key, or Esc typed fast before a key) is
 *   reported as Esc, then that key: nothing is lost.
 * - Bracketed paste (`ESC[200~ … ESC[201~`, enabled by the shell) becomes ONE paste
 *   event, so pasted text never runs as menu shortcuts (a pasted `0x…` used to quit).
 * - Arrows, Home/End, PgUp/PgDn, Delete, Enter, Backspace, Tab and the bound Ctrl keys
 *   get names; every other control character or unknown sequence is dropped, so raw
 *   escape codes can never end up in a text field.
 */

import type { Key } from './keys.js';

/** One thing the user did: a key, or a whole paste. */
export type InputEvent = { kind: 'key'; key: Key } | { kind: 'paste'; text: string };

/** How long to wait for the rest of an escape sequence split across reads. */
export const ESC_WAIT_MS = 25;
/** How long to wait for the end of a paste whose end marker has not arrived. */
export const PASTE_WAIT_MS = 300;
/** Longest paste kept; the rest is dropped (no field takes more than a few hundred). */
export const PASTE_MAX = 4096;

const PASTE_END = '\x1b[201~';

// Escape sequences: CSI (`\x1b[` params intermediates final) or SS3 (`\x1bO` + one char).
// eslint-disable-next-line no-control-regex
const SEQUENCE = /^\x1b(?:\[([0-9;?<>]*)([ -/]*)([@-~])|O([ -~]))/;
// The start of a sequence that may still be arriving.
// eslint-disable-next-line no-control-regex
const PARTIAL = /^\x1b(?:\[[0-9;?<>]*[ -/]*|O)$/;

const CSI_FINAL: Record<string, Key> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
};
const CSI_TILDE: Record<string, Key> = {
  '1': 'home',
  '7': 'home',
  '4': 'end',
  '8': 'end',
  '3': 'backspace', // Delete: the fields have no cursor to delete forward from
  '5': 'pageup',
  '6': 'pagedown',
};
const CONTROL: Record<string, Key> = {
  '\r': 'enter',
  '\n': 'enter',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\t': 'tab',
  '\x03': 'ctrl-c',
  '\x04': 'ctrl-d',
  '\x15': 'ctrl-u',
};

/** True for a code point that may be typed into a field (no C0, DEL or C1 controls). */
function printableChar(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
}

/**
 * Incremental parser: feed it each chunk read from the terminal. An incomplete escape
 * sequence (or an unfinished paste) at the end of a chunk is kept for the next one;
 * when nothing more arrives, the caller calls `flush()` after `waitMs()`.
 */
export class InputParser {
  private buf = '';
  private pasting = false;
  private pasted = '';

  /** Parse a chunk. Returns the complete events in it, in order. */
  feed(chunk: string): InputEvent[] {
    this.buf += chunk;
    return this.parse(false);
  }

  /** Nothing more arrived: report a buffered lone Esc, end an unfinished paste. */
  flush(): InputEvent[] {
    return this.parse(true);
  }

  /** True when `flush()` should be called if no more input arrives. */
  get pending(): boolean {
    return this.pasting || this.buf.length > 0;
  }

  /** How long to wait before `flush()`. */
  waitMs(): number {
    return this.pasting ? PASTE_WAIT_MS : ESC_WAIT_MS;
  }

  private parse(final: boolean): InputEvent[] {
    const out: InputEvent[] = [];
    const key = (k: Key) => out.push({ kind: 'key', key: k });
    let b = this.buf;
    let i = 0;
    while (i < b.length) {
      if (this.pasting) {
        const end = b.indexOf(PASTE_END, i);
        if (end < 0) {
          // Keep a possibly split end marker for the next chunk.
          let keep = 0;
          for (let n = Math.min(PASTE_END.length - 1, b.length - i); n > 0; n--) {
            if (PASTE_END.startsWith(b.slice(b.length - n))) {
              keep = n;
              break;
            }
          }
          this.addPaste(b.slice(i, b.length - keep));
          i = b.length - keep;
          if (final) {
            // The terminal never sent the end marker: end the paste here.
            this.addPaste(b.slice(i));
            i = b.length;
            out.push({ kind: 'paste', text: this.pasted });
            this.pasting = false;
            this.pasted = '';
          }
          break;
        }
        this.addPaste(b.slice(i, end));
        out.push({ kind: 'paste', text: this.pasted });
        this.pasting = false;
        this.pasted = '';
        i = end + PASTE_END.length;
        continue;
      }
      const c = b[i];
      if (c === '\x1b') {
        const next = b[i + 1];
        if (next === undefined) {
          if (!final) break; // maybe the start of a sequence: wait for more
          key('escape');
          i += 1;
          continue;
        }
        if (next === '[' || next === 'O') {
          const m = SEQUENCE.exec(b.slice(i));
          if (!m) {
            // Maybe a sequence still arriving: wait for the rest. If nothing more comes
            // (or it is not a sequence), it was Esc typed before "[" or "O".
            if (!final && PARTIAL.test(b.slice(i))) break;
            key('escape');
            i += 1;
            continue;
          }
          i += m[0].length;
          if (m[4] !== undefined) {
            const k = CSI_FINAL[m[4]];
            if (k) key(k);
            continue;
          }
          const params = m[1] ?? '';
          const fin = m[3];
          if (fin === '~') {
            const first = params.split(';')[0];
            if (first === '200') {
              this.pasting = true;
              this.pasted = '';
              continue;
            }
            const k = CSI_TILDE[first];
            if (k) key(k);
            continue;
          }
          const k = CSI_FINAL[fin];
          if (k) key(k);
          continue;
        }
        // Esc then an ordinary key (Alt+key, or a fast Esc before a key): both count.
        key('escape');
        i += 1;
        continue;
      }
      const named = CONTROL[c];
      if (named) {
        key(named);
        i += c === '\r' && b[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      const cp = b.codePointAt(i) ?? 0;
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      if (printableChar(ch)) key(ch);
    }
    b = b.slice(i);
    this.buf = b;
    if (final && this.pasting && !b) {
      out.push({ kind: 'paste', text: this.pasted });
      this.pasting = false;
      this.pasted = '';
    }
    return out;
  }

  private addPaste(text: string): void {
    if (this.pasted.length < PASTE_MAX) this.pasted = (this.pasted + text).slice(0, PASTE_MAX);
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Treat a burst that is exactly one address as a paste, for terminals without bracketed
 * paste: nobody types 42 characters within one read, and as keys it would run shortcuts.
 * Other bursts stay keys (scripts and fast typists send a few keys per read).
 */
export function coalesceBurst(events: InputEvent[]): InputEvent[] {
  if (events.length < 42 || !events.every((e) => e.kind === 'key')) return events;
  const keys = events.map((e) => (e.kind === 'key' ? e.key : ''));
  const text = keys.join('');
  if (keys.every((k) => k.length === 1) && ADDRESS.test(text.trim())) {
    return [{ kind: 'paste', text }];
  }
  return events;
}

/** True when a chunk produced several printable keys (a burst: script, paste or fast typing). */
export function isBurst(events: InputEvent[]): boolean {
  return events.filter((e) => e.kind === 'key' && Array.from(e.key).length === 1).length > 1;
}
