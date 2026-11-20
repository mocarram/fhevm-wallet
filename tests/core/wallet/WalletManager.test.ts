import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWallet,
  exportWalletPrivateKey,
  exportKeystoreFile,
  getWalletAddress,
  hasWallet,
  importWalletFromMnemonic,
  importWalletFromPrivateKey,
  listWallets,
  loadWallet,
  removeWallet,
} from '../../../src/core/wallet/WalletManager.js';
import { wipeTestDataDir } from '../../helpers/dataDir.js';
import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Wallet } from 'ethers';

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

  it('exports the encrypted keystore with owner-only access and refuses to overwrite', async () => {
    await importWalletFromPrivateKey('ks', KNOWN_PRIVATE_KEY, PASSWORD);
    const dest = join(homedir(), 'backup.json');
    const written = exportKeystoreFile('ks', dest);
    // The file is a standard keystore: it decrypts with the wallet password only.
    const restored = await Wallet.fromEncryptedJson(readFileSync(written, 'utf-8'), PASSWORD);
    expect(restored.privateKey).toBe(KNOWN_PRIVATE_KEY);
    if (process.platform !== 'win32') expect(statSync(written).mode & 0o777).toBe(0o600);
    expect(() => exportKeystoreFile('ks', dest)).toThrow(/already exists/);
  });

  it('refuses wallet names that point outside the wallets folder', async () => {
    const { mkdirSync, writeFileSync } = await import('fs');
    const { DATA_DIR } = await import('../../../src/storage/paths.js');
    mkdirSync(join(DATA_DIR, 'wallets'), { recursive: true });
    writeFileSync(join(DATA_DIR, 'tokens.json'), '{"tokens":[]}');
    for (const bad of ['../tokens', '..', 'a/b', 'a\\b']) {
      expect(() => exportKeystoreFile(bad, join(homedir(), `x-${Math.random()}.json`))).toThrow(
        /not a valid wallet name/,
      );
      expect(hasWallet(bad)).toBe(false);
    }
  });

  it('refuses to export a wallet that does not exist', () => {
    expect(() => exportKeystoreFile('nope', join(homedir(), 'x.json'))).toThrow(/not found/);
  });

  it('never writes a key, phrase or password to any data file except the keystore', async () => {
    const { readdirSync } = await import('fs');
    const { DATA_DIR } = await import('../../../src/storage/paths.js');
    const created = await createWallet('a', PASSWORD);
    await importWalletFromMnemonic('b', KNOWN_MNEMONIC, PASSWORD);
    const pk = await exportWalletPrivateKey('a', PASSWORD);
    exportKeystoreFile('a', join(homedir(), 'a-backup.json'));

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(DATA_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (const secret of [created.mnemonic, KNOWN_MNEMONIC, pk.slice(2), PASSWORD]) {
        expect(text, file).not.toContain(secret);
      }
    }
  });
});
