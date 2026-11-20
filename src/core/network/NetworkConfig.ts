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

/**
 * Default RPC URLs used when no custom URL is configured
 */
export const DEFAULT_RPC_URLS: Record<NetworkName, string> = {
  mainnet: 'https://eth-mainnet.public.blastapi.io',
  sepolia: 'https://ethereum-sepolia-public.nodies.app',
};

/**
 * Keyless public endpoints tried, in order, after the default when it does not answer.
 * Only used while no custom RPC is set: a custom URL is the user's explicit choice, and
 * silently replacing it with a public node would surprise them (and leak their traffic).
 */
export const FALLBACK_RPC_URLS: Record<NetworkName, readonly string[]> = {
  mainnet: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  sepolia: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'],
};

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
    return process.env.MAINNET_RPC_URL || DEFAULT_RPC_URLS.mainnet;
  }
  return process.env.SEPOLIA_RPC_URL || DEFAULT_RPC_URLS.sepolia;
}

/**
 * Every RPC URL to try for `network`, in order: just the custom URL when one is set,
 * otherwise the default followed by the public fallbacks.
 */
export function getRpcUrls(network: NetworkName): string[] {
  const custom = network === 'mainnet' ? process.env.MAINNET_RPC_URL : process.env.SEPOLIA_RPC_URL;
  if (custom) return [custom];
  return [DEFAULT_RPC_URLS[network], ...FALLBACK_RPC_URLS[network]];
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
