/**
 * FHE instance management
 */

import {
  createInstance,
  FhevmInstance,
  MainnetConfig,
  SepoliaConfig,
} from '@zama-fhe/relayer-sdk/node';
import { CHAIN_IDS, isSupportedChainId } from '../network/NetworkConfig.js';

// Cache instances per chain ID
const fheInstanceCache = new Map<bigint, FhevmInstance>();

/**
 * Get or create an FHE instance for the specified chain
 */
export async function getFheInstance(chainId: bigint): Promise<FhevmInstance> {
  if (!isSupportedChainId(chainId)) {
    throw new Error(`Chain ID ${chainId} is not supported for FHE operations`);
  }

  const cached = fheInstanceCache.get(chainId);
  if (cached) {
    return cached;
  }

  const config = chainId === CHAIN_IDS.MAINNET ? MainnetConfig : SepoliaConfig;

  const instance = await createInstance(config);
  fheInstanceCache.set(chainId, instance);

  return instance;
}

/**
 * Get FHE instance for a network name
 */
export async function getFheInstanceForNetwork(
  network: 'mainnet' | 'sepolia',
): Promise<FhevmInstance> {
  const chainId = network === 'mainnet' ? CHAIN_IDS.MAINNET : CHAIN_IDS.SEPOLIA;
  return getFheInstance(chainId);
}

/**
 * Clear the FHE instance cache
 */
export function clearFheInstanceCache(chainId?: bigint): void {
  if (chainId !== undefined) {
    fheInstanceCache.delete(chainId);
  } else {
    fheInstanceCache.clear();
  }
}

/**
 * Check if FHE is supported for a chain
 */
export function isFheSupported(chainId: bigint): boolean {
  return isSupportedChainId(chainId);
}
