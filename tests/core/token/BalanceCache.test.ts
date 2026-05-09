import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearBalanceCache,
  getCachedBalance,
  invalidateBalance,
  setCachedBalance,
} from '../../../src/core/token/BalanceCache.js';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const TOKEN = '0xde709f2102306220921060314715629080e2fb77';

beforeEach(() => {
  wipeTestDataDir();
});

describe('BalanceCache', () => {
  it('returns null when nothing is cached', () => {
    expect(getCachedBalance(WALLET, TOKEN, 'sepolia', 1n)).toBeNull();
  });

  it('returns the cached value when handle matches', () => {
    setCachedBalance(WALLET, TOKEN, 'sepolia', 100n, 5_000n);
    expect(getCachedBalance(WALLET, TOKEN, 'sepolia', 100n)).toBe(5_000n);
  });

  it('invalidates when handle changes', () => {
    setCachedBalance(WALLET, TOKEN, 'sepolia', 100n, 5_000n);
    expect(getCachedBalance(WALLET, TOKEN, 'sepolia', 101n)).toBeNull();
  });

  it('invalidateBalance removes only the targeted entry', () => {
    setCachedBalance(WALLET, TOKEN, 'sepolia', 100n, 5_000n);
    setCachedBalance(WALLET, TOKEN, 'mainnet', 200n, 9_000n);

    invalidateBalance(WALLET, TOKEN, 'sepolia');
    expect(getCachedBalance(WALLET, TOKEN, 'sepolia', 100n)).toBeNull();
    expect(getCachedBalance(WALLET, TOKEN, 'mainnet', 200n)).toBe(9_000n);
  });

  it('clearBalanceCache wipes everything', () => {
    setCachedBalance(WALLET, TOKEN, 'sepolia', 100n, 5_000n);
    clearBalanceCache();
    expect(getCachedBalance(WALLET, TOKEN, 'sepolia', 100n)).toBeNull();
  });

  it('keys are case-insensitive on addresses', () => {
    setCachedBalance(WALLET.toLowerCase(), TOKEN.toLowerCase(), 'sepolia', 100n, 5_000n);
    expect(getCachedBalance(WALLET.toUpperCase(), TOKEN.toUpperCase(), 'sepolia', 100n)).toBe(
      5_000n,
    );
  });
});
