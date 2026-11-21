import { describe, expect, it } from 'vitest';
import {
  formatAddress,
  formatNetworkName,
  formatTokenAmount,
  parseTokenAmount,
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

  it('rejects excess decimals instead of truncating', () => {
    expect(() => parseTokenAmount('1.123456789', 6)).toThrow(/Too many decimal places/);
  });

  it('rejects signs, spaces inside and exponent notation', () => {
    for (const bad of ['-1', '1e6', '1 000', '.5', '1.']) {
      expect(() => parseTokenAmount(bad, 6)).toThrow(/Invalid amount format/);
    }
  });

  it('throws on multiple decimal points', () => {
    expect(() => parseTokenAmount('1.2.3', 6)).toThrow(/Invalid amount format/);
  });
});

describe('NO_COLOR', () => {
  it('drops table colours and turns chalk off', async () => {
    const { default: Table } = await import('cli-table3');
    const { default: chalk } = await import('chalk');
    const { applyNoColor, tableStyle } = await import('../../src/utils/formatting.js');
    expect(tableStyle({})).toEqual({ head: ['cyan'], border: ['grey'] });
    expect(tableStyle({ NO_COLOR: '' }).head).toEqual(['cyan']);
    const t = new Table({ head: ['Symbol'], style: tableStyle({ NO_COLOR: '1' }) });
    t.push(['cUSDC']);
    // eslint-disable-next-line no-control-regex
    expect(t.toString()).not.toMatch(/\x1b\[/);
    const level = chalk.level;
    try {
      chalk.level = 1;
      applyNoColor({ NO_COLOR: '1' });
      expect(chalk.level).toBe(0);
    } finally {
      chalk.level = level;
    }
  });
});
