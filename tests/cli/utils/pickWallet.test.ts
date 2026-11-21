/** pickWallet: -w, the default, or the only wallet (V4). */
import { Wallet } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickWallet } from '../../../src/cli/utils/txFlow.js';
import { saveWalletKeystore } from '../../../src/storage/WalletStore.js';
import { setDefaultWallet } from '../../../src/storage/ConfigStore.js';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

function add(name: string) {
  const w = Wallet.createRandom();
  saveWalletKeystore(name, w.encryptSync('pw', { scrypt: { N: 1024 } } as never), w.address);
  return w.address;
}

let out = '';
beforeEach(() => {
  wipeTestDataDir();
  out = '';
  vi.spyOn(console, 'log').mockImplementation((m) => void (out += String(m)));
  vi.spyOn(console, 'error').mockImplementation((m) => void (out += String(m)));
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('pickWallet', () => {
  it('uses the only wallet when no default is set', () => {
    const address = add('solo');
    setDefaultWallet('');
    expect(pickWallet()).toEqual({ name: 'solo', address });
  });

  it('with several wallets and no default, names set-default and the wallets', () => {
    add('a');
    add('b');
    setDefaultWallet('');
    expect(pickWallet()).toBeNull();
    expect(out).toMatch(/wallet set-default <name> \(wallets: a, b\)/);
    expect(process.exitCode).toBe(1);
  });

  it('says to create one when there is none', () => {
    expect(pickWallet()).toBeNull();
    expect(out).toMatch(/No wallet yet\. Create one with: fhevm-wallet wallet create/);
  });
});
