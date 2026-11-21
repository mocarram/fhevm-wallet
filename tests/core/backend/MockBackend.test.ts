import { Wallet } from 'ethers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBackend, MockBackend, mockOptionsFromEnv } from '../../../src/core/backend/index.js';
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
    const dataDir = mkdtempSync(join(tmpdir(), 'fhew-mock-'));
    expect(
      createBackend({ FHEW_BACKEND: 'mock', FHEVM_WALLET_HOME: dataDir }, { dataDir }).kind,
    ).toBe('mock');
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

describe('MockBackend: one-signature decrypt, history amounts, operators, disclosure', () => {
  it('decrypts every tracked balance with one signature and one request', async () => {
    const m = new MockBackend(instant);
    const extra = [
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ];
    const tokens = [...m.catalogue('sepolia').map((t) => t.address), ...extra];
    const w = Wallet.createRandom();
    const sign = vi.spyOn(w, 'signTypedData');
    const session = m.newDecryptSession(w, 'sepolia');
    const batch = await m.decryptBalances(session, tokens);
    expect(Object.keys(batch.values)).toHaveLength(4);
    expect(batch.values[tokens[0].toLowerCase()]).toBe(1_250_000_000n);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(m.userDecryptRequests).toBe(1);
    // Unchanged handles come from the cache: no new request, no new signature.
    await m.decryptBalances(session, tokens);
    expect(m.userDecryptRequests).toBe(1);
    await m.decryptBalances(session, tokens, { forceRefresh: true });
    expect(m.userDecryptRequests).toBe(2);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('decrypts allowed history amounts and returns null for the others', async () => {
    const m = new MockBackend(instant);
    const t = m.catalogue('sepolia')[0];
    await m.syncHistory(signer.address, 'sepolia', [
      { ...t, network: 'sepolia', addedAt: '' },
    ] as never);
    const tx = listTransactions({ walletAddress: signer.address, network: 'sepolia' }).find(
      (x) => x.amountHandle,
    )!;
    const foreign = m.registerHandle('0x' + 'ab'.repeat(30) + '0500', 7n, [RECIPIENT]);
    const session = m.newDecryptSession(signer, 'sepolia');
    const out = await m.decryptAmounts(
      session,
      [
        { token: t.address, handle: tx.amountHandle! },
        { token: t.address, handle: foreign },
      ],
      [t.address],
    );
    expect(out[tx.amountHandle!.toLowerCase()]).toBe(25_000_000n);
    expect(out[foreign]).toBeNull();
  });

  it('grants and revokes an operator with the send-safety flow', async () => {
    let now = 1_700_000_000_000;
    const m = new MockBackend({ ...instant, now: () => now });
    const t = m.catalogue('sepolia')[0].address;
    const p = await m.prepareSetOperator(signer, t, RECIPIENT, 1_700_003_600, 'sepolia');
    expect(p.feeWei).toBeGreaterThan(0n);
    expect(await m.operatorStatus(t, signer.address, [RECIPIENT], 'sepolia')).toEqual({
      [RECIPIENT.toLowerCase()]: false,
    });
    const r = await p.send();
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(p.send()).rejects.toThrow(/already used/);
    expect(
      (await m.operatorStatus(t, signer.address, [RECIPIENT], 'sepolia'))[RECIPIENT.toLowerCase()],
    ).toBe(true);
    now += 2 * 3600_000; // expired
    expect(
      (await m.operatorStatus(t, signer.address, [RECIPIENT], 'sepolia'))[RECIPIENT.toLowerCase()],
    ).toBe(false);
    now -= 2 * 3600_000;
    await (await m.prepareSetOperator(signer, t, RECIPIENT, 0, 'sepolia')).send();
    expect(
      (await m.operatorStatus(t, signer.address, [RECIPIENT], 'sepolia'))[RECIPIENT.toLowerCase()],
    ).toBe(false);
  });

  it('keeps the hash when an operator change is not confirmed', async () => {
    const m = new MockBackend({ ...instant, fail: 'unconfirmed' });
    const t = m.catalogue('sepolia')[0].address;
    const p = await m.prepareSetOperator(signer, t, RECIPIENT, 0, 'sepolia');
    const err = (await p.send().catch((e) => e)) as WalletTxError;
    expect(err.code).toBe('SENT_UNCONFIRMED');
    expect(err.txHash).toMatch(/^0x/);
  });

  it('discloses in two steps: request, then publish the publicly decrypted value', async () => {
    const m = new MockBackend(instant);
    const t = m.catalogue('sepolia')[0];
    const h = m.registerHandle('0x' + 'cd'.repeat(30) + '0500', 42n, [signer.address]);
    expect(await m.discloseStage(t.address, h, 'sepolia')).toBe('private');
    await expect(m.prepareDisclose(signer, t.address, h, 'sepolia')).rejects.toMatchObject({
      code: 'PUBLIC_DECRYPT_PENDING',
    });
    await (await m.prepareDiscloseRequest(signer, t.address, h, 'sepolia')).send();
    expect(await m.discloseStage(t.address, h, 'sepolia')).toBe('requested');
    const d = await m.prepareDisclose(signer, t.address, h, 'sepolia');
    expect(d.value).toBe(42n);
    await d.send();
    expect(await m.discloseStage(t.address, h, 'sepolia')).toBe('disclosed');
    await expect(
      m.prepareDiscloseRequest(Wallet.createRandom(), t.address, h, 'sepolia'),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it("refuses to disclose the wallet's own balance handle", async () => {
    const m = new MockBackend(instant);
    const t = m.catalogue('sepolia')[0];
    const priv = m as unknown as {
      balanceHandle(n: string, token: string, wallet: string): string;
    };
    const h = priv.balanceHandle('sepolia', t.address, signer.address);
    await expect(m.prepareDiscloseRequest(signer, t.address, h, 'sepolia')).rejects.toMatchObject({
      code: 'DISCLOSE_IS_BALANCE',
    });
  });
});
