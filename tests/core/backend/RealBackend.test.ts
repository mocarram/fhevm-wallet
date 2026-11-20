import { describe, expect, it, vi } from 'vitest';

const send = vi.fn(async (hooks?: { onBroadcast?: (h: string) => void }) => {
  hooks?.onBroadcast?.('0xabc');
  return { txHash: '0xabc', receipt: { blockNumber: 42 }, balanceCheck: 'moved', balanceAfter: 5n };
});
vi.mock('../../../src/core/token/TokenService.js', () => ({
  prepareConfidentialTransfer: vi.fn(async () => ({
    gasLimit: 1n,
    feeWei: 2n,
    ethBalanceWei: 3n,
    tokenBalance: 4n,
    send,
  })),
  getDecryptedBalance: vi.fn(async () => 7n),
  getTokenInfo: vi.fn(),
  getTxExplorerUrl: vi.fn((h: string) => `https://sepolia.etherscan.io/tx/${h}`),
}));

describe('RealBackend', () => {
  it('delegates prepare/send to TokenService and maps the receipt', async () => {
    const { RealBackend } = await import('../../../src/core/backend/RealBackend.js');
    const ts = await import('../../../src/core/token/TokenService.js');
    const b = new RealBackend();
    const signer = { address: '0x1' } as never;
    const prepared = await b.prepareTransfer(signer, '0xT', '0xR', 9n, 'sepolia');
    expect(ts.prepareConfidentialTransfer).toHaveBeenCalledWith(
      signer,
      '0xT',
      '0xR',
      9n,
      'sepolia',
    );
    expect(prepared).toMatchObject({ feeWei: 2n, ethBalanceWei: 3n, tokenBalance: 4n });
    const hooks = { onBroadcast: vi.fn() };
    const res = await prepared.send(hooks);
    expect(send).toHaveBeenCalledWith(hooks);
    expect(hooks.onBroadcast).toHaveBeenCalledWith('0xabc');
    expect(res).toEqual({
      txHash: '0xabc',
      blockNumber: 42,
      balanceCheck: 'moved',
      balanceAfter: 5n,
    });
    expect(await b.decryptBalance('0xT', signer, 'sepolia')).toBe(7n);
    expect(b.kind).toBe('real');
    expect(b.suggestedTokens()).toEqual([]);
  });
});
