/**
 * FHE instance management
 */

import {
  createInstance,
  FhevmInstance,
  FhevmInstanceConfig,
  MainnetConfig,
  SepoliaConfig,
} from '@zama-fhe/relayer-sdk/node';
import {
  CHAIN_IDS,
  isSupportedChainId,
  getNetworkNameFromChainId,
} from '../network/NetworkConfig.js';
import { getEip1193Provider } from '../network/ProviderFactory.js';
import { FHE_INIT_TIMEOUT_MS } from './timeouts.js';
import { quietSdk } from './sdkConsole.js';

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

  let config: FhevmInstanceConfig;

  const networkName = getNetworkNameFromChainId(chainId)!;
  // Our provider rather than the bare URL: the SDK then gets our RPC timeouts, fallback
  // endpoints and chain-ID check instead of ethers' 5-minute default.
  const rpc = getEip1193Provider(networkName);

  if (chainId === CHAIN_IDS.MAINNET) {
    const apiKey = process.env.ZAMA_MAINNET_API_KEY;
    if (!apiKey) {
      throw new Error('Mainnet requires ZAMA_MAINNET_API_KEY');
    }
    config = {
      ...MainnetConfig,
      network: rpc,
      auth: {
        __type: 'ApiKeyHeader',
        value: apiKey,
      },
    };
  } else {
    config = {
      ...SepoliaConfig,
      network: rpc,
    };
  }

  const instance = await quietSdk(
    // createInstance prints a deprecation notice (and TFHE init notes) to the console;
    // captured so they never corrupt the TUI or --json output. See sdkConsole.ts.
    () => createInstance(config),
    { ms: FHE_INIT_TIMEOUT_MS, what: 'Connecting to the Zama relayer' },
  );
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

/**
 * Check if mainnet FHE operations are ready (API key is set)
 */
export function isMainnetReady(): boolean {
  return !!process.env.ZAMA_MAINNET_API_KEY;
}

/**
 * Check if FHE operations can proceed for the given network
 * Returns an error message if not ready, or null if ready
 */
export function checkFheReadiness(network: 'mainnet' | 'sepolia'): string | null {
  if (network === 'mainnet' && !isMainnetReady()) {
    return 'Mainnet FHE operations require a Zama API key.\nSet it via: fhevm-wallet interactive → Configuration → Settings → Zama Mainnet API Key';
  }
  return null;
}
