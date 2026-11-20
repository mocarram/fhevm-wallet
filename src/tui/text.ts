/**
 * Styled text for the TUI. Screens build `Line`s out of `Seg`ments with a semantic style;
 * the terminal shell turns them into ANSI, tests turn them into plain strings. Keeping
 * colour out of screen code means render output can be asserted without escape codes.
 */

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
  net: '48;5;24;97',
  mainnet: '41;97;1',
  low: '43;30',
  pending: '48;5;94;97',
  mock: '45;97;1',
  secret: '47;30',
  big: '1',
  cursor: '7',
};

/**
 * Convert a line to an ANSI string. With `color` false only the text is kept, except
 * that selection and the cursor stay visible via reverse video (they carry meaning).
 */
export function toAnsi(l: Line, color: boolean): string {
  return l
    .map((s) => {
      const styles = s.s ?? [];
      const codes = color
        ? styles.map((st) => CODES[st])
        : styles.filter((st) => st === 'sel' || st === 'cursor').map((st) => CODES[st]);
      return codes.length ? `${ESC}${codes.join(';')}m${s.t}${ESC}0m` : s.t;
    })
    .join('');
}
