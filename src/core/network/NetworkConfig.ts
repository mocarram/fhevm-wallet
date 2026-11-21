/**
 * Network configuration for supported chains
 */

import { validateRpcUrl } from '../../utils/rpcUrl.js';

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
 * Default RPC URLs used when no custom URL is configured.
 *
 * Sepolia (measured Nov 2026): publicnode answers address-filtered eth_getLogs over
 * 30,000+ blocks but keeps only about a week of logs ("pruned history unavailable") and
 * refuses topic-only queries; nodies keeps old logs but caps eth_getLogs at 50 blocks.
 * drpc refuses Sepolia on its free plan (HTTP 400) and was dropped.
 *
 * Mainnet is not reachable from the environment this was tested in. publicnode comes
 * first by analogy with its Sepolia endpoint (same operator); the others are the
 * previous defaults. Unverified.
 */
export const DEFAULT_RPC_URLS: Record<NetworkName, string> = {
  mainnet: 'https://ethereum-rpc.publicnode.com',
  sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
};

/**
 * Keyless public endpoints tried, in order, after the default when it does not answer.
 * Only used while no custom RPC is set: a custom URL is the user's explicit choice, and
 * silently replacing it with a public node would surprise them (and leak their traffic).
 */
export const FALLBACK_RPC_URLS: Record<NetworkName, readonly string[]> = {
  mainnet: ['https://eth-mainnet.public.blastapi.io', 'https://eth.drpc.org'],
  sepolia: ['https://ethereum-sepolia-public.nodies.app'],
};

/** True when `network` uses the built-in public endpoints (no valid custom RPC URL). */
export function usesPublicRpc(network: NetworkName): boolean {
  const custom = process.env[network === 'mainnet' ? 'MAINNET_RPC_URL' : 'SEPOLIA_RPC_URL'];
  return !custom?.trim() || validateRpcUrl(custom.trim()) !== null;
}

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

/** Get the RPC URL tried first for `network`. */
function getRpcUrl(network: NetworkName): string {
  return getRpcUrls(network)[0];
}

/** Custom URLs already reported as invalid, so the notice is printed once per process. */
const reportedInvalid = new Set<string>();

/** Why the custom RPC URL in `key` is ignored, or null when it is unset or valid. */
export function invalidRpcReason(key: 'MAINNET_RPC_URL' | 'SEPOLIA_RPC_URL'): string | null {
  const custom = process.env[key]?.trim();
  return custom ? validateRpcUrl(custom) : null;
}

/**
 * The custom RPC URL settings that will be ignored, for one startup notice. Marks them
 * reported, so `getRpcUrls` does not repeat the notice later.
 */
export function takeInvalidRpcSettings(): { key: string; reason: string }[] {
  const out: { key: string; reason: string }[] = [];
  for (const key of ['MAINNET_RPC_URL', 'SEPOLIA_RPC_URL'] as const) {
    const reason = invalidRpcReason(key);
    const value = process.env[key]?.trim();
    if (reason && value && !reportedInvalid.has(value)) {
      reportedInvalid.add(value);
      out.push({ key, reason });
    }
  }
  return out;
}

/**
 * Every RPC URL to try for `network`, in order: just the custom URL when one is set,
 * otherwise the default followed by the public fallbacks.
 *
 * A custom URL from the environment or ./.env is checked like one typed into `fhew config`
 * (https, or plain http only to localhost). An invalid one is ignored with a notice on
 * stderr: a key sent over plain http to a remote host could be read in transit.
 */
export function getRpcUrls(network: NetworkName): string[] {
  const key = network === 'mainnet' ? 'MAINNET_RPC_URL' : 'SEPOLIA_RPC_URL';
  const custom = process.env[key]?.trim();
  if (custom) {
    const problem = validateRpcUrl(custom);
    if (!problem) return [custom];
    if (!reportedInvalid.has(custom)) {
      reportedInvalid.add(custom);
      process.stderr.write(`Ignoring ${key}: ${problem} Using the default endpoints.\n`);
    }
  }
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
