import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAIN_IDS } from '../../../src/core/network/NetworkConfig.js';
import { makeMockFhevmInstance } from '../../helpers/mockFhe.js';

const mockInstance = makeMockFhevmInstance();
const createInstance = vi.fn(async () => mockInstance);

vi.mock('@zama-fhe/relayer-sdk/node', () => ({
  createInstance,
  MainnetConfig: { network: 'mainnet-default-rpc' },
  SepoliaConfig: { network: 'sepolia-default-rpc' },
}));

beforeEach(() => {
  createInstance.mockClear();
  delete process.env.ZAMA_MAINNET_API_KEY;
});

afterEach(async () => {
  const { clearFheInstanceCache } = await import('../../../src/core/fhe/FheService.js');
  clearFheInstanceCache();
});

describe('FheService', () => {
  it('isFheSupported reflects supported chain IDs', async () => {
    const { isFheSupported } = await import('../../../src/core/fhe/FheService.js');
    expect(isFheSupported(CHAIN_IDS.SEPOLIA)).toBe(true);
    expect(isFheSupported(42n)).toBe(false);
  });

  it('throws on unsupported chain', async () => {
    const { getFheInstance } = await import('../../../src/core/fhe/FheService.js');
    await expect(getFheInstance(42n)).rejects.toThrow(/not supported/);
  });

  it('Sepolia path does not require an API key', async () => {
    const { getFheInstance } = await import('../../../src/core/fhe/FheService.js');
    const instance = await getFheInstance(CHAIN_IDS.SEPOLIA);
    expect(instance).toBe(mockInstance);
    expect(createInstance).toHaveBeenCalledOnce();
  });

  it('caches instances per chain', async () => {
    const { getFheInstance } = await import('../../../src/core/fhe/FheService.js');
    await getFheInstance(CHAIN_IDS.SEPOLIA);
    await getFheInstance(CHAIN_IDS.SEPOLIA);
    expect(createInstance).toHaveBeenCalledOnce();
  });

  it('Mainnet without key throws, with key passes auth header', async () => {
    const { getFheInstance } = await import('../../../src/core/fhe/FheService.js');
    await expect(getFheInstance(CHAIN_IDS.MAINNET)).rejects.toThrow(/ZAMA_MAINNET_API_KEY/);

    process.env.ZAMA_MAINNET_API_KEY = 'secret-key';
    await getFheInstance(CHAIN_IDS.MAINNET);
    const call = createInstance.mock.calls.at(-1)![0] as { auth?: { value: string } };
    expect(call.auth?.value).toBe('secret-key');
  });

  it('checkFheReadiness flags missing mainnet API key', async () => {
    const { checkFheReadiness } = await import('../../../src/core/fhe/FheService.js');
    expect(checkFheReadiness('sepolia')).toBeNull();
    expect(checkFheReadiness('mainnet')).toMatch(/Zama API key/);

    process.env.ZAMA_MAINNET_API_KEY = 'k';
    expect(checkFheReadiness('mainnet')).toBeNull();
  });
});
