import { describe, expect, it } from 'vitest';
import {
  isValidAddress,
  isValidAmount,
  isValidContactName,
  isValidMnemonic,
  isValidNetwork,
  isValidPrivateKey,
  isValidWalletName,
} from '../../src/utils/validation.js';

describe('isValidAddress', () => {
  it('accepts a checksummed Ethereum address', () => {
    expect(isValidAddress('0x52908400098527886E0F7030069857D2E4169EE7')).toBe(true);
  });

  it('rejects a malformed address', () => {
    expect(isValidAddress('0xnotahex')).toBe(false);
    expect(isValidAddress('')).toBe(false);
  });
});

describe('isValidMnemonic', () => {
  it('accepts a known-valid 12-word mnemonic', () => {
    expect(isValidMnemonic('test test test test test test test test test test test junk')).toBe(
      true,
    );
  });

  it('rejects gibberish', () => {
    expect(isValidMnemonic('not a valid phrase at all')).toBe(false);
  });
});

describe('isValidPrivateKey', () => {
  it('accepts a 64-char hex with or without 0x prefix', () => {
    const key = 'a'.repeat(64);
    expect(isValidPrivateKey(key)).toBe(true);
    expect(isValidPrivateKey('0x' + key)).toBe(true);
  });

  it('rejects wrong length and non-hex', () => {
    expect(isValidPrivateKey('a'.repeat(63))).toBe(false);
    expect(isValidPrivateKey('z'.repeat(64))).toBe(false);
  });
});

describe('isValidWalletName', () => {
  it.each([
    ['main', true],
    ['my-wallet_1', true],
    ['a'.repeat(32), true],
    ['a'.repeat(33), false],
    ['has space', false],
    ['', false],
    ['has/slash', false],
  ])('isValidWalletName(%s) -> %s', (name, expected) => {
    expect(isValidWalletName(name)).toBe(expected);
  });
});

describe('isValidAmount', () => {
  it('accepts positive integers and decimals', () => {
    expect(isValidAmount('1')).toBe(true);
    expect(isValidAmount('0.5')).toBe(true);
    expect(isValidAmount('1234.5678')).toBe(true);
  });

  it('rejects zero, negatives, and non-numeric', () => {
    expect(isValidAmount('0')).toBe(false);
    expect(isValidAmount('-1')).toBe(false);
    expect(isValidAmount('abc')).toBe(false);
    expect(isValidAmount('')).toBe(false);
  });
});

describe('isValidNetwork', () => {
  it('accepts mainnet and sepolia, rejects others', () => {
    expect(isValidNetwork('mainnet')).toBe(true);
    expect(isValidNetwork('sepolia')).toBe(true);
    expect(isValidNetwork('goerli')).toBe(false);
  });
});

describe('isValidContactName', () => {
  it('accepts alphanumerics and spaces', () => {
    expect(isValidContactName('Alice')).toBe(true);
    expect(isValidContactName('Bob 2')).toBe(true);
  });

  it('rejects empty/whitespace-only and special chars', () => {
    expect(isValidContactName('')).toBe(false);
    expect(isValidContactName('   ')).toBe(false);
    expect(isValidContactName('has/slash')).toBe(false);
  });
});
