import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const TOKEN = '0xde709f2102306220921060314715629080e2fb77';
const USER = '0x52908400098527886E0F7030069857D2E4169EE7';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

const contractStubs = {
  name: vi.fn(),
  symbol: vi.fn(),
  decimals: vi.fn(),
  confidentialBalanceOf: vi.fn(),
  $_transfer: vi.fn(),
};

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  class MockContract {
    name = contractStubs.name;
    symbol = contractStubs.symbol;
    decimals = contractStubs.decimals;
    confidentialBalanceOf = contractStubs.confidentialBalanceOf;
    $_transfer = contractStubs.$_transfer;
  }
  return { ...actual, Contract: MockContract };
});

const fakeProvider = { destroy: vi.fn() };
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

describe('TokenService.confidentialTransfer', () => {
  it('encrypts, calls $_transfer, awaits receipt, and returns hash', async () => {
    const receipt = { blockNumber: 100 };
    contractStubs.$_transfer.mockResolvedValue({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue(receipt),
    });

    const { confidentialTransfer } = await import('../../../src/core/token/TokenService.js');
    const encryption = await import('../../../src/core/fhe/EncryptionService.js');

    const wallet = { address: USER, connect: () => wallet } as never;
    const result = await confidentialTransfer(wallet, TOKEN, RECIPIENT, 5n, 'sepolia');

    expect(result.txHash).toBe('0xtxhash');
    expect(result.receipt).toBe(receipt);
    expect(encryption.encryptAmount).toHaveBeenCalledWith(11155111n, TOKEN, USER, 5n);
    expect(contractStubs.$_transfer).toHaveBeenCalledWith(USER, RECIPIENT, '0xhandle', '0xproof');
  });
});

describe('TokenService.getTxExplorerUrl', () => {
  it('uses the explorer URL from network config', async () => {
    const { getTxExplorerUrl } = await import('../../../src/core/token/TokenService.js');
    expect(getTxExplorerUrl('0xabc', 'sepolia')).toBe('https://sepolia.etherscan.io/tx/0xabc');
    expect(getTxExplorerUrl('0xabc', 'mainnet')).toBe('https://etherscan.io/tx/0xabc');
  });
});
