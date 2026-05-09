import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHAIN_IDS,
  DEFAULT_RPC_URLS,
  getNetworkConfig,
  getNetworkNameFromChainId,
  isSupportedChainId,
} from '../../../src/core/network/NetworkConfig.js';

const ORIGINAL = {
  MAINNET: process.env.MAINNET_RPC_URL,
  SEPOLIA: process.env.SEPOLIA_RPC_URL,
};

beforeEach(() => {
  delete process.env.MAINNET_RPC_URL;
  delete process.env.SEPOLIA_RPC_URL;
});

afterEach(() => {
  if (ORIGINAL.MAINNET !== undefined) process.env.MAINNET_RPC_URL = ORIGINAL.MAINNET;
  if (ORIGINAL.SEPOLIA !== undefined) process.env.SEPOLIA_RPC_URL = ORIGINAL.SEPOLIA;
});

describe('NetworkConfig', () => {
  it('returns correct config for sepolia with default RPC', () => {
    const cfg = getNetworkConfig('sepolia');
    expect(cfg.chainId).toBe(CHAIN_IDS.SEPOLIA);
    expect(cfg.isTestnet).toBe(true);
    expect(cfg.rpcUrl).toBe(DEFAULT_RPC_URLS.sepolia);
  });

  it('returns correct config for mainnet with default RPC', () => {
    const cfg = getNetworkConfig('mainnet');
    expect(cfg.chainId).toBe(CHAIN_IDS.MAINNET);
    expect(cfg.isTestnet).toBe(false);
    expect(cfg.rpcUrl).toBe(DEFAULT_RPC_URLS.mainnet);
  });

  it('honors env-provided RPC URL when set', () => {
    process.env.SEPOLIA_RPC_URL = 'https://example.test/rpc';
    expect(getNetworkConfig('sepolia').rpcUrl).toBe('https://example.test/rpc');
  });

  it('maps chain ID back to network name', () => {
    expect(getNetworkNameFromChainId(CHAIN_IDS.MAINNET)).toBe('mainnet');
    expect(getNetworkNameFromChainId(CHAIN_IDS.SEPOLIA)).toBe('sepolia');
    expect(getNetworkNameFromChainId(137n)).toBeNull();
  });

  it('flags supported chain IDs', () => {
    expect(isSupportedChainId(CHAIN_IDS.MAINNET)).toBe(true);
    expect(isSupportedChainId(CHAIN_IDS.SEPOLIA)).toBe(true);
    expect(isSupportedChainId(42161n)).toBe(false);
  });
});
