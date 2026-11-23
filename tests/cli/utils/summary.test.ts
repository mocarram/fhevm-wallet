/** CLI summaries (L5): one value column, short fees, checksummed history, wallet addresses. */
import { describe, expect, it } from 'vitest';
import { alignLabels } from '../../../src/cli/utils/txFlow.js';
import { formatEthBalance, formatEthFee } from '../../../src/core/send/amount.js';
import { getDirectionInfo } from '../../../src/cli/commands/history.js';
import { describeNonCompliant } from '../../../src/core/token/erc7984Check.js';

describe('CLI summary formatting (L5)', () => {
  it('aligns "Label: value" rows whatever their own padding', () => {
    const rows = alignLabels([
      'Token:    cUSDC',
      'Operator: 0xabc',
      'Network: Sepolia',
      'Fee: up to 1',
    ]);
    const cols = rows.map((r) => r.search(/(?<=: +)\S/));
    expect(new Set(cols).size).toBe(1);
    expect(rows[2]).toBe('Network:  Sepolia');
    expect(alignLabels(['  continued line'])).toEqual(['  continued line']);
  });

  it('fees and balances are not printed with 18 decimals', () => {
    // Rounded up: the fee is printed as "up to", so 0.000123 ETH must not read 0.0001.
    expect(formatEthFee(123_456_789_012_345n)).toBe('0.0002');
    expect(formatEthFee(21_000_000_000_000n)).toBe('0.000021');
    expect(formatEthBalance(421_000_000_000_000_000n)).toBe('0.4210');
  });

  it('history shows the counterparty checksummed, even when stored lowercase', () => {
    const me = '0x52908400098527886E0F7030069857D2E4169EE7';
    const other = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'; // checksum: 0xfB6916…
    const { label } = getDirectionInfo(
      { from: me.toLowerCase(), to: other, type: 'transfer' } as never,
      me,
    );
    expect(label.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/0xfB6916/); // eslint-disable-line no-control-regex
  });

  it('a wallet address added as a token says so, without "failed the check"', () => {
    const d = describeNonCompliant(
      {
        address: '0x6e1d3a0B7C25F9e84d1a6b3c0e7F52a9d8c194fa',
        info: null,
        erc165: 'absent',
        balanceHandle: false,
        compliant: false,
        problems: [],
        warnings: [],
        hasCode: false,
      },
      'sepolia',
    );
    expect(d.title).toMatch(
      /There is no contract at 0x6e1d.* on sepolia: it is a wallet address, not a token\./,
    );
  });
});
