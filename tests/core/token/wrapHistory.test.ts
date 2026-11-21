/**
 * Wraps and unwrap requests in the local history: confirmed with their block, or
 * unconfirmed (block 0) when only the receipt is missing, never for an approval.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { PreparedWrap, WrapHooks } from '../../../src/core/backend/wrapTypes.js';
import { WalletTxError } from '../../../src/core/token/txErrors.js';
import { recordWrapHistory, sendWrapRecorded } from '../../../src/core/token/wrapHistory.js';
import type { WrapperInfo } from '../../../src/core/token/wrapper.js';
import { listTransactions } from '../../../src/storage/TransactionStore.js';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const WALLET = '0x' + 'aa'.repeat(20);
const INFO: WrapperInfo = {
  address: '0x' + 'cc'.repeat(20),
  name: 'Confidential USDC',
  symbol: 'cUSDC',
  decimals: 6,
  rate: 1n,
  underlying: { address: '0x' + 'dd'.repeat(20), name: 'USDC', symbol: 'USDC', decimals: 6 },
  hasRequester: true,
} as WrapperInfo;
const CTX = { network: 'sepolia' as const, wallet: WALLET, info: INFO, amount: 25_500_000n };
const HASH = '0x' + '11'.repeat(32);

/** A PreparedWrap whose send runs `steps` and then throws `err` (or confirms). */
function prepared(steps: Array<'approve' | 'wrap'>, err?: unknown): PreparedWrap {
  return {
    steps,
    feeWei: 1n,
    feeEstimated: false,
    ethBalanceWei: 1n,
    state: { balance: 0n, allowance: 0n },
    send: async (hooks: WrapHooks = {}) => {
      for (const s of steps) hooks.onStep?.(s);
      if (err) throw err;
      return { txHash: HASH, blockNumber: 42, balanceCheck: 'unknown' } as never;
    },
  };
}

const unconfirmed = (txHash: string) =>
  new WalletTxError('SENT_UNCONFIRMED', 'Sent, not confirmed', '', '', undefined, txHash);

const rows = () => listTransactions({ walletAddress: WALLET, network: 'sepolia' });

beforeEach(() => wipeTestDataDir());

describe('wrap history', () => {
  it('records a confirmed wrap as a mint with its block', async () => {
    await sendWrapRecorded(prepared(['wrap']), CTX);
    expect(rows()).toMatchObject([
      { type: 'mint', txHash: HASH, blockNumber: 42, amount: '25.5', tokenSymbol: 'cUSDC' },
    ]);
  });

  it('records an unconfirmed wrap at block 0 and rethrows', async () => {
    await expect(sendWrapRecorded(prepared(['wrap'], unconfirmed(HASH)), CTX)).rejects.toThrow();
    expect(rows()).toMatchObject([{ type: 'mint', txHash: HASH, blockNumber: 0 }]);
  });

  it('records nothing when the approval is what did not confirm', async () => {
    const approve = { ...prepared(['approve', 'wrap']) };
    approve.send = async (hooks: WrapHooks = {}) => {
      hooks.onStep?.('approve');
      throw unconfirmed(HASH);
    };
    await expect(sendWrapRecorded(approve, CTX)).rejects.toThrow();
    expect(rows()).toEqual([]);
  });

  it('records an unwrap request as a burn from the wallet', () => {
    recordWrapHistory('unwrap', CTX, HASH, 0);
    expect(rows()).toMatchObject([
      { type: 'burn', from: WALLET, to: '0x' + '0'.repeat(40), blockNumber: 0 },
    ]);
  });
});
