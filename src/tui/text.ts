/**
 * Styled text for the TUI. Screens build `Line`s out of `Seg`ments with a semantic style;
 * the terminal shell turns them into ANSI, tests turn them into plain strings. Keeping
 * colour out of screen code means render output can be asserted without escape codes.
 */

import { stripUnsafeChars } from '../utils/text.js';

/** Semantic styles, mapped to colours in `toAnsi`. */
export type Style =
  | 'dim'
  | 'bold'
  | 'green'
  | 'yellow'
  | 'red'
  | 'cyan'
  | 'sel'
  | 'bar'
  | 'brand'
  | 'wallet'
  | 'walletAddr'
  | 'unlocked'
  | 'locked'
  | 'eth'
  | 'ethLoading'
  | 'net'
  | 'mainnet'
  | 'low'
  | 'pending'
  | 'mock'
  | 'secret'
  | 'big'
  | 'cursor';

/** A run of text with one or more styles. */
export interface Seg {
  t: string;
  s?: Style[];
  /**
   * A link: drawn as an OSC 8 hyperlink to this URL (the text may be shortened to fit
   * the row; clicking it opens the full URL in terminals that support links).
   */
  href?: string;
}

/** One terminal row. */
export type Line = Seg[];

/** Make a segment. `styles` may be a space-separated list, e.g. 'green bold'. */
export function seg(t: string, styles?: string): Seg {
  return styles ? { t, s: styles.split(' ').filter(Boolean) as Style[] } : { t };
}

/** Build a line from strings (unstyled) and segments. */
export function line(...parts: Array<string | Seg>): Line {
  return parts.map((p) => (typeof p === 'string' ? { t: p } : p));
}

/** A link segment showing `url` (see `Seg.href`). */
export function link(url: string, styles?: string): Seg {
  return { ...seg(url, styles), href: url };
}

/** `text` cut in the middle to `n` columns ("https://sepolia.ether…/tx/0x12…cd34"). */
function shortenMiddle(text: string, n: number): string {
  const chars = Array.from(text);
  if (chars.length <= n) return text;
  if (n <= 1) return '…';
  const tail = Math.floor((n - 1) / 3);
  return chars.slice(0, n - 1 - tail).join('') + '…' + chars.slice(chars.length - tail).join('');
}

/** A line of dim text, the most common "explanation" style. */
export function dimLine(text: string): Line {
  return [seg(text, 'dim')];
}

/** Display width of a string. Counts code points; the UI avoids wide characters. */
export function width(text: string): number {
  return Array.from(text).length;
}

/** Display width of a line. */
export function lineWidth(l: Line): number {
  return l.reduce((n, s) => n + width(s.t), 0);
}

/** Pad on the right to `n` columns (never truncates). */
export function pad(text: string, n: number): string {
  const w = width(text);
  return w >= n ? text : text + ' '.repeat(n - w);
}

/** Pad on the left to `n` columns. */
export function padLeft(text: string, n: number): string {
  const w = width(text);
  return w >= n ? text : ' '.repeat(n - w) + text;
}

/** Cut a line to at most `cols` columns, ending in `…` when something was cut. */
export function clipLine(l: Line, cols: number): Line {
  if (cols <= 0) return [];
  if (lineWidth(l) <= cols) return l;
  const out: Line = [];
  let left = cols - 1;
  for (const s of l) {
    if (left <= 0) break;
    const chars = Array.from(s.t);
    out.push({ ...s, t: chars.slice(0, left).join('') });
    left -= Math.min(left, chars.length);
  }
  out.push(seg('…', 'dim'));
  return out;
}

/** Plain text of a line, for tests and non-colour output. */
export function plain(l: Line): string {
  return l.map((s) => s.t).join('');
}

const ESC = '\x1b[';
const CODES: Record<Style, string> = {
  dim: '2',
  bold: '1',
  green: '32',
  yellow: '33',
  red: '31',
  cyan: '36',
  sel: '7',
  bar: '48;5;236;37',
  // Status bar pills (approved design "B · Pills"): each part on its own block so the
  // eye finds it without reading. 256-colour backgrounds, bright white text.
  brand: '48;5;238;97;1',
  wallet: '48;5;238;97;1',
  walletAddr: '48;5;238;38;5;250',
  unlocked: '48;5;22;97',
  // Same brown as `pending` on purpose (the approved preview); the words tell them apart.
  locked: '48;5;94;97',
  eth: '48;5;61;97;1',
  // Not bold + faint at once (terminals disagree on that pair): a softer text colour.
  ethLoading: '48;5;61;38;5;250',
  net: '48;5;24;97',
  mainnet: '41;97;1',
  low: '43;30',
  pending: '48;5;94;97',
  // Bold bright yellow on magenta; also kept (as reverse video) without colour.
  mock: '45;93;1',
  secret: '47;30',
  big: '1',
  cursor: '7',
};

/**
 * Convert a line to an ANSI string. With `color` false only the text is kept, except
 * that selection, the cursor and the MOCK badge stay visible via reverse video (they
 * carry meaning).
 */
export function toAnsi(l: Line, color: boolean): string {
  return l
    .map((raw) => {
      // Last line of defence: no segment (contact names, token symbols, error text) may
      // carry control, bidi or invisible characters to the terminal. Each is replaced by
      // one space, so column widths stay as measured.
      const s = { ...raw, t: stripUnsafeChars(raw.t) };
      const styles = s.s ?? [];
      const codes = color
        ? styles.map((st) => CODES[st])
        : styles
            .filter((st) => st === 'sel' || st === 'cursor' || st === 'mock')
            .map((st) => (st === 'mock' ? '7;1' : CODES[st]));
      const text = codes.length ? `${ESC}${codes.join(';')}m${s.t}${ESC}0m` : s.t;
      // OSC 8 hyperlink (BEL-terminated). The URL is printable ASCII only, so it cannot
      // end the sequence early or carry other escapes.
      if (raw.href && color) {
        const href = Array.from(raw.href)
          .filter((c) => c >= '!' && c <= '~')
          .join('');
        return `\x1b]8;;${href}\x07${text}\x1b]8;;\x07`;
      }
      return text;
    })
    .join('');
}

/**
 * Wrap a line to `cols` columns instead of cutting it, so nothing (an explorer link, a
 * hint) is lost on a narrow terminal. Breaks after a space when there is one in the last
 * third of the row, otherwise mid-word (hashes and URLs have no spaces). Continuation
 * rows are indented by two spaces and keep each segment's style.
 */
export function wrapLine(l: Line, cols: number): Line[] {
  if (cols <= 4 || lineWidth(l) <= cols) return [l];
  // A link is never broken across rows (an explorer URL in two pieces cannot be copied
  // or clicked): it is shortened in the middle instead and stays clickable (OSC 8).
  const links = l.filter((sg) => sg.href);
  if (links.length) {
    const over = lineWidth(l) - cols;
    const room = links.reduce((n, sg) => n + width(sg.t), 0) - over;
    if (room >= 12 * links.length) {
      const each = Math.floor(room / links.length);
      const fitted = l.map((sg) => (sg.href ? { ...sg, t: shortenMiddle(sg.t, each) } : sg));
      if (lineWidth(fitted) <= cols) return [fitted];
    }
  }
  // Flatten to styled characters, then cut rows.
  const chars: Array<{ c: string; s?: Style[] }> = [];
  for (const sg of l) for (const c of Array.from(sg.t)) chars.push({ c, s: sg.s });
  const rows: Line[] = [];
  let i = 0;
  let first = true;
  while (i < chars.length) {
    // A continuation never starts with the space it was cut at: it would sit one column
    // right of the first row's text.
    if (!first) while (i < chars.length && chars[i].c === ' ') i++;
    if (i >= chars.length) break;
    const room = first ? cols : cols - 2;
    let end = Math.min(chars.length, i + room);
    if (end < chars.length) {
      for (let j = end; j > i + Math.floor((room * 2) / 3); j--) {
        if (chars[j - 1].c === ' ') {
          end = j;
          break;
        }
      }
    }
    const row: Line = first ? [] : [{ t: '  ' }];
    for (const ch of chars.slice(i, end)) {
      const last = row[row.length - 1];
      if (last && last.s === ch.s) last.t += ch.c;
      else row.push({ t: ch.c, s: ch.s });
    }
    rows.push(row);
    i = end;
    first = false;
  }
  return rows;
}
