import { describe, expect, it } from 'vitest';
import { describeBalanceCheck } from '../../../src/cli/utils/transferReport.js';

const base = { txHash: '0x', receipt: {} as never };

describe('describeBalanceCheck', () => {
  it('confirms a balance that moved, with the new balance', () => {
    const lines = describeBalanceCheck(
      { ...base, balanceCheck: 'moved', balanceAfter: 1_500_000n },
      'cUSDC',
      6,
    );
    expect(lines.join(' ')).toMatch(/went down by the amount sent.*1\.5 cUSDC/);
  });

  it('warns when the transfer moved nothing', () => {
    expect(
      describeBalanceCheck({ ...base, balanceCheck: 'unchanged' }, 'cUSDC', 6).join(' '),
    ).toMatch(/did not change/);
  });

  it('is honest when the balance could not be re-checked', () => {
    expect(
      describeBalanceCheck({ ...base, balanceCheck: 'unknown' }, 'cUSDC', 6).join(' '),
    ).toMatch(/Couldn't re-check/);
  });
});
