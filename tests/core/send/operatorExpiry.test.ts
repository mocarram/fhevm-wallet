import { describe, expect, it } from 'vitest';
import {
  describeExpiry,
  OPERATOR_FOREVER,
  parseOperatorExpiry,
} from '../../../src/core/send/operatorExpiry.js';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const nowS = NOW / 1000;

describe('parseOperatorExpiry', () => {
  it('reads friendly durations', () => {
    expect(parseOperatorExpiry('1h', NOW)).toEqual({
      ok: true,
      until: nowS + 3600,
      forever: false,
    });
    expect(parseOperatorExpiry('1d', NOW)).toMatchObject({ until: nowS + 86_400 });
    expect(parseOperatorExpiry(' 7D ', NOW)).toMatchObject({ until: nowS + 7 * 86_400 });
    expect(parseOperatorExpiry('30m', NOW)).toMatchObject({ until: nowS + 1800 });
  });

  it('reads dates and refuses past or impossible ones', () => {
    const r = parseOperatorExpiry('2026-12-01', NOW);
    expect(r.ok && r.until > nowS).toBe(true);
    expect(parseOperatorExpiry('2020-01-01', NOW)).toMatchObject({ ok: false });
    expect(parseOperatorExpiry('2026-13-45', NOW)).toMatchObject({ ok: false });
  });

  it('refuses dates more than a year away so "forever" stays typed', () => {
    // Regression: `--for 9999-12-31 --yes` granted an effectively unlimited operator
    // without the typed "forever" confirmation.
    expect(parseOperatorExpiry('9999-12-31', NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/more than a year/),
    });
    expect(parseOperatorExpiry('2028-01-01', NOW)).toMatchObject({ ok: false });
    expect(parseOperatorExpiry('2027-11-01', NOW)).toMatchObject({ ok: true, forever: false });
  });

  it('marks forever explicitly and refuses junk and over a year', () => {
    expect(parseOperatorExpiry('forever', NOW)).toEqual({
      ok: true,
      until: OPERATOR_FOREVER,
      forever: true,
    });
    expect(parseOperatorExpiry('400d', NOW)).toMatchObject({ ok: false });
    expect(parseOperatorExpiry('soon', NOW)).toMatchObject({ ok: false });
    expect(parseOperatorExpiry('0h', NOW)).toMatchObject({ ok: false });
  });

  it('describes expiries', () => {
    expect(describeExpiry(0)).toBe('revoked');
    expect(describeExpiry(OPERATOR_FOREVER)).toBe('with no expiry');
    expect(describeExpiry(nowS)).toMatch(/^until Nov 2\d 2026 \d\d:\d\d$/);
  });
});
