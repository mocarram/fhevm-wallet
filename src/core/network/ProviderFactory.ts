/**
 * Ethers provider factory
 */

import { JsonRpcProvider, Network } from 'ethers';
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

  // Create a static network to prevent auto-detection retry loop
  const staticNetwork = Network.from({
    name: config.name,
    chainId: Number(config.chainId),
  });

  const provider = new JsonRpcProvider(config.rpcUrl, staticNetwork, {
    staticNetwork,
  });

  providerCache.set(network, provider);
  return provider;
}

/**
 * Clear the provider cache for a specific network (destroys provider first)
 */
export function clearProviderForNetwork(network: NetworkName): void {
  const provider = providerCache.get(network);
  if (provider) {
    provider.destroy();
    providerCache.delete(network);
  }
}

/**
 * Clear all providers from cache (destroys each first)
 */
export function clearProviderCache(): void {
  for (const [, provider] of providerCache) {
    provider.destroy();
  }
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
