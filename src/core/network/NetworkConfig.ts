/**
 * Network configuration for supported chains
 */

export interface NetworkConfig {
  name: string;
  chainId: bigint;
  chainIdNumber: number;
  rpcUrl: string;
  explorerUrl: string;
  isTestnet: boolean;
}

export const CHAIN_IDS = {
  MAINNET: 1n,
  SEPOLIA: 11155111n,
} as const;

export type NetworkName = 'mainnet' | 'sepolia';

export const NETWORK_CONFIGS: Record<NetworkName, Omit<NetworkConfig, 'rpcUrl'>> = {
  mainnet: {
    name: 'Ethereum Mainnet',
    chainId: CHAIN_IDS.MAINNET,
    chainIdNumber: 1,
    explorerUrl: 'https://etherscan.io',
    isTestnet: false,
  },
  sepolia: {
    name: 'Sepolia',
    chainId: CHAIN_IDS.SEPOLIA,
    chainIdNumber: 11155111,
    explorerUrl: 'https://sepolia.etherscan.io',
    isTestnet: true,
  },
};

/**
 * Get network configuration by name
 */
export function getNetworkConfig(network: NetworkName): NetworkConfig {
  const config = NETWORK_CONFIGS[network];
  const rpcUrl = getRpcUrl(network);

  return {
    ...config,
    rpcUrl,
  };
}

/**
 * Get RPC URL from environment or use defaults
 */
function getRpcUrl(network: NetworkName): string {
  if (network === 'mainnet') {
    return process.env.MAINNET_RPC_URL || 'https://eth.drpc.org';
  }
  return process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org';
}

/**
 * Get network name from chain ID
 */
export function getNetworkNameFromChainId(chainId: bigint): NetworkName | null {
  if (chainId === CHAIN_IDS.MAINNET) return 'mainnet';
  if (chainId === CHAIN_IDS.SEPOLIA) return 'sepolia';
  return null;
}

/**
 * Check if a chain ID is supported
 */
export function isSupportedChainId(chainId: bigint): boolean {
  return chainId === CHAIN_IDS.MAINNET || chainId === CHAIN_IDS.SEPOLIA;
}
