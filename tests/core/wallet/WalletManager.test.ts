import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWallet,
  exportWalletPrivateKey,
  getWalletAddress,
  hasWallet,
  importWalletFromMnemonic,
  importWalletFromPrivateKey,
  listWallets,
  loadWallet,
  removeWallet,
} from '../../../src/core/wallet/WalletManager.js';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const PASSWORD = 'test-password-1234';
const KNOWN_MNEMONIC = 'test test test test test test test test test test test junk';
const KNOWN_PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

beforeEach(() => {
  wipeTestDataDir();
});

describe('WalletManager', () => {
  it('creates, lists, loads, exports, and removes a wallet', async () => {
    const created = await createWallet('main', PASSWORD);
    expect(hasWallet('main')).toBe(true);
    expect(getWalletAddress('main')).toBe(created.address);

    const list = listWallets();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('main');

    const wallet = await loadWallet('main', PASSWORD);
    expect(wallet.address).toBe(created.address);

    const pk = await exportWalletPrivateKey('main', PASSWORD);
    expect(pk).toMatch(/^0x[0-9a-fA-F]{64}$/);

    expect(removeWallet('main')).toBe(true);
    expect(hasWallet('main')).toBe(false);
  });

  it('rejects duplicate names on create', async () => {
    await createWallet('main', PASSWORD);
    await expect(createWallet('main', PASSWORD)).rejects.toThrow(/already exists/);
  });

  it('imports from mnemonic and private key with deterministic addresses', async () => {
    const fromMnemonic = await importWalletFromMnemonic('m', KNOWN_MNEMONIC, PASSWORD);
    const fromPk = await importWalletFromPrivateKey('p', KNOWN_PRIVATE_KEY, PASSWORD);

    expect(fromMnemonic).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(fromPk).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(fromMnemonic).not.toBe(fromPk);
  });

  it('loadWallet wraps wrong-password errors as "Invalid password"', async () => {
    await createWallet('main', PASSWORD);
    await expect(loadWallet('main', 'wrong-password')).rejects.toThrow('Invalid password');
  });
});
