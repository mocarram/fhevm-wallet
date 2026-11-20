import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface, ZeroHash, zeroPadValue } from 'ethers';
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
  confidentialTransfer: Object.assign(vi.fn(), { estimateGas: vi.fn() }),
  getFunction: vi.fn(),
  setOperator: Object.assign(vi.fn(), { estimateGas: vi.fn() }),
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
    setOperator = contractStubs.setOperator;
    isOperator = contractStubs.isOperator;
  }
  return { ...actual, Contract: MockContract };
});

const fakeProvider = {
  destroy: vi.fn(),
  getFeeData: vi.fn(),
  getBalance: vi.fn(),
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

beforeEach(() => {
  wipeTestDataDir();
  Object.values(contractStubs).forEach((fn) => fn.mockReset());
  contractStubs.confidentialTransfer.estimateGas.mockReset();
  contractStubs.setOperator.estimateGas.mockReset();
  contractStubs.setOperator.estimateGas.mockResolvedValue(50_000n);
  contractStubs.getFunction.mockImplementation(() => contractStubs.confidentialTransfer);
  fakeProvider.getFeeData.mockResolvedValue({ maxFeePerGas: 10n, gasPrice: null });
  fakeProvider.getBalance.mockResolvedValue(10n ** 18n);
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

describe('TokenService.confidentialTransfer', () => {
  const wallet = { address: USER, connect: () => wallet } as never;

  it('simulates then sends confidentialTransfer(to, handle, proof) with a gas buffer', async () => {
    const receipt = { blockNumber: 100, status: 1 };
    contractStubs.confidentialTransfer.mockResolvedValue({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue(receipt),
    });

    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const encryption = await import('../../../src/core/fhe/EncryptionService.js');

    const result = await confidentialTransfer(wallet, TOKEN, RECIPIENT, 5n, 'sepolia');

    expect(result.txHash).toBe('0xtxhash');
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
    // 100k estimate + 20% buffer
    expect(contractStubs.confidentialTransfer).toHaveBeenCalledWith(
      RECIPIENT,
      '0xhandle',
      '0xproof',
      { gasLimit: 120_000n },
    );
  });

  it('reports the fee and ETH balance before anything is signed', async () => {
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const prepared = await prepareConfidentialTransfer(wallet, TOKEN, RECIPIENT, 5n, 'sepolia');
    expect(prepared.gasLimit).toBe(120_000n);
    expect(prepared.feeWei).toBe(1_200_000n);
    expect(prepared.ethBalanceWei).toBe(10n ** 18n);
    expect(contractStubs.confidentialTransfer).not.toHaveBeenCalled();
  });

  it('stops with INSUFFICIENT_GAS_FUNDS when ETH cannot cover the fee', async () => {
    fakeProvider.getBalance.mockResolvedValue(1n);
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(
      prepareConfidentialTransfer(wallet, TOKEN, RECIPIENT, 5n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_GAS_FUNDS' });
    expect(contractStubs.confidentialTransfer).not.toHaveBeenCalled();
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
      prepareConfidentialTransfer(wallet, TOKEN, RECIPIENT, 5n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'NOT_ERC7984' });
  });

  it('rejects zero and amounts above the euint64 range before encrypting', async () => {
    const { prepareConfidentialTransfer, MAX_EUINT64 } =
      await import('../../../src/core/token/TokenService.js');
    const encryption = await import('../../../src/core/fhe/EncryptionService.js');
    for (const bad of [0n, MAX_EUINT64 + 1n]) {
      await expect(
        prepareConfidentialTransfer(wallet, TOKEN, RECIPIENT, bad, 'sepolia'),
      ).rejects.toMatchObject({ code: 'AMOUNT_OUT_OF_RANGE' });
    }
    expect(encryption.encryptAmount).not.toHaveBeenCalled();
  });

  it('maps a reverted receipt from wait() to TX_REVERTED with the hash', async () => {
    // ethers v6 wait() throws this shape for a status-0 receipt.
    contractStubs.confidentialTransfer.mockResolvedValue({
      hash: '0xbad',
      wait: vi.fn().mockRejectedValue(
        Object.assign(new Error('transaction execution reverted'), {
          code: 'CALL_EXCEPTION',
          action: 'sendTransaction',
          data: null,
          receipt: { hash: '0xbad', status: 0 },
        }),
      ),
    });
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(
      confidentialTransfer(wallet, TOKEN, RECIPIENT, 5n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'TX_REVERTED', txHash: '0xbad' });
  });

  it('never says "try again" when waiting fails after broadcast', async () => {
    contractStubs.confidentialTransfer.mockResolvedValue({
      hash: '0xsent',
      wait: vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
    });
    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const err = await confidentialTransfer(wallet, TOKEN, RECIPIENT, 5n, 'sepolia').catch((e) => e);
    expect(err).toMatchObject({ code: 'SENT_UNCONFIRMED', txHash: '0xsent' });
    expect(err.hint).toMatch(/Do not send again/);
    expect(err.hint).toMatch(/sepolia\.etherscan\.io\/tx\/0xsent/);
  });

  it('refuses to guess a zero fee when the RPC returns no gas price', async () => {
    fakeProvider.getFeeData.mockResolvedValue({ maxFeePerGas: null, gasPrice: null });
    const { prepareConfidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    await expect(
      prepareConfidentialTransfer(wallet, TOKEN, RECIPIENT, 5n, 'sepolia'),
    ).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });
});

describe('TokenService operators', () => {
  const wallet = { address: USER, connect: () => wallet } as never;

  it('setOperator passes operator and expiry and waits for the receipt', async () => {
    contractStubs.setOperator.mockResolvedValue({
      hash: '0xop',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    });
    const { setOperator } = await import('../../../src/core/token/TokenService.js');
    const res = await setOperator(wallet, TOKEN, RECIPIENT, 1_900_000_000, 'sepolia');
    expect(res.txHash).toBe('0xop');
    expect(contractStubs.setOperator).toHaveBeenCalledWith(RECIPIENT, 1_900_000_000);
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
