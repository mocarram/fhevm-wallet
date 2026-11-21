import { describe, expect, it } from 'vitest';
import { formatAddress, formatNetworkName, formatTokenAmount } from '../../src/utils/formatting.js';

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

describe('formatTokenAmount', () => {
  it('formats whole and fractional values', () => {
    expect(formatTokenAmount(100_000_000n, 6)).toBe('100');
    expect(formatTokenAmount(1_250_000n, 6)).toBe('1.25');
  });

  it('truncates fractional precision in formatting', () => {
    expect(formatTokenAmount(1_234_567n, 6, 2)).toBe('1.23');
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
