/**
 * FHE instance management.
 *
 * The relayer SDK is imported on first use, not at start-up: it costs about 200 ms and a
 * WebAssembly module, which commands like `--version`, `wallet list` or `history` never
 * need. Creating an instance takes seconds (it downloads the relayer's public key and
 * parameters), so concurrent callers share one in-flight creation, and the cache is keyed
 * by chain and, on mainnet, by the API key: a key changed in the TUI must not keep using
 * an instance built with the old one.
 */

import type { FhevmInstance, FhevmInstanceConfig } from '@zama-fhe/relayer-sdk/node';
import {
  CHAIN_IDS,
  isSupportedChainId,
  getNetworkNameFromChainId,
} from '../network/NetworkConfig.js';
import { getEip1193Provider } from '../network/ProviderFactory.js';
import { FHE_INIT_TIMEOUT_MS } from './timeouts.js';
import { quietSdk } from './sdkConsole.js';

/** The relayer SDK module, loaded once on first use. */
let sdkModule: Promise<typeof import('@zama-fhe/relayer-sdk/node')> | null = null;

/** Load the relayer SDK (once). Exported for code that needs other SDK functions. */
export function loadRelayerSdk(): Promise<typeof import('@zama-fhe/relayer-sdk/node')> {
  sdkModule ??= import('@zama-fhe/relayer-sdk/node').catch((err) => {
    sdkModule = null; // a failed load may be retried
    throw err;
  });
  return sdkModule;
}

/** Instances (or their creation in flight) per chain and API key. */
const fheInstanceCache = new Map<string, { chainId: bigint; instance: Promise<FhevmInstance> }>();

/** Cache key: the chain, plus the mainnet API key (changing it builds a new instance). */
function cacheKey(chainId: bigint): string {
  return chainId === CHAIN_IDS.MAINNET
    ? `${chainId}:${process.env.ZAMA_MAINNET_API_KEY ?? ''}`
    : String(chainId);
}

/**
 * Get or create an FHE instance for the specified chain. Callers that ask while one is
 * being created wait for the same one; a failed creation is not cached.
 */
export async function getFheInstance(chainId: bigint): Promise<FhevmInstance> {
  if (!isSupportedChainId(chainId)) {
    throw new Error(`Chain ID ${chainId} is not supported for FHE operations`);
  }
  if (chainId === CHAIN_IDS.MAINNET && !process.env.ZAMA_MAINNET_API_KEY) {
    throw new Error('Mainnet requires ZAMA_MAINNET_API_KEY');
  }
  const key = cacheKey(chainId);
  const cached = fheInstanceCache.get(key);
  if (cached) return cached.instance;

  const instance = createFheInstance(chainId);
  fheInstanceCache.set(key, { chainId, instance });
  instance.catch(() => {
    if (fheInstanceCache.get(key)?.instance === instance) fheInstanceCache.delete(key);
  });
  return instance;
}

/** Build a new instance (no cache). */
async function createFheInstance(chainId: bigint): Promise<FhevmInstance> {
  const { createInstance, MainnetConfig, SepoliaConfig } = await loadRelayerSdk();
  const networkName = getNetworkNameFromChainId(chainId)!;
  // Our provider rather than the bare URL: the SDK then gets our RPC timeouts, fallback
  // endpoints and chain-ID check instead of ethers' 5-minute default.
  const rpc = getEip1193Provider(networkName);

  let config: FhevmInstanceConfig;
  if (chainId === CHAIN_IDS.MAINNET) {
    config = {
      ...MainnetConfig,
      network: rpc,
      auth: { __type: 'ApiKeyHeader', value: process.env.ZAMA_MAINNET_API_KEY! },
    };
  } else {
    config = { ...SepoliaConfig, network: rpc };
  }

  return quietSdk(
    // createInstance prints a deprecation notice (and TFHE init notes) to the console;
    // captured so they never corrupt the TUI or --json output. See sdkConsole.ts.
    () => createInstance(config),
    { ms: FHE_INIT_TIMEOUT_MS, what: 'Connecting to the Zama relayer' },
  );
}

/**
 * Start creating the instance for `network` in the background, so the first encryption
 * or decryption does not wait for it (it takes about 4 s on Sepolia). Never throws; a
 * failure is retried by the next real call.
 */
export function warmUpFheInstance(network: 'mainnet' | 'sepolia'): void {
  getFheInstanceForNetwork(network).catch(() => undefined);
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
  for (const [key, entry] of fheInstanceCache) {
    if (chainId === undefined || entry.chainId === chainId) fheInstanceCache.delete(key);
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
