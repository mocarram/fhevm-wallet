/**
 * Disclosure step 2 must never be sent twice: a rerun after SENT_UNCONFIRMED checks the
 * earlier transaction and the chain's AmountDisclosed logs first (live Sepolia finding).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const chain = vi.hoisted(() => ({
  receipt: null as null | { status: number },
  pending: null as null | object,
  publicly: true,
  disclosedValue: null as null | bigint,
  failReads: false,
}));
const stepTwo = vi.hoisted(() => ({
  send: vi.fn(async (hooks?: { onSigned?: (h: string) => void }) => {
    hooks?.onSigned?.(HASH);
    throw Object.assign(new Error('not confirmed'), { code: 'SENT_UNCONFIRMED' });
  }),
}));
const HASH = vi.hoisted(() => '0x' + '7'.repeat(64));
vi.mock('../../../src/core/network/ProviderFactory.js', async (orig) => ({
  ...(await orig<object>()),
  getProvider: () => ({
    getTransactionReceipt: async () => {
      if (chain.failReads)
        throw Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' });
      return chain.receipt;
    },
    getTransaction: async () => {
      if (chain.failReads)
        throw Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' });
      return chain.pending;
    },
  }),
}));
vi.mock('../../../src/core/token/TokenService.js', async (orig) => ({
  ...(await orig<object>()),
  isPubliclyDecryptable: async () => chain.publicly,
  findAmountDisclosed: async () => chain.disclosedValue,
  prepareDiscloseAmount: async () => ({ feeWei: 1n, ethBalanceWei: 2n, send: stepTwo.send }),
}));
vi.mock('../../../src/core/fhe/DecryptionService.js', async (orig) => ({
  ...(await orig<object>()),
  publicDecryptHandle: async () => ({ value: 25n, proof: '0x' }),
}));

const { RealBackend } = await import('../../../src/core/backend/RealBackend.js');
const { getAmountEntry } = await import('../../../src/storage/AmountCache.js');
const TOKEN = '0x1111111111111111111111111111111111111111';
const H = '0x' + 'ab'.repeat(32);
const signer = { address: '0x2222222222222222222222222222222222222222' } as never;

beforeEach(() => {
  wipeTestDataDir();
  Object.assign(chain, {
    receipt: null,
    pending: null,
    publicly: true,
    disclosedValue: null,
    failReads: false,
  });
});

describe('RealBackend disclosure step 2', () => {
  it('remembers the signed hash, refuses to resend while it is pending, then sees it mined', async () => {
    const b = new RealBackend();
    const prepared = await b.prepareDisclose(signer, TOKEN, H, 'sepolia');
    await expect(prepared.send()).rejects.toThrow();
    expect(getAmountEntry('sepolia', H)?.discloseTx).toBe(HASH);

    chain.pending = { hash: HASH };
    await expect(b.prepareDisclose(signer, TOKEN, H, 'sepolia')).rejects.toMatchObject({
      code: 'SENT_UNCONFIRMED',
      txHash: HASH,
    });

    chain.receipt = { status: 1 };
    expect(await b.discloseStage(TOKEN, H, 'sepolia')).toBe('disclosed');
    expect(getAmountEntry('sepolia', H)).toMatchObject({ disclosed: true, value: '25' });
    expect(getAmountEntry('sepolia', H)?.discloseTx).toBeUndefined();
  });

  it('finds a disclosure made elsewhere from its AmountDisclosed log', async () => {
    chain.disclosedValue = 40n;
    expect(await new RealBackend().discloseStage(TOKEN, H, 'sepolia')).toBe('disclosed');
    expect(getAmountEntry('sepolia', H)?.value).toBe('40');
  });

  it('is "requested" when step 1 is done and no disclosure is found', async () => {
    expect(await new RealBackend().discloseStage(TOKEN, H, 'sepolia')).toBe('requested');
    chain.publicly = false;
    expect(await new RealBackend().discloseStage(TOKEN, H, 'sepolia')).toBe('private');
  });

  it('fails closed when the RPC cannot say whether the earlier step 2 is pending (N5)', async () => {
    const b = new RealBackend();
    const prepared = await b.prepareDisclose(signer, TOKEN, H, 'sepolia');
    await expect(prepared.send()).rejects.toThrow();
    stepTwo.send.mockClear();
    chain.failReads = true;
    const err = await b.prepareDisclose(signer, TOKEN, H, 'sepolia').catch((e) => e);
    expect(err.message).toMatch(/Couldn't check the disclosure sent earlier, so nothing was sent/);
    expect(stepTwo.send).not.toHaveBeenCalled();
  });
});
