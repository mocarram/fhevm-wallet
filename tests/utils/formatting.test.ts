import { describe, expect, it } from 'vitest';
import {
  formatAddress,
  formatNetworkName,
  formatTokenAmount,
  parseTokenAmount,
  shortErrorMessage,
} from '../../src/utils/formatting.js';

describe('formatNetworkName', () => {
  it('appends beta tag for mainnet only', () => {
    expect(formatNetworkName('mainnet')).toBe('mainnet (beta)');
    expect(formatNetworkName('sepolia')).toBe('sepolia');
  });
});

describe('formatAddress', () => {
  const addr = '0x52908400098527886E0F7030069857D2E4169EE7';

  it('shortens long addresses', () => {
    expect(formatAddress(addr)).toBe('0x52908400...E4169EE7');
  });

  it('honors a custom length parameter', () => {
    expect(formatAddress(addr, 4)).toBe('0x5290...9EE7');
  });

  it('returns short addresses unchanged', () => {
    expect(formatAddress('0xabc')).toBe('0xabc');
  });
});

describe('formatTokenAmount / parseTokenAmount', () => {
  it('round-trips whole values', () => {
    const raw = parseTokenAmount('100', 6);
    expect(raw).toBe(100_000_000n);
    expect(formatTokenAmount(raw, 6)).toBe('100');
  });

  it('round-trips fractional values', () => {
    const raw = parseTokenAmount('1.25', 6);
    expect(raw).toBe(1_250_000n);
    expect(formatTokenAmount(raw, 6)).toBe('1.25');
  });

  it('truncates fractional precision in formatting', () => {
    expect(formatTokenAmount(1_234_567n, 6, 2)).toBe('1.23');
  });

  it('truncates excess decimals in parsing', () => {
    expect(parseTokenAmount('1.123456789', 6)).toBe(1_123_456n);
  });

  it('throws on multiple decimal points', () => {
    expect(() => parseTokenAmount('1.2.3', 6)).toThrow(/Invalid amount format/);
  });
});

describe('shortErrorMessage', () => {
  it('returns "Failed" for non-Error inputs', () => {
    expect(shortErrorMessage('boom')).toBe('Failed');
    expect(shortErrorMessage(undefined)).toBe('Failed');
  });

  it('extracts an unexpected-status code', () => {
    expect(shortErrorMessage(new Error('Unexpected response status 503 from relayer'))).toBe(
      'HTTP 503',
    );
  });

  it('extracts a generic status code', () => {
    expect(shortErrorMessage(new Error('Request failed with status: 404 Not Found'))).toBe(
      'HTTP 404',
    );
  });

  it('returns first line for plain errors', () => {
    expect(shortErrorMessage(new Error('first line\nsecond line'))).toBe('first line');
  });
});
