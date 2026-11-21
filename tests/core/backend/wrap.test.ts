import { Wallet } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockBackend } from '../../../src/core/backend/MockBackend.js';
import { mockRequestId, mockUnderlyingAddress } from '../../../src/core/backend/mockWrap.js';
import { WalletTxError } from '../../../src/core/token/txErrors.js';
import {
  prepareFinish,
  reconcileUnwrap,
  sendFinish,
  sendUnwrapRequest,
  unconfirmedRequest,
} from '../../../src/core/token/unwrapPending.js';
import { planWrap } from '../../../src/core/token/wrapMath.js';
import { listUnwraps, updateUnwrap } from '../../../src/storage/UnwrapStore.js';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const instant = { latencyMs: 0, confirmMs: 0, sleep: async () => {} };
const signer = Wallet.createRandom();

function setup(opts: ConstructorParameters<typeof MockBackend>[0] = {}) {
  const b = new MockBackend({ ...instant, ...opts });
  const [cusdc, cdai] = b.catalogue('sepolia');
  return { b, cusdc, cdai };
}

beforeEach(() => wipeTestDataDir());

describe('mock wrappers', () => {
  it('reports cUSDC (rate 1) and cDAI (rate 1e12) as wrappers, others not', async () => {
    const { b, cusdc, cdai } = setup();
    const u = await b.wrapperInfo(cusdc.address, 'sepolia');
    expect(u).toMatchObject({ rate: 1n, underlying: { symbol: 'USDC', decimals: 6 } });
    expect(u?.underlying.address).toBe(mockUnderlyingAddress('sepolia', 'cUSDC'));
    expect(await b.wrapperInfo(cdai.address, 'sepolia')).toMatchObject({
      rate: 10n ** 12n,
      underlying: { symbol: 'DAI', decimals: 18 },
    });
    expect(await b.wrapperInfo('0x0000000000000000000000000000000000000abc', 'sepolia')).toBeNull();
  });

  it('wraps: approve exactly the amount, then wrap; dust stays; balance goes up', async () => {
    const { b, cdai } = setup();
    const info = (await b.wrapperInfo(cdai.address, 'sepolia'))!;
    const state = await b.wrapState(info, signer.address, 'sepolia');
    const plan = planWrap('max', info, { balance: state.balance });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.dust).toBe(123_456_789_000n);
    const p = await b.prepareWrap(signer, info, plan.pull, 'sepolia');
    expect(p.steps).toEqual(['approve', 'wrap']);
    expect(p.feeEstimated).toBe(true);
    const steps: string[] = [];
    const r = await p.send({ onStepConfirmed: (s) => steps.push(s) });
    expect(steps).toEqual(['approve', 'wrap']);
    expect(r.approveTxHash).toMatch(/^0x/);
    expect(r.balanceCheck).toBe('moved');
    expect(r.balanceAfter! - r.balanceBefore!).toBe(plan.wrapped);
    const after = await b.wrapState(info, signer.address, 'sepolia');
    expect(after.balance).toBe(plan.dust); // only the dust is left
    expect(after.allowance).toBe(0n); // the exact approval was used up
    await expect(p.send()).rejects.toThrow(/already used/);
  });

  it('skips the approval when the allowance already covers the amount', async () => {
    const { b, cusdc } = setup();
    const info = (await b.wrapperInfo(cusdc.address, 'sepolia'))!;
    b.wrapOps.setAllowance('sepolia', info, signer.address, 30_000_000n);
    const p = await b.prepareWrap(signer, info, 25_000_000n, 'sepolia');
    expect(p.steps).toEqual(['wrap']);
    expect(p.feeEstimated).toBe(false);
    const r = await p.send();
    expect(r.approveTxHash).toBeUndefined();
  });

  it('resets a USDT-style allowance to 0 before the new exact approval', async () => {
    const { b, cusdc } = setup();
    const info = (await b.wrapperInfo(cusdc.address, 'sepolia'))!;
    b.wrapOps.setAllowance('sepolia', info, signer.address, 1n);
    const p = await b.prepareWrap(signer, info, 25_000_000n, 'sepolia');
    expect(p.steps).toEqual(['reset', 'approve', 'wrap']);
    const r = await p.send();
    expect(r.resetTxHash).toBeDefined();
    expect(r.balanceCheck).toBe('moved');
  });

  it('refuses more than the public balance and simulation failures before signing', async () => {
    const { b, cusdc } = setup();
    const info = (await b.wrapperInfo(cusdc.address, 'sepolia'))!;
    await expect(b.prepareWrap(signer, info, 10n ** 12n, 'sepolia')).rejects.toMatchObject({
      code: 'INSUFFICIENT_TOKEN_BALANCE',
    });
    const f = setup({ fail: 'simulate' });
    await expect(f.b.prepareWrap(signer, info, 1n, 'sepolia')).rejects.toBeInstanceOf(
      WalletTxError,
    );
  });
});

describe('unwrap and the pending state machine', () => {
  async function requestOne(b: MockBackend, token: string, amount = 10_000_000n) {
    const info = (await b.wrapperInfo(token, 'sepolia'))!;
    const p = await b.prepareUnwrap(signer, info, amount, 'sepolia');
    return {
      info,
      ...(await sendUnwrapRequest(p, { network: 'sepolia', wallet: signer.address, info, amount })),
    };
  }

  it('request → finalize: burns, records, pays the ERC-20 and finishes', async () => {
    const { b, cusdc } = setup();
    const before = await b.underlyingBalance(
      (await b.wrapperInfo(cusdc.address, 'sepolia'))!,
      signer.address,
      'sepolia',
    );
    const { info, entry, result } = await requestOne(b, cusdc.address);
    expect(result.requestId).toBe(mockRequestId(result.txHash));
    expect(entry).toMatchObject({
      state: 'requested',
      requestId: result.requestId,
      amount: '10000000',
    });
    const rec = await reconcileUnwrap(b, entry);
    expect(rec.next.kind).toBe('finalize');
    const fin = await prepareFinish(b, signer, rec.entry);
    expect(fin).toMatchObject({ value: 10_000_000n, receive: 10_000_000n });
    const done = await sendFinish(fin, rec.entry);
    expect(done.entry).toMatchObject({
      state: 'finished',
      finishedBy: 'wallet',
      value: '10000000',
    });
    expect(await b.underlyingBalance(info, signer.address, 'sepolia')).toBe(before + 10_000_000n);
    // A rerun finds it done and sends nothing.
    expect((await reconcileUnwrap(b, done.entry)).next.kind).toBe('done');
  });

  it('refuses a request above the decrypted balance (it would burn 0)', async () => {
    const { b, cusdc } = setup();
    const info = (await b.wrapperInfo(cusdc.address, 'sepolia'))!;
    await expect(b.prepareUnwrap(signer, info, 10n ** 15n, 'sepolia')).rejects.toMatchObject({
      code: 'INSUFFICIENT_TOKEN_BALANCE',
    });
  });

  it('keeps an unconfirmed request pending and never sends it again', async () => {
    const { b, cdai } = setup({ fail: 'unconfirmed' });
    const info = (await b.wrapperInfo(cdai.address, 'sepolia'))!;
    const p = await b.prepareUnwrap(signer, info, 1_000_000n, 'sepolia');
    await expect(
      sendUnwrapRequest(p, {
        network: 'sepolia',
        wallet: signer.address,
        info,
        amount: 1_000_000n,
      }),
    ).rejects.toMatchObject({ code: 'SENT_UNCONFIRMED' });
    const [e] = listUnwraps({ open: true });
    expect(e.state).toBe('signed');
    expect(unconfirmedRequest('sepolia', signer.address, cdai.address)?.id).toBe(e.id);
    expect((await reconcileUnwrap(b, e)).next).toEqual({ kind: 'wait-request', missing: true });

    // A later process (no failure) sees it mined, learns the id and finishes it.
    const later = new MockBackend(instant);
    const rec = await reconcileUnwrap(later, listUnwraps({ open: true })[0]);
    expect(rec.entry.state).toBe('requested');
    expect(rec.entry.requestId).toBe(mockRequestId(e.requestTxHash));
    const done = await sendFinish(await prepareFinish(later, signer, rec.entry), rec.entry);
    expect(done.entry.state).toBe('finished');
  });

  it('waits for public decryption without sending anything', async () => {
    const { b, cusdc } = setup({ fail: 'public-pending' });
    const { entry } = await requestOne(b, cusdc.address);
    const rec = await reconcileUnwrap(b, entry);
    expect(rec.next.kind).toBe('finalize');
    await expect(prepareFinish(b, signer, rec.entry)).rejects.toMatchObject({
      code: 'PUBLIC_DECRYPT_PENDING',
    });
    expect(listUnwraps({ open: true })[0].state).toBe('requested');
  });

  it('does not resend a finalize that may still land; records one someone else sent', async () => {
    const { b, cusdc } = setup();
    const { entry } = await requestOne(b, cusdc.address);
    // Our finalize was signed a moment ago and the node does not know it yet.
    const signedNow = updateUnwrap(entry.id, {
      state: 'finalizing',
      finalizeTxHash: '0x' + 'ab'.repeat(32),
      finalizeSignedAt: new Date().toISOString(),
    });
    expect((await reconcileUnwrap(b, signedNow)).next).toEqual({
      kind: 'wait-finalize',
      missing: true,
    });
    // Long after, still unknown and the request still open: step 2 may go again.
    const stale = await reconcileUnwrap(b, signedNow, Date.now() + 10 * 60_000);
    expect(stale.next.kind).toBe('finalize');
    expect(stale.entry.state).toBe('requested');
    // Someone else finalizes it (anyone may): the wallet records it and sends nothing.
    const fin = await prepareFinish(b, signer, stale.entry);
    await fin.send();
    const rec = await reconcileUnwrap(b, stale.entry);
    expect(rec.next.kind).toBe('done');
    expect(rec.entry.finishedBy).toBe('other');
  });

  it('marks a reverted request as failed (nothing burnt)', async () => {
    const { b, cusdc } = setup({ fail: 'reverted' });
    const info = (await b.wrapperInfo(cusdc.address, 'sepolia'))!;
    const p = await b.prepareUnwrap(signer, info, 1n, 'sepolia');
    await expect(
      sendUnwrapRequest(p, { network: 'sepolia', wallet: signer.address, info, amount: 1n }),
    ).rejects.toMatchObject({ code: 'TX_REVERTED' });
    const rec = await reconcileUnwrap(b, listUnwraps()[0]);
    expect(rec.next.kind).toBe('failed');
    expect(rec.entry.state).toBe('failed');
  });

  it('recognises a finished request after a restart', async () => {
    const { b, cusdc } = setup();
    const { entry } = await requestOne(b, cusdc.address);
    const done = await sendFinish(await prepareFinish(b, signer, entry), entry);
    const later = new MockBackend(instant);
    expect((await reconcileUnwrap(later, done.entry)).next.kind).toBe('done');
  });
});
