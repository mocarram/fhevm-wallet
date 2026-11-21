import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface, Transaction, Wallet, ZeroHash, zeroPadValue } from 'ethers';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const TOKEN = '0xde709f2102306220921060314715629080e2fb77';
const USER = '0x52908400098527886E0F7030069857D2E4169EE7';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

const contractStubs = {
  name: vi.fn(),
  symbol: vi.fn(),
  decimals: vi.fn(),
  confidentialBalanceOf: vi.fn(),
  // confidentialTransfer is reached through getFunction(signature) so ethers picks the
  // (address,bytes32,bytes) overload; the stub doubles as the callable and holds estimateGas.
  confidentialTransfer: Object.assign(vi.fn(), {
    estimateGas: vi.fn(),
    populateTransaction: vi.fn(),
  }),
  getFunction: vi.fn(),
  // Reached through getFunction('setOperator(address,uint48)'), like confidentialTransfer.
  setOperator: Object.assign(vi.fn(), { estimateGas: vi.fn(), populateTransaction: vi.fn() }),
  isOperator: vi.fn(),
};

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  class MockContract {
    name = contractStubs.name;
    symbol = contractStubs.symbol;
    decimals = contractStubs.decimals;
    confidentialBalanceOf = contractStubs.confidentialBalanceOf;
    getFunction = contractStubs.getFunction;
    isOperator = contractStubs.isOperator;
  }
  return { ...actual, Contract: MockContract };
});

const fakeProvider = {
  destroy: vi.fn(),
  broadcastTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  send: vi.fn(),
  getFeeData: vi.fn(),
  getBalance: vi.fn(),
  getCode: vi.fn(async () => '0x'),
};
vi.mock('../../../src/core/network/ProviderFactory.js', () => ({
  getProvider: vi.fn(() => fakeProvider),
  clearProviderCache: vi.fn(),
  clearProviderForNetwork: vi.fn(),
  getChainId: vi.fn(async () => 11155111n),
}));

vi.mock('../../../src/core/fhe/EncryptionService.js', () => ({
  encryptAmount: vi.fn(async () => ({
    handle: new Uint8Array(),
    handleHex: '0xhandle',
    inputProof: new Uint8Array(),
    inputProofHex: '0xproof',
  })),
}));

vi.mock('../../../src/core/fhe/DecryptionService.js', () => ({
  decryptBalance: vi.fn(async () => 9_999n),
}));

beforeEach(async () => {
  wipeTestDataDir();
  const { confirmationTiming } = await import('../../../src/core/token/TokenService.js');
  confirmationTiming.pollMs = 0;
  confirmationTiming.balanceRecheckMs = [0, 0];
  Object.values(contractStubs).forEach((fn) => fn.mockReset());
  contractStubs.confidentialTransfer.estimateGas.mockReset();
  contractStubs.confidentialTransfer.populateTransaction.mockReset();
  fakeProvider.broadcastTransaction.mockReset();
  fakeProvider.getTransactionReceipt.mockReset();
  fakeProvider.getTransactionReceipt.mockResolvedValue(null);
  contractStubs.setOperator.estimateGas.mockReset();
  contractStubs.setOperator.populateTransaction.mockReset();
  contractStubs.setOperator.estimateGas.mockResolvedValue(50_000n);
  contractStubs.setOperator.populateTransaction.mockResolvedValue({ to: TOKEN, data: '0x' });
  contractStubs.getFunction.mockImplementation((sig: string) =>
    sig.startsWith('setOperator') ? contractStubs.setOperator : contractStubs.confidentialTransfer,
  );
  fakeProvider.getFeeData.mockResolvedValue({ maxFeePerGas: 10n, gasPrice: null });
  fakeProvider.getBalance.mockResolvedValue(10n ** 18n);
  // Sepolia chain id, so the RPC chain check passes by default.
  fakeProvider.send.mockResolvedValue('0xaa36a7');
  contractStubs.confidentialTransfer.estimateGas.mockResolvedValue(100_000n);
  contractStubs.name.mockResolvedValue('Confidential Token');
  contractStubs.symbol.mockResolvedValue('cTKN');
  contractStubs.decimals.mockResolvedValue(6n);
  contractStubs.confidentialBalanceOf.mockResolvedValue(0n);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TokenService.getTokenInfo', () => {
  it('fetches name, symbol, and decimals', async () => {
    const { getTokenInfo } = await import('../../../src/core/token/TokenService.js');
    const info = await getTokenInfo(TOKEN, 'sepolia');
    expect(info).toEqual({
      address: TOKEN,
      name: 'Confidential Token',
      symbol: 'cTKN',
      decimals: 6,
    });
  });
});

describe('TokenService.getTokenInfo with a hostile contract', () => {
  it('strips terminal escapes and caps the length of name and symbol', async () => {
    contractStubs.name.mockResolvedValue('\u001b[31mReal USDC\u001b[0m' + 'x'.repeat(200));
    contractStubs.symbol.mockResolvedValue('\u200bUSDC\u202e');
    const { getTokenInfo } = await import('../../../src/core/token/TokenService.js');
    const info = await getTokenInfo(TOKEN, 'sepolia');
    expect(info.name).not.toMatch(/\u001b/);
    expect(info.name.length).toBeLessThanOrEqual(64);
    expect(info.symbol).toBe('USDC');
  });

  it('never stores an empty symbol', async () => {
    contractStubs.symbol.mockResolvedValue('\u0007\u0007');
    const { getTokenInfo } = await import('../../../src/core/token/TokenService.js');
    expect((await getTokenInfo(TOKEN, 'sepolia')).symbol).toBe('???');
  });
});

describe('TokenService.getEncryptedBalance', () => {
  it('forwards to confidentialBalanceOf', async () => {
    contractStubs.confidentialBalanceOf.mockResolvedValueOnce(123n);
    const { getEncryptedBalance } = await import('../../../src/core/token/TokenService.js');
    expect(await getEncryptedBalance(TOKEN, USER, 'sepolia')).toBe(123n);
    expect(contractStubs.confidentialBalanceOf).toHaveBeenCalledWith(USER);
  });
});

describe('TokenService.getDecryptedBalance', () => {
  it('returns 0n immediately when handle is zero (no decrypt call)', async () => {
    contractStubs.confidentialBalanceOf.mockResolvedValueOnce(0n);
    const { getDecryptedBalance } = await import('../../../src/core/token/TokenService.js');
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');

    const wallet = { address: USER, connect: () => wallet } as never;
    expect(await getDecryptedBalance(TOKEN, wallet, 'sepolia')).toBe(0n);
    expect(decryption.decryptBalance).not.toHaveBeenCalled();
  });

  it('decrypts and caches when handle is non-zero', async () => {
    contractStubs.confidentialBalanceOf.mockResolvedValue(42n);
    const { getDecryptedBalance } = await import('../../../src/core/token/TokenService.js');
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    const wallet = { address: USER, connect: () => wallet } as never;

    const first = await getDecryptedBalance(TOKEN, wallet, 'sepolia');
    expect(first).toBe(9_999n);
    expect(decryption.decryptBalance).toHaveBeenCalledOnce();

    // Second call with the same handle should hit the cache, not decrypt again.
    const second = await getDecryptedBalance(TOKEN, wallet, 'sepolia');
    expect(second).toBe(9_999n);
    expect(decryption.decryptBalance).toHaveBeenCalledOnce();
  });

  it('forceRefresh bypasses the cache', async () => {
    contractStubs.confidentialBalanceOf.mockResolvedValue(42n);
    const { getDecryptedBalance } = await import('../../../src/core/token/TokenService.js');
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    const wallet = { address: USER, connect: () => wallet } as never;

    await getDecryptedBalance(TOKEN, wallet, 'sepolia');
    await getDecryptedBalance(TOKEN, wallet, 'sepolia', { forceRefresh: true });
    expect(decryption.decryptBalance).toHaveBeenCalledTimes(2);
  });
});

describe('TokenService balance handles from the real ABI', () => {
  // confidentialBalanceOf returns bytes32, which ethers decodes to a 0x-hex string.
  // Run real encoded data through the real Interface so the mocks match production.
  const iface = new Interface(['function confidentialBalanceOf(address) view returns (bytes32)']);
  const decoded = (hex: string) =>
    iface.decodeFunctionResult(
      'confidentialBalanceOf',
      iface.encodeFunctionResult('confidentialBalanceOf', [hex]),
    )[0] as string;

  it('treats the zero handle as a zero balance without decrypting', async () => {
    contractStubs.confidentialBalanceOf.mockResolvedValue(decoded(ZeroHash));
    const { getDecryptedBalance } = await import('../../../src/core/token/TokenService.js');
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    const wallet = { address: USER, connect: () => wallet } as never;
    expect(await getDecryptedBalance(TOKEN, wallet, 'sepolia')).toBe(0n);
    expect(decryption.decryptBalance).not.toHaveBeenCalled();
  });

  it('passes a non-zero hex handle to decryption as a bigint', async () => {
    const handle = zeroPadValue('0x2a', 32);
    contractStubs.confidentialBalanceOf.mockResolvedValue(decoded(handle));
    const { getDecryptedBalance } = await import('../../../src/core/token/TokenService.js');
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    const wallet = { address: USER, connect: () => wallet } as never;
    await getDecryptedBalance(TOKEN, wallet, 'sepolia', { forceRefresh: true });
    expect(decryption.decryptBalance).toHaveBeenCalledWith(42n, TOKEN, wallet, 'sepolia');
  });
});

// A real signed transaction, so Transaction.from(signed).hash works exactly as in production.
let SIGNED = '';
let SIGNED_HASH = '';
beforeAll(async () => {
  SIGNED = await new Wallet(
    '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
  ).signTransaction({
    to: TOKEN,
    data: '0x',
    gasLimit: 120_000n,
    chainId: 11155111n,
    nonce: 0,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    type: 2,
  });
  SIGNED_HASH = Transaction.from(SIGNED).hash!;
});

/** A wallet that signs locally to the fixture above. */
const signingWallet = {
  address: USER,
  connect: () => signingWallet,
  populateTransaction: vi.fn(async (tx: unknown) => tx),
  signTransaction: vi.fn(async () => SIGNED),
};

/** Make the broadcast resolve to a tx whose wait() behaves as given. */
const broadcastWith = (wait: () => Promise<unknown>) =>
  fakeProvider.broadcastTransaction.mockResolvedValue({ hash: SIGNED_HASH, wait });

/** An ethers-shaped error. */
const ethersError = (code: string, message: string, fields: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...fields });

describe('TokenService.confidentialTransfer', () => {
  const wallet = signingWallet;
  const w = wallet as never;

  beforeEach(() => {
    contractStubs.confidentialTransfer.populateTransaction.mockResolvedValue({
      to: TOKEN,
      data: '0x',
    });
    wallet.populateTransaction.mockClear();
    wallet.signTransaction.mockClear();
    // Non-zero handle; the mocked decryptBalance returns 9_999 base units.
    contractStubs.confidentialBalanceOf.mockResolvedValue(42n);
  });

  it('simulates, signs locally with a gas buffer, then broadcasts', async () => {
    const receipt = { blockNumber: 100, status: 1 };
    broadcastWith(async () => receipt);
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const encryption = await import('../../../src/core/fhe/EncryptionService.js');

    const result = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');

    expect(result.txHash).toBe(SIGNED_HASH);
    expect(result.receipt).toBe(receipt);
    expect(contractStubs.getFunction).toHaveBeenCalledWith(
      'confidentialTransfer(address,bytes32,bytes)',
    );
    expect(encryption.encryptAmount).toHaveBeenCalledWith(11155111n, TOKEN, USER, 5n);
    expect(contractStubs.confidentialTransfer.estimateGas).toHaveBeenCalledWith(
      RECIPIENT,
      '0xhandle',
      '0xproof',
    );
    // 100k estimate + 20% buffer, on the standard function
    expect(contractStubs.confidentialTransfer.populateTransaction).toHaveBeenCalledWith(
      RECIPIENT,
      '0xhandle',
      '0xproof',
      { gasLimit: 120_000n },
    );
    expect(fakeProvider.broadcastTransaction).toHaveBeenCalledWith(SIGNED);
  });

  it('reports signed and broadcast through the send hooks, with the hash', async () => {
    broadcastWith(async () => ({ blockNumber: 1, status: 1 }));
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const prepared = await prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    const seen: string[] = [];
    await prepared.send({
      onSigned: (h) => seen.push(`signed:${h}`),
      onBroadcast: (h) => {
        seen.push(`broadcast:${h}`);
        throw new Error('a broken UI callback must not fail the send');
      },
    });
    expect(seen).toEqual([`signed:${SIGNED_HASH}`, `broadcast:${SIGNED_HASH}`]);
  });

  it('refuses when the RPC serves a different chain', async () => {
    fakeProvider.send.mockResolvedValue('0x1'); // mainnet id while sending on sepolia
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const encryption = await import('../../../src/core/fhe/EncryptionService.js');
    await expect(
      prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN' });
    expect(encryption.encryptAmount).not.toHaveBeenCalled();
  });

  it('stops before encrypting when the amount exceeds the decrypted balance', async () => {
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const encryption = await import('../../../src/core/fhe/EncryptionService.js');
    await expect(
      prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 10_000n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_TOKEN_BALANCE' });
    expect(encryption.encryptAmount).not.toHaveBeenCalled();
  });

  it('a failed pre-send decrypt is BALANCE_CHECK_FAILED, and nothing is encrypted', async () => {
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    vi.mocked(decryption.decryptBalance).mockRejectedValueOnce(new Error('relayer said 502'));
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const encryption = await import('../../../src/core/fhe/EncryptionService.js');
    const err = await prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch(
      (e) => e,
    );
    expect(err).toMatchObject({ code: 'BALANCE_CHECK_FAILED' });
    expect(err.likelyCause).toMatch(/Nothing was sent/);
    expect(encryption.encryptAmount).not.toHaveBeenCalled();
  });

  it('a relayer timeout during the pre-send decrypt is also BALANCE_CHECK_FAILED', async () => {
    const { TimeoutError } = await import('../../../src/utils/timeout.js');
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    vi.mocked(decryption.decryptBalance).mockRejectedValueOnce(
      new TimeoutError('Decrypting the balance', 120_000),
    );
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(
      prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'BALANCE_CHECK_FAILED' });
  });

  it('an unreachable RPC during the balance read keeps the RPC wording', async () => {
    contractStubs.confidentialBalanceOf.mockRejectedValueOnce(
      Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' }),
    );
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(
      prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });

  it('a contract revert while reading the balance keeps its meaning (not BALANCE_CHECK_FAILED)', async () => {
    contractStubs.confidentialBalanceOf.mockRejectedValueOnce(
      Object.assign(new Error('execution reverted'), {
        code: 'CALL_EXCEPTION',
        action: 'call',
        data: '0x',
        reason: null,
      }),
    );
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch(
      (e) => e,
    );
    expect(err.code).toBe('NOT_ERC7984');
    expect(err.message).toBe('That address is not an ERC-7984 token on sepolia.');
  });

  it('a relayer answer it cannot read during the pre-send decrypt names the relayer', async () => {
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    vi.mocked(decryption.decryptBalance).mockRejectedValueOnce(
      new Error("Relayer didn't response correctly. Bad JSON."),
    );
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch(
      (e) => e,
    );
    expect(err.code).toBe('BALANCE_CHECK_FAILED');
    expect(err.likelyCause).toMatch(/relayer failed/);
    expect(`${err.message} ${err.likelyCause} ${err.hint}`).not.toMatch(/RPC settings/i);
  });

  it('re-checks the balance at the block that mined the transfer', async () => {
    broadcastWith(async () => ({ status: 1, blockNumber: 1234 }));
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    expect(contractStubs.confidentialBalanceOf).toHaveBeenLastCalledWith(USER, {
      blockTag: 1234,
    });
  });

  it('sending the whole balance is allowed', async () => {
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const prepared = await prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 9_999n, 'sepolia');
    expect(prepared.tokenBalance).toBe(9_999n);
  });

  it('reports "moved" when the re-decrypted balance dropped by the amount', async () => {
    broadcastWith(async () => ({ status: 1, blockNumber: 1 }));
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    vi.mocked(decryption.decryptBalance)
      .mockResolvedValueOnce(9_999n)
      .mockResolvedValueOnce(9_994n);
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const res = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    expect(res.balanceCheck).toBe('moved');
    expect(res.balanceAfter).toBe(9_994n);
  });

  it('reports "unchanged" when the transfer silently moved 0', async () => {
    broadcastWith(async () => ({ status: 1, blockNumber: 1 }));
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const res = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    expect(res.balanceCheck).toBe('unchanged');
    expect(res.balanceAfter).toBe(9_999n);
  });

  it('a failed re-decrypt after confirmation is "unknown", not an error', async () => {
    broadcastWith(async () => ({ status: 1, blockNumber: 1 }));
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    vi.mocked(decryption.decryptBalance)
      .mockResolvedValueOnce(9_999n)
      .mockRejectedValueOnce(new Error('relayer busy'))
      .mockRejectedValueOnce(new Error('relayer busy'))
      .mockRejectedValueOnce(new Error('relayer busy'));
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const res = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    expect(res.txHash).toBe(SIGNED_HASH);
    expect(res.balanceCheck).toBe('unknown');
    expect(res.balanceAfter).toBeUndefined();
  });

  it('re-reads the balance when the first read after confirmation fails (lagging node)', async () => {
    broadcastWith(async () => ({ status: 1, blockNumber: 1 }));
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    vi.mocked(decryption.decryptBalance)
      .mockResolvedValueOnce(9_999n)
      .mockRejectedValueOnce(new Error('header not found'))
      .mockResolvedValueOnce(9_994n);
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const res = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    expect(res.balanceCheck).toBe('moved');
  });

  it('a mined send stays a success when wait() fails on a refused full-block read', async () => {
    // nodies: "Method not available on this plan with fullTransactions=true".
    broadcastWith(async () => {
      throw ethersError('UNKNOWN_ERROR', 'could not coalesce error', {
        error: {
          code: -32601,
          message: 'Method not available on this plan with fullTransactions=true',
        },
      });
    });
    fakeProvider.getTransactionReceipt
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ hash: SIGNED_HASH, status: 1, blockNumber: 9 });
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const res = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    expect(res.txHash).toBe(SIGNED_HASH);
    expect(res.receipt.blockNumber).toBe(9);
  });

  it('a receipt polled after a failed wait() that says reverted is TX_REVERTED', async () => {
    broadcastWith(async () => {
      throw ethersError('UNKNOWN_ERROR', 'could not coalesce error', {
        error: { code: -32601, message: 'Method not available on this plan' },
      });
    });
    fakeProvider.getTransactionReceipt.mockResolvedValueOnce({ hash: SIGNED_HASH, status: 0 });
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia')).rejects.toMatchObject({
      code: 'TX_REVERTED',
      txHash: SIGNED_HASH,
    });
  });

  it('reports the fee and ETH balance before anything is signed', async () => {
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const prepared = await prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    expect(prepared.gasLimit).toBe(120_000n);
    expect(prepared.feeWei).toBe(1_200_000n);
    expect(prepared.ethBalanceWei).toBe(10n ** 18n);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(fakeProvider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('stops with INSUFFICIENT_GAS_FUNDS when ETH cannot cover the fee', async () => {
    fakeProvider.getBalance.mockResolvedValue(1n);
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(
      prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_GAS_FUNDS' });
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('translates a revert with no data during simulation into NOT_ERC7984', async () => {
    contractStubs.confidentialTransfer.estimateGas.mockRejectedValue(
      Object.assign(new Error('missing revert data (action="estimateGas", data=null)'), {
        code: 'CALL_EXCEPTION',
        action: 'estimateGas',
        data: null,
      }),
    );
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(
      prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'NOT_ERC7984' });
  });

  it('rejects zero and amounts above the euint64 range before encrypting', async () => {
    const { prepareConfidentialTransfer, MAX_EUINT64 } =
      await import('../../../src/core/token/TokenService.js');
    const encryption = await import('../../../src/core/fhe/EncryptionService.js');
    for (const bad of [0n, MAX_EUINT64 + 1n]) {
      await expect(
        prepareConfidentialTransfer(w, TOKEN, RECIPIENT, bad, 'sepolia'),
      ).rejects.toMatchObject({ code: 'AMOUNT_OUT_OF_RANGE' });
    }
    expect(encryption.encryptAmount).not.toHaveBeenCalled();
  });

  it('a signing failure is safe to retry (nothing was sent)', async () => {
    wallet.signTransaction.mockRejectedValueOnce(new Error('nonce lookup failed'));
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch((e) => e);
    expect(err.txHash).toBeUndefined();
    expect(fakeProvider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('maps a reverted receipt from wait() to TX_REVERTED with the hash and link', async () => {
    // ethers v6 wait() throws this shape for a status-0 receipt.
    broadcastWith(async () => {
      throw Object.assign(new Error('transaction execution reverted'), {
        code: 'CALL_EXCEPTION',
        action: 'sendTransaction',
        data: null,
        receipt: { hash: SIGNED_HASH, status: 0 },
      });
    });
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch((e) => e);
    expect(err).toMatchObject({ code: 'TX_REVERTED', txHash: SIGNED_HASH });
    expect(err.hint).toContain(`/tx/${SIGNED_HASH}`);
  });

  it('never says "try again" when waiting fails after broadcast', async () => {
    broadcastWith(async () => {
      throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    });
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch((e) => e);
    expect(err).toMatchObject({ code: 'SENT_UNCONFIRMED', txHash: SIGNED_HASH });
    expect(err.hint).toMatch(/Do not send again/);
    expect(err.hint).toContain(`sepolia.etherscan.io/tx/${SIGNED_HASH}`);
  });

  it('treats a timed-out broadcast as possibly sent, with the hash', async () => {
    fakeProvider.broadcastTransaction.mockRejectedValue(
      Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }),
    );
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia')).rejects.toMatchObject({
      code: 'SENT_UNCONFIRMED',
      txHash: SIGNED_HASH,
    });
  });

  it('a broadcast the node refuses outright is reported as not sent', async () => {
    fakeProvider.broadcastTransaction.mockRejectedValue(
      Object.assign(new Error('insufficient funds for gas'), { code: 'INSUFFICIENT_FUNDS' }),
    );
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia')).rejects.toMatchObject({
      code: 'INSUFFICIENT_GAS_FUNDS',
    });
  });

  it('a local bookkeeping failure after confirmation does not turn into an error', async () => {
    broadcastWith(async () => ({ status: 1, blockNumber: 7 }));
    const audit = await import('../../../src/storage/AuditLog.js');
    const spy = vi.spyOn(audit, 'logEvent').mockImplementation(() => {
      throw new Error('EISDIR: illegal operation on a directory');
    });
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const res = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    expect(res.txHash).toBe(SIGNED_HASH);
    expect(spy).toHaveBeenCalled();
  });

  it('"nonce too low" after broadcast is possibly sent, never "try again"', async () => {
    // A gateway can retry the broadcast on a second backend after the first one already
    // accepted it; the second answers "nonce too low" because of our own transaction.
    fakeProvider.broadcastTransaction.mockRejectedValue(
      ethersError('NONCE_EXPIRED', 'nonce has already been used'),
    );
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch((e) => e);
    expect(err).toMatchObject({ code: 'SENT_UNCONFIRMED', txHash: SIGNED_HASH });
    expect(err.hint).toMatch(/Do not send again/);
    expect(fakeProvider.getTransactionReceipt).toHaveBeenCalledWith(SIGNED_HASH);
  });

  it('"nonce too low" with a successful receipt for our hash is a confirmed transfer', async () => {
    const receipt = { status: 1, blockNumber: 9, hash: SIGNED_HASH };
    fakeProvider.broadcastTransaction.mockRejectedValue(
      ethersError('NONCE_EXPIRED', 'nonce too low'),
    );
    fakeProvider.getTransactionReceipt.mockResolvedValue(receipt);
    const audit = await import('../../../src/storage/AuditLog.js');
    const spy = vi.spyOn(audit, 'logEvent');
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const res = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    expect(res).toMatchObject({ txHash: SIGNED_HASH, receipt });
    // The balance re-check still runs on this path (mock balance unchanged).
    expect(res.balanceCheck).toBe('unchanged');
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      'TRANSFER_SIGNED',
      'TRANSFER_BROADCAST',
      'TRANSFER',
    ]);
  });

  it('"nonce too low" with a reverted receipt for our hash is TX_REVERTED', async () => {
    fakeProvider.broadcastTransaction.mockRejectedValue(
      ethersError('NONCE_EXPIRED', 'nonce too low'),
    );
    fakeProvider.getTransactionReceipt.mockResolvedValue({ status: 0, hash: SIGNED_HASH });
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch((e) => e);
    expect(err).toMatchObject({ code: 'TX_REVERTED', txHash: SIGNED_HASH });
  });

  it('"nonce too low" with a status-less receipt is SENT_UNCONFIRMED, not TX_REVERTED', async () => {
    fakeProvider.broadcastTransaction.mockRejectedValue(
      ethersError('NONCE_EXPIRED', 'nonce too low'),
    );
    fakeProvider.getTransactionReceipt.mockResolvedValue({ status: null, hash: SIGNED_HASH });
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch((e) => e);
    expect(err).toMatchObject({ code: 'SENT_UNCONFIRMED', txHash: SIGNED_HASH });
  });

  it('"nonce too low" stays SENT_UNCONFIRMED when the receipt lookup fails', async () => {
    fakeProvider.broadcastTransaction.mockRejectedValue(
      ethersError('NONCE_EXPIRED', 'nonce too low'),
    );
    fakeProvider.getTransactionReceipt.mockRejectedValue(ethersError('TIMEOUT', 'timeout'));
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia')).rejects.toMatchObject({
      code: 'SENT_UNCONFIRMED',
      txHash: SIGNED_HASH,
    });
  });

  it('"replacement underpriced" on broadcast is reported as not sent', async () => {
    fakeProvider.broadcastTransaction.mockRejectedValue(
      ethersError('REPLACEMENT_UNDERPRICED', 'replacement fee too low'),
    );
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch((e) => e);
    expect(err.code).toBe('NONCE_CONFLICT');
    expect(err.txHash).toBeUndefined();
  });

  it('maps TRANSACTION_REPLACED from wait() to TX_REPLACED with both hashes', async () => {
    const replacement = '0x' + 'ab'.repeat(32);
    broadcastWith(async () => {
      throw ethersError('TRANSACTION_REPLACED', 'transaction was replaced', {
        reason: 'cancelled',
        cancelled: true,
        hash: replacement, // ethers puts the replacement's hash here
        replacement: { hash: replacement },
        receipt: { hash: replacement, status: 1 },
      });
    });
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch((e) => e);
    expect(err).toMatchObject({
      code: 'TX_REPLACED',
      txHash: SIGNED_HASH,
      replacementHash: replacement,
    });
    expect(err.hint).toContain(`sepolia.etherscan.io/tx/${replacement}`);
  });

  it('logs TRANSFER_SIGNED but not TRANSFER_BROADCAST when the broadcast fails', async () => {
    fakeProvider.broadcastTransaction.mockRejectedValue(ethersError('TIMEOUT', 'timeout'));
    const audit = await import('../../../src/storage/AuditLog.js');
    const spy = vi.spyOn(audit, 'logEvent');
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await confidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia').catch(() => undefined);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['TRANSFER_SIGNED']);
    // Never the amount: the audit log must not undo the token's confidentiality.
    expect(Object.keys(spy.mock.calls[0][1]).sort()).toEqual(['network', 'to', 'token', 'txHash']);
  });

  it('a TUI send through RealBackend writes the TRANSFER_* audit trail, never the amount', async () => {
    broadcastWith(async () => ({ status: 1, blockNumber: 7 }));
    const audit = await import('../../../src/storage/AuditLog.js');
    const spy = vi.spyOn(audit, 'logEvent');
    const { RealBackend } = await import('../../../src/core/backend/RealBackend.js');
    const prepared = await new RealBackend().prepareTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia');
    const onBroadcast = vi.fn();
    const res = await prepared.send({ onBroadcast });
    expect(res.txHash).toBe(SIGNED_HASH);
    expect(onBroadcast).toHaveBeenCalledWith(SIGNED_HASH);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      'TRANSFER_SIGNED',
      'TRANSFER_BROADCAST',
      'TRANSFER',
    ]);
    for (const [, details] of spy.mock.calls) {
      expect(Object.keys(details as object)).not.toContain('amount');
      expect(JSON.stringify(details)).not.toMatch(/"5"|:5[,}]/);
    }
  });

  it('refuses to guess a zero fee when the RPC returns no gas price', async () => {
    fakeProvider.getFeeData.mockResolvedValue({ maxFeePerGas: null, gasPrice: null });
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(
      prepareConfidentialTransfer(w, TOKEN, RECIPIENT, 5n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });
});

describe('TokenService operators', () => {
  const wallet = signingWallet as never;

  beforeEach(() => {
    signingWallet.populateTransaction.mockClear();
    signingWallet.signTransaction.mockClear();
  });

  it('setOperator simulates, signs locally with a gas buffer, broadcasts and waits', async () => {
    const receipt = { status: 1 };
    broadcastWith(async () => receipt);
    const { setOperator } = await import('../../../src/core/token/TokenService.js');
    const res = await setOperator(wallet, TOKEN, RECIPIENT, 1_900_000_000, 'sepolia');
    expect(res).toEqual({ txHash: SIGNED_HASH, receipt });
    expect(contractStubs.getFunction).toHaveBeenCalledWith('setOperator(address,uint48)');
    expect(contractStubs.setOperator.estimateGas).toHaveBeenCalledWith(RECIPIENT, 1_900_000_000);
    // 50k estimate + 20% buffer
    expect(contractStubs.setOperator.populateTransaction).toHaveBeenCalledWith(
      RECIPIENT,
      1_900_000_000,
      { gasLimit: 60_000n },
    );
    expect(fakeProvider.broadcastTransaction).toHaveBeenCalledWith(SIGNED);
  });

  it('setOperator keeps the hash when the broadcast times out', async () => {
    fakeProvider.broadcastTransaction.mockRejectedValue(ethersError('TIMEOUT', 'request timeout'));
    const { setOperator } = await import('../../../src/core/token/TokenService.js');
    const err = await setOperator(wallet, TOKEN, RECIPIENT, 1_900_000_000, 'sepolia').catch(
      (e) => e,
    );
    expect(err).toMatchObject({ code: 'SENT_UNCONFIRMED', txHash: SIGNED_HASH });
    expect(err.hint).toContain(`/tx/${SIGNED_HASH}`);
  });

  it('setOperator names the operator change when it reverts on-chain', async () => {
    broadcastWith(async () => {
      throw ethersError('CALL_EXCEPTION', 'transaction execution reverted', {
        action: 'sendTransaction',
        data: null,
        receipt: { hash: SIGNED_HASH, status: 0 },
      });
    });
    const { setOperator } = await import('../../../src/core/token/TokenService.js');
    const err = await setOperator(wallet, TOKEN, RECIPIENT, 1_900_000_000, 'sepolia').catch(
      (e) => e,
    );
    expect(err).toMatchObject({ code: 'TX_REVERTED', txHash: SIGNED_HASH });
    expect(err.message).toMatch(/operator change/);
  });

  it('setOperator does not sign when the simulation fails', async () => {
    contractStubs.setOperator.estimateGas.mockRejectedValue(
      ethersError('CALL_EXCEPTION', 'reverted', { reason: 'paused' }),
    );
    const { setOperator } = await import('../../../src/core/token/TokenService.js');
    await expect(
      setOperator(wallet, TOKEN, RECIPIENT, 1_900_000_000, 'sepolia'),
    ).rejects.toMatchObject({ code: 'CONTRACT_REJECTED' });
    expect(signingWallet.signTransaction).not.toHaveBeenCalled();
  });

  it('setOperator rejects expiries outside uint48', async () => {
    const { setOperator } = await import('../../../src/core/token/TokenService.js');
    await expect(setOperator(wallet, TOKEN, RECIPIENT, -1, 'sepolia')).rejects.toThrow(/expiry/);
    await expect(setOperator(wallet, TOKEN, RECIPIENT, 2 ** 48, 'sepolia')).rejects.toThrow(
      /expiry/,
    );
  });

  it('isOperator returns a boolean', async () => {
    contractStubs.isOperator.mockResolvedValue(true);
    const { isOperator } = await import('../../../src/core/token/TokenService.js');
    expect(await isOperator(TOKEN, USER, RECIPIENT, 'sepolia')).toBe(true);
  });
});

describe('TokenService.getTxExplorerUrl', () => {
  it('uses the explorer URL from network config', async () => {
    const { getTxExplorerUrl } = await import('../../../src/core/token/TokenService.js');
    expect(getTxExplorerUrl('0xabc', 'sepolia')).toBe('https://sepolia.etherscan.io/tx/0xabc');
    expect(getTxExplorerUrl('0xabc', 'mainnet')).toBe('https://etherscan.io/tx/0xabc');
  });
});

describe('TokenService.checkBalanceAfter', () => {
  it('reports "changed" when something else moved the balance too', async () => {
    const { checkBalanceAfter } = await import('../../../src/core/token/TokenService.js');
    expect(await checkBalanceAfter(async () => 120n, 100n, 5n)).toEqual({
      balanceCheck: 'changed',
      balanceAfter: 120n,
    });
  });
});

describe('TokenService reads from an address that is not a token', () => {
  const badData = () =>
    Object.assign(new Error('could not decode result data (value="0x", ...)'), {
      code: 'BAD_DATA',
      value: '0x',
    });

  it('getTokenInfo says "not a token contract on <network>" for BAD_DATA', async () => {
    contractStubs.name.mockRejectedValueOnce(badData());
    const { getTokenInfo } = await import('../../../src/core/token/TokenService.js');
    const err = await getTokenInfo(TOKEN, 'sepolia').catch((e) => e);
    expect(err.code).toBe('NOT_A_TOKEN');
    expect(err.message).toBe('That address is not a token contract on sepolia.');
  });

  it('getTokenInfo passes other failures through unchanged', async () => {
    const down = Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' });
    contractStubs.name.mockRejectedValueOnce(down);
    const { getTokenInfo } = await import('../../../src/core/token/TokenService.js');
    await expect(getTokenInfo(TOKEN, 'sepolia')).rejects.toBe(down);
  });

  it('getEncryptedBalance says "not an ERC-7984 token" for BAD_DATA', async () => {
    contractStubs.confidentialBalanceOf.mockRejectedValueOnce(badData());
    const { getEncryptedBalance } = await import('../../../src/core/token/TokenService.js');
    await expect(getEncryptedBalance(TOKEN, RECIPIENT, 'mainnet')).rejects.toMatchObject({
      code: 'NOT_ERC7984',
      message: 'That address is not an ERC-7984 token on mainnet.',
    });
  });

  it('a failed decrypt is marked as the decrypt step', async () => {
    contractStubs.confidentialBalanceOf.mockResolvedValueOnce(5n);
    const decryption = await import('../../../src/core/fhe/DecryptionService.js');
    vi.mocked(decryption.decryptBalance).mockRejectedValueOnce(new Error('boom'));
    const { getDecryptedBalance } = await import('../../../src/core/token/TokenService.js');
    const { DecryptionFailedError } = await import('../../../src/core/token/txErrors.js');
    const err = await getDecryptedBalance(TOKEN, Wallet.createRandom(), 'sepolia', {
      forceRefresh: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DecryptionFailedError);
  });
});

describe('TokenService: an RPC error is not "not a token"', () => {
  const rateLimited = () =>
    Object.assign(new Error('missing revert data'), {
      code: 'CALL_EXCEPTION',
      action: 'call',
      data: null,
      info: { error: { code: -32005, message: 'daily request count exceeded' } },
    });

  it('getTokenInfo passes a JSON-RPC error through for the RPC wording', async () => {
    const err = rateLimited();
    contractStubs.name.mockRejectedValueOnce(err);
    const { getTokenInfo } = await import('../../../src/core/token/TokenService.js');
    await expect(getTokenInfo(TOKEN, 'sepolia')).rejects.toBe(err);
  });

  it('an empty revert is "not a token" only when the address has no code', async () => {
    const empty = () =>
      Object.assign(new Error('missing revert data'), {
        code: 'CALL_EXCEPTION',
        action: 'call',
        data: null,
      });
    const { getTokenInfo } = await import('../../../src/core/token/TokenService.js');
    fakeProvider.getCode.mockResolvedValueOnce('0x6080');
    contractStubs.name.mockRejectedValueOnce(empty());
    await expect(getTokenInfo(TOKEN, 'sepolia')).rejects.not.toMatchObject({
      code: 'NOT_A_TOKEN',
    });
    fakeProvider.getCode.mockResolvedValueOnce('0x');
    contractStubs.name.mockRejectedValueOnce(empty());
    await expect(getTokenInfo(TOKEN, 'sepolia')).rejects.toMatchObject({ code: 'NOT_A_TOKEN' });
  });
});

describe('TokenService batch decrypt and disclosure calls', () => {
  it('reads all handles, skips zero and cached ones, decrypts the rest in one session call', async () => {
    const T2 = '0x1111111111111111111111111111111111111111';
    const T3 = '0x2222222222222222222222222222222222222222';
    contractStubs.confidentialBalanceOf
      .mockResolvedValueOnce('0x' + '0'.repeat(64))
      .mockResolvedValueOnce('0x' + '1'.repeat(60) + '0500')
      .mockResolvedValueOnce('0x' + '2'.repeat(60) + '0500');
    const decrypt = vi.fn(async (pairs: Array<{ handle: string }>) => ({
      values: new Map(pairs.map((p, i) => [p.handle, BigInt(i + 10)])),
      errors: new Map(),
    }));
    const session = { address: USER, network: 'sepolia', active: true, decrypt } as never;
    const { decryptBalancesWithSession } = await import('../../../src/core/token/TokenService.js');
    const out = await decryptBalancesWithSession(session, [TOKEN, T2, T3], 'sepolia');
    expect(out.values).toEqual({ [TOKEN]: 0n, [T2]: 10n, [T3]: 11n });
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(decrypt.mock.calls[0][0]).toHaveLength(2);
    expect(decrypt.mock.calls[0][1]).toEqual([TOKEN, T2, T3]);
  });

  it('prepareDiscloseRequest simulates requestDiscloseEncryptedAmount before signing', async () => {
    const fn = Object.assign(vi.fn(), {
      estimateGas: vi.fn(async () => 40_000n),
      populateTransaction: vi.fn(),
    });
    contractStubs.getFunction.mockImplementation(() => fn);
    const { prepareDiscloseRequest } = await import('../../../src/core/token/TokenService.js');
    const h = '0x' + 'a'.repeat(60) + '0500';
    // Unknown handles are refused: the holder keeps ACL access to earlier balances.
    await expect(
      prepareDiscloseRequest(signingWallet as never, TOKEN, h, 'sepolia'),
    ).rejects.toMatchObject({ code: 'DISCLOSE_UNKNOWN_HANDLE' });
    expect(fn.estimateGas).not.toHaveBeenCalled();
    // A transfer amount from local history goes ahead.
    const { upsertTransactions } = await import('../../../src/storage/TransactionStore.js');
    upsertTransactions([
      {
        txHash: '0x' + '1'.repeat(64),
        type: 'transfer',
        tokenAddress: TOKEN,
        tokenSymbol: 'cTOK',
        from: '0x' + '9'.repeat(40),
        to: USER,
        amount: null,
        amountHandle: h.toUpperCase().replace('0X', '0x'),
        network: 'sepolia',
        blockNumber: 1,
        timestamp: new Date(0).toISOString(),
      },
    ]);
    const p = await prepareDiscloseRequest(signingWallet as never, TOKEN, h, 'sepolia');
    expect(contractStubs.getFunction).toHaveBeenCalledWith(
      'requestDiscloseEncryptedAmount(bytes32)',
    );
    expect(fn.estimateGas).toHaveBeenCalledWith(h);
    expect(p.feeWei).toBe(48_000n * 10n);
    expect(signingWallet.signTransaction).not.toHaveBeenCalled();
  });

  it('prepareDiscloseRequest refuses the wallet balance handle', async () => {
    // Regression: disclosing confidentialBalanceOf(wallet) would publish the whole balance.
    const fn = Object.assign(vi.fn(), { estimateGas: vi.fn(async () => 40_000n) });
    contractStubs.getFunction.mockImplementation(() => fn);
    const h = '0x' + 'b'.repeat(60) + '0500';
    contractStubs.confidentialBalanceOf.mockResolvedValueOnce(h);
    const { prepareDiscloseRequest } = await import('../../../src/core/token/TokenService.js');
    await expect(
      prepareDiscloseRequest(
        signingWallet as never,
        TOKEN,
        h.toUpperCase().replace('0X', '0x'),
        'sepolia',
      ),
    ).rejects.toMatchObject({ code: 'DISCLOSE_IS_BALANCE' });
    expect(fn.estimateGas).not.toHaveBeenCalled();
  });
});
