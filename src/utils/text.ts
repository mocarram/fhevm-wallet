/**
 * Characters that must never reach the terminal or a log from untrusted text.
 *
 * - C0/C1 control characters, which include ESC (terminal escape sequences) and line
 *   breaks (forged log lines);
 * - U+2028/U+2029 line and paragraph separators (line breaks to some viewers);
 * - bidi controls (U+061C, U+200E/F, U+202A-E, U+2066-9), which can visually reorder an
 *   address or amount;
 * - zero-width and invisible characters (U+200B-D, U+2060-4, U+FEFF), which can hide text
 *   or make two different strings look identical, and other characters that render as
 *   nothing or as blank space: soft hyphen U+00AD, combining grapheme joiner U+034F,
 *   Mongolian vowel separator U+180E, Hangul fillers U+115F, U+1160, U+3164, U+FFA0, and
 *   the tag characters U+E0000-E007F (which can smuggle hidden text).
 */
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\u{E0000}-\u{E007F}]|\u034f/gu;

/** Replace every unsafe character in `text` with a space. */
export function stripUnsafeChars(text: string): string {
  return text.replace(UNSAFE_CHARS, ' ');
}
