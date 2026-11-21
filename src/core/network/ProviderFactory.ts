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
import { maskUrlsInText, redactSecrets } from '../../utils/redact.js';
import { abortableGetUrl } from './abortableGetUrl.js';
import { classifyRpcLimit, httpStatusOf, type RpcLimitKind } from './rpcLimits.js';

/** Per-request timeout for JSON-RPC calls. ethers' default is 5 minutes, which freezes the UI. */
export const RPC_TIMEOUT_MS = 20_000;

/** Timeout for a quick "which chain are you?" probe when the user sets a custom RPC. */
export const RPC_PROBE_TIMEOUT_MS = 8_000;

// Every FetchRequest ethers makes, including ones it builds itself, uses the abortable
// transport, so no code path falls back to the one that leaves sockets open.
FetchRequest.registerGetUrl(abortableGetUrl);

/** Most requests in one JSON-RPC batch (nodies' public limit). */
export const RPC_BATCH_MAX = 10;

/** Attempts on HTTP 429 (rate limited) before a request fails. */
export const RPC_THROTTLE_ATTEMPTS = 3;

/** Build a fetch request with our timeout applied. */
function rpcRequest(url: string, timeoutMs = RPC_TIMEOUT_MS): FetchRequest {
  const req = new FetchRequest(url);
  req.timeout = timeoutMs;
  // ethers' own Node transport leaves the socket open after a timeout (see the module).
  req.getUrlFunc = abortableGetUrl;
  // On HTTP 429 ethers retries up to 12 times with exponential back-off, which keeps a
  // rate-limited command frozen until the timeout. Retry a few times, then say so.
  req.setThrottleParams({ maxAttempts: RPC_THROTTLE_ATTEMPTS });
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
 * Endpoints that refused a request with HTTP 4xx (other than 408/429), for the rest of
 * the process. Keyed by URL so a provider rebuilt after a settings change still skips
 * them. drpc, for one, answers every Sepolia call on its free plan with HTTP 400.
 */
const refusedUrls = new Map<string, unknown>();

/** Forget remembered refusals (tests, or after the user changes RPC settings). */
export function resetRefusedEndpoints(): void {
  refusedUrls.clear();
}

/** True for an HTTP refusal that will not change by asking again soon. */
function isLastingRefusal(err: unknown): boolean {
  const s = httpStatusOf(err);
  return s !== null && s >= 400 && s < 500 && s !== 408 && s !== 429;
}

/**
 * How useful a failure is to report when every endpoint failed: a JSON-RPC answer that
 * says what to change beats a timeout, which beats "this public endpoint refuses
 * everyone on its free plan". Ties keep the first (the preferred endpoint's) error.
 */
const LIMIT_RANK: Record<RpcLimitKind, number> = { range: 6, rate: 5, pruned: 4, restricted: 3 };
function failureRank(err: unknown): number {
  if (httpStatusOf(err) === 429) return 5;
  if (isLastingRefusal(err)) return 1;
  return 2; // timeout, connection refused, HTTP 5xx, wrong chain
}

/** The first JSON-RPC error in a reply that means "ask another endpoint". */
function limitIn(results: JsonRpcResult[]): RpcLimitKind | null {
  for (const r of results as Array<JsonRpcResult | { error?: unknown }>) {
    if ('error' in r && r.error) {
      const kind = classifyRpcLimit(r.error);
      if (kind) return kind;
    }
  }
  return null;
}

/**
 * A JSON-RPC provider that tries the next URL when one does not answer, and checks each
 * URL's chain ID before its first real request.
 *
 * Fail-over covers transport failures (timeout, connection refused, HTTP 4xx/5xx) and,
 * for read-only calls, JSON-RPC replies that only say "not here": rate limits, plan
 * restrictions, pruned history and block-range caps (`classifyRpcLimit`). Any other
 * JSON-RPC error (a revert, say) is a real answer and comes back unchanged. When every
 * endpoint fails, the most useful failure is reported (see `failureRank`): a fallback
 * that refuses free-plan traffic must not hide the preferred endpoint's real answer.
 *
 * `eth_sendRawTransaction` is never retried on another node: if the first attempt timed
 * out the transaction may already be in a mempool, and the caller reports it as "sent,
 * not confirmed" with its hash instead.
 *
 * The endpoint that answered stays in use, except when the earlier ones only refused the
 * request's block range or age (a 50-block cap, pruned history): the next request starts
 * at the preferred endpoint again, so one old or wide query does not move all traffic to
 * a capped fallback. One that refused with HTTP 4xx is skipped for the rest of the
 * process (`refusedUrls`) unless every endpoint did.
 *
 * The chain check is per URL. A verified URL is not asked again. A URL that answered with
 * the wrong chain is skipped from then on (the next fallback gets its turn). A transport
 * error during the check is not remembered, so a blip does not disable an endpoint.
 */
export class FailoverJsonRpcProvider extends JsonRpcProvider {
  readonly urls: readonly string[];
  readonly #timeoutMs: number;
  readonly #expectedChainId: bigint;
  #index = 0;
  readonly #verified = new Set<number>();
  readonly #wrongChain = new Map<number, WrongChainError>();

  constructor(urls: string[], network: Network, timeoutMs = RPC_TIMEOUT_MS) {
    if (urls.length === 0) throw new Error('At least one RPC URL is required');
    // nodies (a default Sepolia endpoint) refuses JSON-RPC batches of more than 10
    // requests ("Batch too large: maximum allowed is 10"); ethers batches up to 100.
    super(rpcRequest(urls[0], timeoutMs), network, {
      staticNetwork: network,
      batchMaxCount: RPC_BATCH_MAX,
    });
    this.urls = urls;
    this.#timeoutMs = timeoutMs;
    this.#expectedChainId = network.chainId;
    this.#index = this.#usable(0);
  }

  /** The endpoint currently in use. */
  get currentUrl(): string {
    return this.urls[this.#index];
  }

  /** The chain this provider is for. */
  get expectedChainId(): bigint {
    return this.#expectedChainId;
  }

  override _getConnection(): FetchRequest {
    return rpcRequest(this.currentUrl, this.#timeoutMs);
  }

  /** `from`, or the next URL after it that has not refused us; `from` if all have. */
  #usable(from: number): number {
    for (let i = 0; i < this.urls.length; i++) {
      const j = (from + i) % this.urls.length;
      if (!refusedUrls.has(this.urls[j])) return j;
    }
    return from;
  }

  /** POST `payload` to one specific URL (ethers' own _send, without the shared index). */
  async #post(index: number, payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const req = rpcRequest(this.urls[index], this.#timeoutMs);
    req.body = JSON.stringify(payload);
    req.setHeader('content-type', 'application/json');
    const res = await req.send();
    res.assertOk();
    const body = res.bodyJson as JsonRpcResult | JsonRpcResult[];
    return Array.isArray(body) ? body : [body];
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const methods = (Array.isArray(payload) ? payload : [payload]).map((p) => p.method);
    const canFailOver = this.urls.length > 1 && !methods.includes('eth_sendRawTransaction');
    // The best outcome so far when every endpoint fails: a reply to hand back, or an error.
    let best: { rank: number; results?: JsonRpcResult[]; error?: unknown } | null = null;
    const tried = new Set<number>();
    let sticky = true;
    let next = this.#index;
    for (let attempt = 0; attempt < (canFailOver ? this.urls.length : 1); attempt++) {
      const index = canFailOver ? this.#usable(attempt === 0 ? this.#index : next) : this.#index;
      // Every usable URL was tried: the rest refused before, so do not ask them again.
      if (tried.has(index)) break;
      tried.add(index);
      let rank: number;
      let outcome: { results?: JsonRpcResult[]; error?: unknown };
      try {
        // Verify the chain on first use of every URL (in every process), so a wrong URL
        // in .env is caught before any balance read or send.
        await this.#ensureChain(index);
        const results = await this.#post(index, payload);
        const limit = canFailOver ? limitIn(results) : null;
        if (!limit) {
          // Stay with the endpoint that answered, unless this request only went elsewhere
          // because of its own size or age (see `sticky`).
          if (canFailOver && sticky) this.#index = index;
          return results;
        }
        rank = LIMIT_RANK[limit];
        outcome = { results };
        // A block-range cap or pruned history is about this request: the next, smaller
        // or newer one may be fine where it is. Rate limits and restrictions are not.
        if (limit === 'range' || limit === 'pruned') sticky = false;
      } catch (err) {
        if (isLastingRefusal(err)) refusedUrls.set(this.urls[index], err);
        rank = failureRank(err);
        outcome = { error: err };
      }
      if (!best || rank > best.rank) best = { rank, ...outcome };
      next = this.#usable((index + 1) % this.urls.length);
      // Move on only if nobody else moved the index meanwhile (parallel requests).
      if (canFailOver && sticky && this.#index === index) this.#index = next;
    }
    if (best?.results) return best.results;
    throw best?.error;
  }

  async #ensureChain(index: number): Promise<void> {
    if (this.#verified.has(index)) return;
    const known = this.#wrongChain.get(index);
    if (known) throw known;
    const [reply] = await this.#post(index, {
      id: 0,
      jsonrpc: '2.0',
      method: 'eth_chainId',
      params: [],
    });
    const result = reply && 'result' in reply ? reply.result : undefined;
    // A non-hex answer would make BigInt throw a SyntaxError nobody can act on.
    if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) {
      throw new Error('The RPC endpoint did not report its chain ID');
    }
    const served = BigInt(result);
    if (served !== this.#expectedChainId) {
      const wrong = new WrongChainError(served, this.#expectedChainId);
      this.#wrongChain.set(index, wrong);
      throw wrong;
    }
    this.#verified.add(index);
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

/** JSON-RPC "internal error", for failures that carry no JSON-RPC code of their own. */
const RPC_INTERNAL_ERROR = -32603;

/**
 * Wrap a provider as an EIP-1193 object.
 *
 * - `eth_chainId` is answered locally with the configured chain: the wrapped provider has
 *   already verified it, and answering locally stops a consumer's own network detection
 *   (ethers' BrowserProvider asks on start-up) from costing a round trip or, with a dead
 *   RPC, retrying and logging "failed to detect network" forever.
 * - Errors are rethrown EIP-1193-shaped (`{ code: number, message, data }`), keeping the
 *   JSON-RPC `data` so the consumer can still decode reverts. The message is redacted:
 *   ethers' text includes the request URL.
 */
export function toEip1193(getTarget: () => FailoverJsonRpcProvider): Eip1193Provider {
  return {
    request: async ({ method, params }) => {
      const target = getTarget();
      if (method === 'eth_chainId') return '0x' + target.expectedChainId.toString(16);
      try {
        return await target.send(method, (params as unknown[] | Record<string, unknown>) ?? []);
      } catch (err) {
        throw toEip1193Error(err);
      }
    },
  };
}

/** Error shape an EIP-1193 consumer expects. */
export interface Eip1193Error extends Error {
  code: number;
  data?: unknown;
}

/** Convert an ethers error into an EIP-1193 error, keeping the JSON-RPC code and data. */
export function toEip1193Error(err: unknown): Eip1193Error {
  const e = (err ?? {}) as {
    code?: unknown;
    data?: unknown;
    shortMessage?: unknown;
    message?: unknown;
    error?: { code?: unknown; message?: unknown; data?: unknown };
    info?: { error?: { code?: unknown; message?: unknown; data?: unknown } };
  };
  // ethers keeps the node's JSON-RPC error under `error` or `info.error`.
  const rpc = e.error ?? e.info?.error;
  const code = typeof rpc?.code === 'number' ? rpc.code : RPC_INTERNAL_ERROR;
  const message =
    (typeof rpc?.message === 'string' && rpc.message) ||
    (typeof e.shortMessage === 'string' && e.shortMessage) ||
    (typeof e.message === 'string' && e.message.split('\n')[0]) ||
    'RPC request failed';
  const out = new Error(maskUrlsInText(redactSecrets(message))) as Eip1193Error;
  out.code = code;
  const data = rpc?.data ?? e.data;
  if (data !== undefined && data !== null) out.data = data;
  return out;
}

/**
 * An EIP-1193 view of our provider for the relayer SDK, so its RPC reads get the same
 * timeouts, fallback endpoints and chain check as everything else. Looks the provider up
 * on every request so a changed RPC setting takes effect immediately.
 */
export function getEip1193Provider(network: NetworkName): Eip1193Provider {
  return toEip1193(() => getProvider(network));
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
  /** Latest block, when the probe asked for it (`withBlockNumber`). */
  blockNumber?: number;
}

/** Thrown when an endpoint reports its chain but will not answer a real request. */
export class RpcNoRealAnswerError extends Error {
  readonly code = 'RPC_NO_REAL_ANSWER';
}

/**
 * One raw JSON-RPC call with a short timeout and no retries. A single request rather than
 * a throwaway provider: a provider without a static network would keep retrying network
 * detection (and logging) when the URL is wrong.
 */
async function rawRpcCall(url: string, method: string, timeoutMs: number): Promise<unknown> {
  const req = rpcRequest(url, timeoutMs);
  req.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] });
  req.setHeader('content-type', 'application/json');
  req.retryFunc = async () => false; // a probe should answer once, quickly
  const res = await req.send();
  res.assertOk();
  return (res.bodyJson as { result?: unknown })?.result;
}

/**
 * Ask an RPC endpoint which chain it serves, with a short timeout. With
 * `withBlockNumber`, also make one real call (eth_blockNumber): some gateways answer
 * eth_chainId from a static config without a node behind them, and would only fail
 * later, at send time.
 */
export async function probeRpc(
  url: string,
  timeoutMs = RPC_PROBE_TIMEOUT_MS,
  opts: { withBlockNumber?: boolean } = {},
): Promise<RpcProbe> {
  const started = Date.now();
  const result = await rawRpcCall(url, 'eth_chainId', timeoutMs);
  if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) {
    throw new Error('No chain ID in the reply');
  }
  const probe: RpcProbe = { chainId: BigInt(result), latencyMs: Date.now() - started };
  if (opts.withBlockNumber) {
    let block: unknown;
    try {
      block = await rawRpcCall(url, 'eth_blockNumber', timeoutMs);
    } catch {
      block = undefined;
    }
    if (typeof block !== 'string' || !/^0x[0-9a-f]+$/i.test(block)) {
      throw new RpcNoRealAnswerError(
        'That RPC endpoint reported its chain but did not answer a basic request (eth_blockNumber). It may be restricted or not backed by a node. Use another URL.',
      );
    }
    probe.blockNumber = Number(BigInt(block));
  }
  return probe;
}

/**
 * One sentence on why a probe failed: no answer at all, an HTTP error, or an answer that
 * is not a JSON-RPC chain ID. Users fix these differently (connection vs URL vs provider).
 */
export function describeProbeFailure(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; response?: { statusCode?: unknown } };
  const status = typeof e.response?.statusCode === 'number' ? e.response.statusCode : null;
  if (e.code === 'SERVER_ERROR' || status !== null) {
    return `That RPC endpoint returned an error${status !== null ? ` (HTTP ${status})` : ''}. Check the URL, including any API key in it.`;
  }
  if (e.code === 'TIMEOUT' || e.code === 'NETWORK_ERROR' || e.code === 'CANCELLED') {
    return 'That RPC endpoint did not answer. Check the URL and your connection.';
  }
  return 'That RPC endpoint answered, but not like an Ethereum JSON-RPC node. Check the URL.';
}

/**
 * Throw unless `url` answers with `expectedChainId` and answers one real request
 * (eth_blockNumber). A Sepolia URL saved as the mainnet
 * RPC (or the reverse) would otherwise produce confusing failures at send time.
 */
export async function assertRpcChain(url: string, expectedChainId: bigint): Promise<RpcProbe> {
  let probe: RpcProbe;
  try {
    probe = await probeRpc(url, RPC_PROBE_TIMEOUT_MS, { withBlockNumber: true });
  } catch (err) {
    if (err instanceof RpcNoRealAnswerError) throw new Error(err.message);
    throw new Error(describeProbeFailure(err));
  }
  if (probe.chainId !== expectedChainId) {
    throw new Error(
      `That RPC serves chain ${probe.chainId}, but this network needs chain ${expectedChainId}.`,
    );
  }
  return probe;
}
