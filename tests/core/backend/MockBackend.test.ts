import { Wallet } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBackend, MockBackend, mockOptionsFromEnv } from '../../../src/core/backend/index.js';
import { mockDataDirProblem } from '../../../src/core/backend/select.js';
import { RealBackend } from '../../../src/core/backend/RealBackend.js';
import { WalletTxError } from '../../../src/core/token/txErrors.js';
import { peekCachedBalance } from '../../../src/core/token/BalanceCache.js';
import { listTransactions } from '../../../src/storage/TransactionStore.js';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const instant = { latencyMs: 0, confirmMs: 0, sleep: async () => {} };
const signer = Wallet.createRandom();
const RECIPIENT = '0x52908400098527886E0F7030069857D2E4169EE7';

beforeEach(() => wipeTestDataDir());

describe('createBackend', () => {
  it('defaults to the real backend and only mocks when asked', () => {
    expect(createBackend({})).toBeInstanceOf(RealBackend);
    expect(createBackend({ FHEW_BACKEND: 'real' }).kind).toBe('real');
    expect(
      createBackend({ FHEW_BACKEND: 'mock', FHEVM_WALLET_HOME: join(tmpdir(), 'fhew-mock') }).kind,
    ).toBe('mock');
  });

  it('refuses the mock unless FHEVM_WALLET_HOME is a separate folder', () => {
    expect(() => createBackend({ FHEW_BACKEND: 'mock' })).toThrow(/FHEVM_WALLET_HOME is not set/);
    expect(() => createBackend({ FHEW_BACKEND: 'mock', FHEVM_WALLET_HOME: ' ' })).toThrow(
      /not set/,
    );
    const home = mkdtempSync(join(tmpdir(), 'fhew-home-'));
    mkdirSync(join(home, '.fhevm-wallet'));
    symlinkSync(join(home, '.fhevm-wallet'), join(home, 'link'));
    for (const dir of [
      join(home, '.fhevm-wallet'),
      join(home, '.fhevm-wallet', '.'),
      join(home, 'link'),
    ]) {
      expect(mockDataDirProblem({ FHEVM_WALLET_HOME: dir }, home)).toMatch(/real wallet folder/);
      expect(() => createBackend({ FHEW_BACKEND: 'mock', FHEVM_WALLET_HOME: dir }, home)).toThrow(
        /real wallet folder/,
      );
    }
    expect(mockDataDirProblem({ FHEVM_WALLET_HOME: join(home, 'scratch') }, home)).toBeNull();
    // The real backend never cares.
    expect(createBackend({}, home).kind).toBe('real');
  });

  it('refuses an unknown value instead of guessing', () => {
    expect(() => createBackend({ FHEW_BACKEND: 'mok' })).toThrow(/Unknown FHEW_BACKEND/);
  });
});

describe('mockOptionsFromEnv', () => {
  it('reads latency, ETH and failure mode, ignoring junk', () => {
    const o = mockOptionsFromEnv({
      FHEW_MOCK_LATENCY_MS: '5',
      FHEW_MOCK_ETH: '0.001',
      FHEW_MOCK_FAIL: 'reverted',
    });
    expect(o).toMatchObject({ latencyMs: 5, ethWei: 10n ** 15n, fail: 'reverted' });
    expect(
      mockOptionsFromEnv({ FHEW_MOCK_FAIL: 'boom', FHEW_MOCK_LATENCY_MS: '-1' }),
    ).toMatchObject({ fail: undefined, latencyMs: 300 });
  });
});

describe('MockBackend', () => {
  it('is deterministic: same catalogue and starting balances every time', async () => {
    const a = new MockBackend(instant);
    const b = new MockBackend(instant);
    expect(a.catalogue('sepolia')).toEqual(b.catalogue('sepolia'));
    const cusdc = a.catalogue('sepolia')[0];
    expect(cusdc.symbol).toBe('cUSDC');
    expect(await a.decryptBalance(cusdc.address, signer, 'sepolia')).toBe(1_250_000_000n);
    expect(await a.getTokenInfo(cusdc.address, 'sepolia')).toEqual(cusdc);
  });

  it('writes decrypted balances to the real cache so Home can show their age', async () => {
    const m = new MockBackend(instant);
    const t = m.catalogue('sepolia')[0];
    await m.decryptBalance(t.address, signer, 'sepolia');
    expect(peekCachedBalance(signer.address, t.address, 'sepolia')?.value).toBe(1_250_000_000n);
  });

  it('prepares with a fee, sends with hooks, then moves balances and ETH', async () => {
    const m = new MockBackend(instant);
    const t = m.catalogue('sepolia')[0];
    const ethBefore = await m.getEthBalance(signer.address);
    const prepared = await m.prepareTransfer(signer, t.address, RECIPIENT, 25_000_000n, 'sepolia');
    expect(prepared.feeWei).toBe(300_000n * 1_000_000_000n);
    expect(prepared.tokenBalance).toBe(1_250_000_000n);
    const seen: string[] = [];
    const res = await prepared.send({ onBroadcast: (h) => seen.push(h) });
    expect(seen).toEqual([res.txHash]);
    expect(res).toMatchObject({ balanceCheck: 'moved', balanceAfter: 1_225_000_000n });
    expect(await m.decryptBalance(t.address, signer, 'sepolia')).toBe(1_225_000_000n);
    expect(await m.getEthBalance(signer.address)).toBe(ethBefore - prepared.feeWei);
    await expect(prepared.send()).rejects.toThrow(/already used/);
  });

  it('stops a send above the balance, as ERC-7984 would move 0', async () => {
    const m = new MockBackend(instant);
    const t = m.catalogue('sepolia')[1];
    await expect(
      m.prepareTransfer(signer, t.address, RECIPIENT, 10n ** 12n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_TOKEN_BALANCE' });
  });

  it('refuses when ETH cannot pay the fee', async () => {
    const m = new MockBackend({ ...instant, ethWei: 1n });
    const t = m.catalogue('sepolia')[0];
    await expect(
      m.prepareTransfer(signer, t.address, RECIPIENT, 1n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_GAS_FUNDS' });
  });

  it('simulates a faucet drip for a wallet that starts empty', async () => {
    const m = new MockBackend({ ...instant, ethWei: 0n });
    expect(await m.getEthBalance(signer.address)).toBe(0n);
    expect(await m.getEthBalance(signer.address)).toBe(5n * 10n ** 17n);
  });

  it.each([
    ['simulate', 'NOT_ERC7984', false],
    ['unconfirmed', 'SENT_UNCONFIRMED', true],
    ['reverted', 'TX_REVERTED', true],
    ['replaced', 'TX_REPLACED', true],
  ] as const)(
    'injects %s failures through the real error translation',
    async (fail, code, hasHash) => {
      const m = new MockBackend({ ...instant, fail });
      const t = m.catalogue('sepolia')[0];
      const err = await (async () => {
        const p = await m.prepareTransfer(signer, t.address, RECIPIENT, 1n, 'sepolia');
        await p.send();
      })().catch((e) => e);
      expect(err).toBeInstanceOf(WalletTxError);
      expect(err.code).toBe(code);
      expect(Boolean(err.txHash)).toBe(hasHash);
      if (hasHash) expect(err.hint).not.toMatch(/try again\.?$/i);
    },
  );

  it('seeds history once into the local store', async () => {
    const m = new MockBackend(instant);
    const t = m.catalogue('sepolia')[0];
    const tokens = [{ ...t, network: 'sepolia' as const, addedAt: '' }];
    expect((await m.syncHistory(signer.address, 'sepolia', tokens)).newCount).toBe(2);
    expect((await m.syncHistory(signer.address, 'sepolia', tokens)).newCount).toBe(0);
    expect(listTransactions({ walletAddress: signer.address, network: 'sepolia' })).toHaveLength(2);
  });

  it('never saves a custom RPC, but validates its shape', async () => {
    const m = new MockBackend(instant);
    await expect(m.setCustomRpc('sepolia', 'http://example.com')).rejects.toThrow(/https/);
    await expect(m.setCustomRpc('sepolia', 'https://example.com')).resolves.toMatchObject({
      chainId: 11155111n,
    });
    expect(process.env.SEPOLIA_RPC_URL).toBeUndefined();
  });
});
