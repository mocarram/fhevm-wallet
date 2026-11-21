import { beforeEach, describe, expect, it } from 'vitest';
import {
  listWallets,
  loadWalletKeystore,
  loadWalletMetadata,
  removeWallet,
  saveWalletKeystore,
  walletExists,
} from '../../src/storage/WalletStore.js';
import { wipeTestDataDir, getTestDataDir } from '../helpers/dataDir.js';
import { chmodSync } from 'fs';
import { join } from 'path';

const FAKE_KEYSTORE_JSON = JSON.stringify({ version: 3, id: 'fake' });
const FAKE_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

beforeEach(() => {
  wipeTestDataDir();
});

describe('WalletStore', () => {
  it('shows the keystore address, not an edited .meta.json one', () => {
    const keystore = JSON.stringify({
      version: 3,
      id: 'x',
      address: FAKE_ADDRESS.slice(2).toLowerCase(),
    });
    saveWalletKeystore('main', keystore, '0x000000000000000000000000000000000000dEaD');
    expect(loadWalletMetadata('main')?.address).toBe(FAKE_ADDRESS);
    expect(listWallets()[0].address).toBe(FAKE_ADDRESS);
  });

  it('walletExists returns false for unknown name', () => {
    expect(walletExists('ghost')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    're-checks folder trust before reading a keystore (regression)',
    () => {
      saveWalletKeystore('main', FAKE_KEYSTORE_JSON, FAKE_ADDRESS);
      const wallets = join(getTestDataDir(), 'wallets');
      chmodSync(wallets, 0o777);
      try {
        expect(() => loadWalletKeystore('main')).toThrow(/Other users can change/);
      } finally {
        chmodSync(wallets, 0o700);
      }
      expect(loadWalletKeystore('main')).toBe(FAKE_KEYSTORE_JSON);
    },
  );

  it('saves and loads keystore + metadata', () => {
    saveWalletKeystore('main', FAKE_KEYSTORE_JSON, FAKE_ADDRESS);

    expect(walletExists('main')).toBe(true);
    expect(loadWalletKeystore('main')).toBe(FAKE_KEYSTORE_JSON);

    const meta = loadWalletMetadata('main');
    expect(meta?.name).toBe('main');
    expect(meta?.address).toBe(FAKE_ADDRESS);
    expect(meta?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('listWallets returns all stored wallets', () => {
    saveWalletKeystore('one', FAKE_KEYSTORE_JSON, FAKE_ADDRESS);
    saveWalletKeystore('two', FAKE_KEYSTORE_JSON, FAKE_ADDRESS);

    const names = listWallets()
      .map((w) => w.name)
      .sort();
    expect(names).toEqual(['one', 'two']);
  });

  it('removeWallet deletes both files and is idempotent', () => {
    saveWalletKeystore('main', FAKE_KEYSTORE_JSON, FAKE_ADDRESS);
    expect(removeWallet('main')).toBe(true);
    expect(walletExists('main')).toBe(false);
    expect(removeWallet('main')).toBe(false);
  });

  it('loadWalletKeystore throws when wallet missing', () => {
    expect(() => loadWalletKeystore('ghost')).toThrow(/not found/);
  });
});
