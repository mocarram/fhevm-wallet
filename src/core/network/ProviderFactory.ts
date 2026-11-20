/**
 * Ethers provider factory: timeouts, fallback endpoints and a chain-ID check.
 */

import {
  FetchRequest,
  JsonRpcPayload,
  JsonRpcProvider,
  JsonRpcResult,
  Network,
  type Eip1193Provider,
} from 'ethers';
import { getNetworkConfig, getRpcUrls, NetworkName } from './NetworkConfig.js';

/** Per-request timeout for JSON-RPC calls. ethers' default is 5 minutes, which freezes the UI. */
export const RPC_TIMEOUT_MS = 20_000;

/** Timeout for a quick "which chain are you?" probe when the user sets a custom RPC. */
export const RPC_PROBE_TIMEOUT_MS = 8_000;

/** Build a fetch request with our timeout applied. */
function rpcRequest(url: string, timeoutMs = RPC_TIMEOUT_MS): FetchRequest {
  const req = new FetchRequest(url);
  req.timeout = timeoutMs;
  return req;
}

/**
 * Thrown when an RPC endpoint answers for a different chain than the network we use it for.
 * `code` lets `translateTxError` recognise it without importing this module.
 */
export class WrongChainError extends Error {
  readonly code = 'WRONG_CHAIN';
  constructor(
    readonly servedChainId: bigint,
    readonly expectedChainId: bigint,
  ) {
    super(
      `The RPC endpoint serves chain ${servedChainId}, but this network is chain ${expectedChainId}.`,
    );
    this.name = 'WrongChainError';
  }
}

/**
 * A JSON-RPC provider that tries the next URL when one does not answer, and checks the
 * chain ID once before its first real request.
 *
 * Fail-over only covers transport failures (timeout, connection refused, HTTP 5xx/429):
 * a JSON-RPC error reply (a revert, say) is a real answer and comes back unchanged.
 * `eth_sendRawTransaction` is never retried on another node: if the first attempt timed
 * out the transaction may already be in a mempool, and the caller reports it as
 * "sent, not confirmed" with its hash instead.
 */
export class FailoverJsonRpcProvider extends JsonRpcProvider {
  readonly urls: readonly string[];
  readonly #timeoutMs: number;
  readonly #expectedChainId: bigint;
  #index = 0;
  #chainCheck: Promise<void> | null = null;

  constructor(urls: string[], network: Network, timeoutMs = RPC_TIMEOUT_MS) {
    if (urls.length === 0) throw new Error('At least one RPC URL is required');
    super(rpcRequest(urls[0], timeoutMs), network, { staticNetwork: network });
    this.urls = urls;
    this.#timeoutMs = timeoutMs;
    this.#expectedChainId = network.chainId;
  }

  /** The endpoint currently in use. */
  get currentUrl(): string {
    return this.urls[this.#index];
  }

  override _getConnection(): FetchRequest {
    return rpcRequest(this.currentUrl, this.#timeoutMs);
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    // Verify the chain on first use in every process, so a wrong URL in .env (edited by
    // hand, or set before this check existed) is caught before any balance or send.
    this.#chainCheck ??= this.#checkChain().catch((err: unknown) => {
      // A network blip should not stick; a wrong chain should (until the URL changes).
      if (!(err instanceof WrongChainError)) this.#chainCheck = null;
      throw err;
    });
    await this.#chainCheck;
    return this.#sendWithFailover(payload);
  }

  async #checkChain(): Promise<void> {
    const [reply] = await this.#sendWithFailover({
      id: 0,
      jsonrpc: '2.0',
      method: 'eth_chainId',
      params: [],
    });
    if (!reply || !('result' in reply))
      throw new Error('The RPC endpoint did not report its chain ID');
    const served = BigInt(reply.result as string);
    if (served !== this.#expectedChainId) throw new WrongChainError(served, this.#expectedChainId);
  }

  async #sendWithFailover(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const methods = (Array.isArray(payload) ? payload : [payload]).map((p) => p.method);
    const canFailOver = this.urls.length > 1 && !methods.includes('eth_sendRawTransaction');
    let lastError: unknown;
    for (let attempt = 0; attempt < (canFailOver ? this.urls.length : 1); attempt++) {
      try {
        return await super._send(payload);
      } catch (err) {
        lastError = err;
        if (canFailOver) this.#index = (this.#index + 1) % this.urls.length;
      }
    }
    throw lastError;
  }
}

// Cache providers per network
const providerCache = new Map<NetworkName, FailoverJsonRpcProvider>();

/**
 * Get or create an ethers provider for the specified network
 */
export function getProvider(network: NetworkName): FailoverJsonRpcProvider {
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

  const provider = new FailoverJsonRpcProvider(getRpcUrls(network), staticNetwork);

  providerCache.set(network, provider);
  return provider;
}

/**
 * An EIP-1193 view of our provider for the relayer SDK, so its RPC reads get the same
 * timeouts, fallback endpoints and chain check as everything else. Looks the provider up
 * on every request so a changed RPC setting takes effect immediately.
 */
export function getEip1193Provider(network: NetworkName): Eip1193Provider {
  return {
    request: ({ method, params }) =>
      getProvider(network).send(method, (params as unknown[] | Record<string, unknown>) ?? []),
  };
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

/** Result of probing an RPC endpoint. */
export interface RpcProbe {
  chainId: bigint;
  latencyMs: number;
}

/**
 * Ask an RPC endpoint which chain it serves, with a short timeout.
 *
 * A single raw request rather than a throwaway provider: a provider without a static
 * network would keep retrying network detection (and logging) when the URL is wrong.
 */
export async function probeRpc(url: string, timeoutMs = RPC_PROBE_TIMEOUT_MS): Promise<RpcProbe> {
  const req = rpcRequest(url, timeoutMs);
  req.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  req.setHeader('content-type', 'application/json');
  req.retryFunc = async () => false; // a probe should answer once, quickly
  const started = Date.now();
  const res = await req.send();
  res.assertOk();
  const body = res.bodyJson as { result?: unknown };
  if (typeof body?.result !== 'string') throw new Error('No chain ID in the reply');
  return { chainId: BigInt(body.result), latencyMs: Date.now() - started };
}

/**
 * Throw unless `url` answers with `expectedChainId`. A Sepolia URL saved as the mainnet
 * RPC (or the reverse) would otherwise produce confusing failures at send time.
 */
export async function assertRpcChain(url: string, expectedChainId: bigint): Promise<RpcProbe> {
  let probe: RpcProbe;
  try {
    probe = await probeRpc(url);
  } catch {
    throw new Error('That RPC endpoint did not answer. Check the URL and your connection.');
  }
  if (probe.chainId !== expectedChainId) {
    throw new Error(
      `That RPC serves chain ${probe.chainId}, but this network needs chain ${expectedChainId}.`,
    );
  }
  return probe;
}
