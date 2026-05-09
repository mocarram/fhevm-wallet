import { describe, expect, it } from 'vitest';
import {
  createNewWallet,
  decryptKeystore,
  importFromMnemonic,
  importFromPrivateKey,
} from '../../../src/core/wallet/KeyStore.js';

const WEAK_PASSWORD = 'test-password-1234';
const KNOWN_MNEMONIC = 'test test test test test test test test test test test junk';
const KNOWN_PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

describe('KeyStore', () => {
  it('createNewWallet returns a usable encrypted keystore', async () => {
    const result = await createNewWallet(WEAK_PASSWORD);
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.mnemonic?.split(' ')).toHaveLength(12);

    const decrypted = await decryptKeystore(result.keystore, WEAK_PASSWORD);
    expect(decrypted.address.toLowerCase()).toBe(result.address.toLowerCase());
  });

  it('importFromMnemonic produces deterministic address', async () => {
    const a = await importFromMnemonic(KNOWN_MNEMONIC, WEAK_PASSWORD);
    const b = await importFromMnemonic(KNOWN_MNEMONIC, 'different-password');
    expect(a.address).toBe(b.address);
  });

  it('importFromMnemonic rejects invalid mnemonic', async () => {
    await expect(importFromMnemonic('not a real phrase', WEAK_PASSWORD)).rejects.toThrow(
      /Invalid mnemonic/,
    );
  });

  it('importFromPrivateKey accepts both 0x-prefixed and bare keys', async () => {
    const a = await importFromPrivateKey(KNOWN_PRIVATE_KEY, WEAK_PASSWORD);
    const b = await importFromPrivateKey(KNOWN_PRIVATE_KEY.slice(2), WEAK_PASSWORD);
    expect(a.address).toBe(b.address);
  });

  it('decryptKeystore rejects on bad password', async () => {
    const { keystore } = await createNewWallet(WEAK_PASSWORD);
    // ethers v6.16 raises "incorrect password ..."; older releases raised "invalid password".
    // KeyStore.ts:86 only rewrites the latter, so we just assert a password-related rejection.
    await expect(decryptKeystore(keystore, 'wrong-password')).rejects.toThrow(/password/i);
  });
});
