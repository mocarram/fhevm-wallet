/**
 * RealWrapOps chains wrapper.ts calls: these tests replace those calls with fakes and
 * check the order, the exact approval, the reset path and what happens when the wrap
 * cannot be sent after the approval.
 */
import { Wallet } from 'ethers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedCall } from '../../../src/core/token/TokenService.js';
import { WalletTxError } from '../../../src/core/token/txErrors.js';

const calls: string[] = [];
const state = { balance: 10n ** 20n, allowance: 0n };
let approveFails: (v: bigint) => boolean = () => false;
let wrapFails = false;

function prepared(label: string, gas = 100_000n): PreparedCall {
  return {
    gasLimit: gas,
    feeWei: gas * 10n,
    ethBalanceWei: 10n ** 18n,
    send: async () => {
      calls.push(`send ${label}`);
      return {
        txHash: '0x' + label.length.toString(16).padStart(64, '0'),
        receipt: { blockNumber: 1, logs: [] } as never,
      };
    },
  };
}

vi.mock('../../../src/core/token/wrapper.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/token/wrapper.js')>();
  return {
    ...real,
    getWrapState: async () => ({ ...state }),
    prepareApprove: async (_w: unknown, _i: unknown, v: bigint) => {
      calls.push(`prepare approve ${v}`);
      if (approveFails(v)) {
        throw new WalletTxError(
          'CONTRACT_REJECTED',
          'The token contract rejected the approval.',
          '',
          '',
        );
      }
      return prepared(`approve ${v}`);
    },
    prepareWrapCall: async (_w: unknown, _i: unknown, pull: bigint) => {
      calls.push(`prepare wrap ${pull}`);
      if (wrapFails)
        throw new WalletTxError(
          'CONTRACT_REJECTED',
          'The token contract rejected the wrap.',
          'x',
          '',
        );
      return prepared(`wrap ${pull}`, 300_000n);
    },
  };
});
vi.mock('../../../src/core/token/TokenService.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/token/TokenService.js')>();
  return { ...real, getDecryptedBalance: async () => 5n };
});

const { RealWrapOps } = await import('../../../src/core/backend/realWrap.js');
const signer = Wallet.createRandom();
const info = {
  address: '0x85E3A388B8b8939Ab4f41e0B1eF70A998b23F938',
  name: 'Confidential Zama',
  symbol: 'cZAMA',
  decimals: 6,
  rate: 10n ** 12n,
  underlying: {
    address: '0xfeA311967E1899976E954aA6fb760e078407E37d',
    name: 'Zama',
    symbol: 'ZAMA',
    decimals: 18,
  },
  hasRequester: true,
};

beforeEach(() => {
  calls.length = 0;
  state.allowance = 0n;
  approveFails = () => false;
  wrapFails = false;
});

describe('RealWrapOps.prepareWrap', () => {
  it('approves exactly the amount, then simulates and sends the wrap', async () => {
    const p = await new RealWrapOps().prepareWrap(signer, info, 2n * 10n ** 18n, 'sepolia');
    expect(p.steps).toEqual(['approve', 'wrap']);
    expect(p.feeEstimated).toBe(true);
    // approval simulated + wrap estimated at the same price (10 wei/gas, +20%)
    expect(p.feeWei).toBe(100_000n * 10n + (900_000n * 10n * 12n) / 10n);
    expect(calls).toEqual(['prepare approve 2000000000000000000']);
    const r = await p.send();
    expect(calls).toEqual([
      'prepare approve 2000000000000000000',
      'send approve 2000000000000000000',
      'prepare wrap 2000000000000000000',
      'send wrap 2000000000000000000',
    ]);
    expect(r.approveTxHash).toBeDefined();
  });

  it('wraps directly when the allowance is enough', async () => {
    state.allowance = 3n * 10n ** 18n;
    const p = await new RealWrapOps().prepareWrap(signer, info, 2n * 10n ** 18n, 'sepolia');
    expect(p.steps).toEqual(['wrap']);
    expect(p.feeEstimated).toBe(false);
  });

  it('resets a non-zero allowance first only when the token refused the change', async () => {
    state.allowance = 1n;
    approveFails = (v) =>
      v !== 0n && calls.filter((c) => c.startsWith('send approve 0')).length === 0;
    const p = await new RealWrapOps().prepareWrap(signer, info, 10n ** 18n, 'sepolia');
    expect(p.steps).toEqual(['reset', 'approve', 'wrap']);
    await p.send();
    expect(calls.filter((c) => c.startsWith('send'))).toEqual([
      'send approve 0',
      'send approve 1000000000000000000',
      'send wrap 1000000000000000000',
    ]);
  });

  it('a refused approval without an allowance to reset fails before anything is signed', async () => {
    approveFails = () => true;
    await expect(
      new RealWrapOps().prepareWrap(signer, info, 10n ** 18n, 'sepolia'),
    ).rejects.toMatchObject({
      code: 'CONTRACT_REJECTED',
    });
    expect(calls.some((c) => c.startsWith('send'))).toBe(false);
  });

  it('stops after the approval when the wrap cannot be simulated (WRAP_APPROVED_ONLY, no hash)', async () => {
    wrapFails = true;
    const p = await new RealWrapOps().prepareWrap(signer, info, 10n ** 18n, 'sepolia');
    const err = await p.send().catch((e: WalletTxError) => e);
    expect(err).toMatchObject({ code: 'WRAP_APPROVED_ONLY', txHash: undefined });
    expect((err as WalletTxError).message).toMatch(
      /approval went through, but the wrap was not sent/,
    );
    expect(calls.filter((c) => c.startsWith('send'))).toEqual(['send approve 1000000000000000000']);
  });

  it('refuses more than the public balance', async () => {
    await expect(
      new RealWrapOps().prepareWrap(signer, info, 10n ** 21n, 'sepolia'),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_TOKEN_BALANCE',
    });
  });
});
