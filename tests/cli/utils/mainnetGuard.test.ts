import { describe, expect, it } from 'vitest';
import { mainnetGuardProblem } from '../../../src/cli/utils/mainnetGuard.js';

describe('mainnetGuardProblem', () => {
  const base = { network: 'mainnet' as const, willAsk: false };
  it('refuses Mainnet without confirmation unless -n mainnet and --mainnet are both given', () => {
    expect(mainnetGuardProblem(base)).toMatch(/Nothing was sent/);
    expect(mainnetGuardProblem({ ...base, networkOption: 'mainnet' })).not.toBeNull();
    expect(mainnetGuardProblem({ ...base, mainnetFlag: true })).not.toBeNull();
    expect(
      mainnetGuardProblem({ ...base, networkOption: 'mainnet', mainnetFlag: true }),
    ).toBeNull();
  });
  it('leaves interactive Mainnet sends and Sepolia alone', () => {
    expect(mainnetGuardProblem({ ...base, willAsk: true })).toBeNull();
    expect(mainnetGuardProblem({ network: 'sepolia', willAsk: false })).toBeNull();
  });
});

describe('mainnetGuardProblem wording', () => {
  it('names what the command would do', () => {
    expect(
      mainnetGuardProblem({ network: 'mainnet', willAsk: false, what: 'change an operator' }),
    ).toMatch(/^Nothing was sent: this would change an operator without asking you\./);
  });
});
