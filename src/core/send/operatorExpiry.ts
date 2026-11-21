/**
 * Friendly operator expiries for `setOperator(operator, until)`.
 *
 * An ERC-7984 operator can move *all* of the holder's tokens until `until` (a uint48
 * unix time in seconds). So the wallet offers short, explicit durations and never a
 * silent "forever": `forever` (the largest uint48) is only accepted together with a
 * typed confirmation, which the callers ask for.
 */

/** Largest uint48: what "forever" means on-chain. */
export const OPERATOR_FOREVER = 2 ** 48 - 1;

/** The word the user must type to grant an operator without expiry. */
export const FOREVER_CONFIRMATION = 'forever';

/** Durations offered in menus. */
export const EXPIRY_CHOICES = [
  { text: '1h', label: '1 hour' },
  { text: '1d', label: '1 day' },
  { text: '7d', label: '7 days' },
] as const;

/** Parsed expiry: unix seconds, and whether it is "forever". */
export type ExpiryResult =
  { ok: true; until: number; forever: boolean } | { ok: false; error: string; hint: string };

const UNIT_S: Record<string, number> = { m: 60, h: 3600, d: 86_400, w: 7 * 86_400 };

/**
 * Longest expiry accepted without typing "forever", for durations and dates alike.
 * A far-off date (9999-12-31) is "forever" in all but name, and it would slip past the
 * typed confirmation and the TTY-only rule that guard "forever".
 */
export const MAX_OPERATOR_EXPIRY_S = 366 * 86_400;

/**
 * Parse `1h`, `30m`, `1d`, `7d`, `2w`, an ISO date (`2026-12-01`) or date-time
 * (`2026-12-01T18:00`, local time), or `forever`. `nowMs` is the current time.
 */
export function parseOperatorExpiry(input: string, nowMs: number): ExpiryResult {
  const text = input.trim().toLowerCase();
  const nowS = Math.floor(nowMs / 1000);
  if (!text) {
    return {
      ok: false,
      error: 'Enter how long the operator may act.',
      hint: 'For example: 1h, 1d, 7d or 2026-12-01.',
    };
  }
  if (text === FOREVER_CONFIRMATION || text === 'never') {
    return { ok: true, until: OPERATOR_FOREVER, forever: true };
  }
  const rel = /^(\d{1,4})\s*([mhdw])$/.exec(text);
  if (rel) {
    const secs = Number(rel[1]) * UNIT_S[rel[2]];
    if (secs <= 0)
      return {
        ok: false,
        error: 'The duration must be above zero.',
        hint: 'For example: 1h or 7d.',
      };
    if (secs > MAX_OPERATOR_EXPIRY_S) {
      return {
        ok: false,
        error: 'That is more than a year.',
        hint: 'Pick a shorter time, or type "forever" if you really mean no expiry.',
      };
    }
    return { ok: true, until: nowS + secs, forever: false };
  }
  if (/^\d{4}-\d{2}-\d{2}(t\d{2}:\d{2})?$/.test(text)) {
    // A bare date means the end of that day, local time.
    const ms = text.includes('t')
      ? new Date(text.replace('t', 'T')).getTime()
      : new Date(`${text}T23:59:59`).getTime();
    if (Number.isNaN(ms))
      return { ok: false, error: 'That date does not exist.', hint: 'Use YYYY-MM-DD.' };
    const until = Math.floor(ms / 1000);
    if (until <= nowS)
      return { ok: false, error: 'That date is in the past.', hint: 'Pick a later date.' };
    if (until - nowS > MAX_OPERATOR_EXPIRY_S) {
      return {
        ok: false,
        error: 'That date is more than a year away.',
        hint: 'Pick an earlier date, or type "forever" if you really mean no expiry.',
      };
    }
    return { ok: true, until, forever: false };
  }
  return {
    ok: false,
    error: `"${input.trim()}" is not a duration or a date.`,
    hint: 'Use 1h, 1d, 7d, a date like 2026-12-01, or "forever".',
  };
}

/** "until Nov 22 14:05" (local), "with no expiry" or "now (revoked)". */
export function describeExpiry(until: number): string {
  if (until === 0) return 'revoked';
  if (until >= OPERATOR_FOREVER) return 'with no expiry';
  const d = new Date(until * 1000);
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `until ${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} ${hh}:${mm}`;
}

/** The warning shown before granting an operator, as plain lines. */
export function operatorWarning(symbol: string, until: number): string[] {
  return [
    `An operator can move ALL of your ${symbol}, to anyone, without asking you again,`,
    `${describeExpiry(until)}. Only grant this to a contract or person you fully trust.`,
    'You can revoke it at any time (that is another transaction).',
  ];
}
