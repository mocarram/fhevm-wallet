import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderCache,
  clearProviderForNetwork,
  getProvider,
} from '../../../src/core/network/ProviderFactory.js';

beforeEach(() => {
  clearProviderCache();
});

afterEach(() => {
  clearProviderCache();
});

describe('ProviderFactory', () => {
  it('returns the same instance across calls (cache hit)', () => {
    const a = getProvider('sepolia');
    const b = getProvider('sepolia');
    expect(a).toBe(b);
  });

  it('returns distinct instances per network', () => {
    const sepolia = getProvider('sepolia');
    const mainnet = getProvider('mainnet');
    expect(sepolia).not.toBe(mainnet);
  });

  it('clearProviderForNetwork removes only the targeted network', () => {
    const sepolia1 = getProvider('sepolia');
    const mainnet1 = getProvider('mainnet');

    clearProviderForNetwork('sepolia');

    const sepolia2 = getProvider('sepolia');
    const mainnet2 = getProvider('mainnet');

    expect(sepolia2).not.toBe(sepolia1);
    expect(mainnet2).toBe(mainnet1);
  });

  it('clearProviderCache wipes all entries', () => {
    const sepolia1 = getProvider('sepolia');
    const mainnet1 = getProvider('mainnet');

    clearProviderCache();

    const sepolia2 = getProvider('sepolia');
    const mainnet2 = getProvider('mainnet');

    expect(sepolia2).not.toBe(sepolia1);
    expect(mainnet2).not.toBe(mainnet1);
  });

  it('exposes the configured static chainId without RPC', async () => {
    const provider = getProvider('sepolia');
    const network = await provider.getNetwork();
    expect(network.chainId).toBe(11155111n);
  });
});
