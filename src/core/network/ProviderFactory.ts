/**
 * Ethers provider factory
 */

import { JsonRpcProvider } from 'ethers';
import { getNetworkConfig, NetworkName } from './NetworkConfig.js';

// Cache providers per network
const providerCache = new Map<NetworkName, JsonRpcProvider>();

/**
 * Get or create an ethers provider for the specified network
 */
export function getProvider(network: NetworkName): JsonRpcProvider {
  const cached = providerCache.get(network);
  if (cached) {
    return cached;
  }

  const config = getNetworkConfig(network);
  const provider = new JsonRpcProvider(config.rpcUrl, {
    name: config.name,
    chainId: Number(config.chainId),
  });

  providerCache.set(network, provider);
  return provider;
}

/**
 * Clear the provider cache
 */
export function clearProviderCache(): void {
  providerCache.clear();
}

/**
 * Get chain ID for a network
 */
export async function getChainId(network: NetworkName): Promise<bigint> {
  const provider = getProvider(network);
  const networkInfo = await provider.getNetwork();
  return networkInfo.chainId;
}
