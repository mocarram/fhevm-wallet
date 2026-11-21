/**
 * Backend for the real networks: a thin adapter over the existing core modules
 * (TokenService, ProviderFactory, rpcSettings, historySync). It adds no behaviour of its
 * own, so the safety rules documented in AGENTS.md (sign locally first, SENT_UNCONFIRMED
 * after broadcast, balance checks) keep applying unchanged.
 */

import type { NetworkName } from '../network/NetworkConfig.js';
import { NETWORK_CONFIGS, getRpcUrls } from '../network/NetworkConfig.js';
import {
  describeProbeFailure,
  getProvider,
  probeRpc,
  RPC_PROBE_TIMEOUT_MS,
  RpcNoRealAnswerError,
} from '../network/ProviderFactory.js';
import { MainnetConfig, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
import { maskUrl } from '../../utils/redact.js';
import { setCustomRpc } from '../network/rpcSettings.js';
import { checkFheReadiness } from '../fhe/FheService.js';
import {
  getDecryptedBalance,
  getTokenInfo,
  getTxExplorerUrl,
  prepareConfidentialTransfer,
} from '../token/TokenService.js';
import { syncTransactions } from '../token/historySync.js';
import { checkErc7984, type TokenCheck } from '../token/erc7984Check.js';
import { translateTxError } from '../token/txErrors.js';
import { knownTokens } from '../token/tokenLists.js';
import {
  scanIncoming,
  SCAN_START_BLOCK,
  type ScanOptions,
  type ScanResult,
} from '../token/tokenScan.js';
import { loadConfig } from '../../storage/ConfigStore.js';
import type { TokenEntry } from '../token/TokenRegistry.js';
import type {
  Backend,
  HistorySyncResult,
  PreparedSend,
  RelayerCheck,
  RpcCheck,
  RpcEndpointCheck,
  UnlockedSigner,
} from './types.js';

/** How long the relayer has to answer the doctor's reachability probe. */
const RELAYER_PROBE_TIMEOUT_MS = 8_000;

/** Delegates every call to the production code paths. */
export class RealBackend implements Backend {
  readonly kind = 'real' as const;

  readinessProblem(network: NetworkName): string | null {
    return checkFheReadiness(network);
  }

  async getEthBalance(address: string, network: NetworkName): Promise<bigint> {
    return getProvider(network).getBalance(address);
  }

  getTokenInfo(tokenAddress: string, network: NetworkName) {
    return getTokenInfo(tokenAddress, network);
  }

  async checkToken(tokenAddress: string, network: NetworkName): Promise<TokenCheck> {
    const provider = getProvider(network);
    try {
      return await checkErc7984((to, data) => provider.call({ to, data }), tokenAddress);
    } catch (err) {
      throw translateTxError(err, { action: 'token check' });
    }
  }

  decryptBalance(
    tokenAddress: string,
    signer: UnlockedSigner,
    network: NetworkName,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<bigint> {
    return getDecryptedBalance(tokenAddress, signer, network, opts);
  }

  async prepareTransfer(
    signer: UnlockedSigner,
    tokenAddress: string,
    to: string,
    amount: bigint,
    network: NetworkName,
  ): Promise<PreparedSend> {
    const prepared = await prepareConfidentialTransfer(signer, tokenAddress, to, amount, network);
    return {
      feeWei: prepared.feeWei,
      ethBalanceWei: prepared.ethBalanceWei,
      tokenBalance: prepared.tokenBalance,
      send: async (hooks) => {
        const r = await prepared.send(hooks);
        return {
          txHash: r.txHash,
          blockNumber: r.receipt.blockNumber,
          balanceCheck: r.balanceCheck,
          balanceAfter: r.balanceAfter,
        };
      },
    };
  }

  async syncHistory(
    address: string,
    network: NetworkName,
    tokens: TokenEntry[],
  ): Promise<HistorySyncResult> {
    // Etherscan is much faster when a key is set; otherwise scan RPC logs.
    const method = process.env.ETHERSCAN_API_KEY ? 'etherscan' : 'rpc';
    const newCount = await syncTransactions(address, network, tokens, method);
    return { newCount, method };
  }

  async checkRpc(network: NetworkName): Promise<RpcCheck> {
    const url = getRpcUrls(network)[0];
    const probe = await probeRpc(url);
    return { ...probe, url, chainMatches: probe.chainId === NETWORK_CONFIGS[network].chainId };
  }

  knownTokens(network: NetworkName, opts: { refresh?: boolean } = {}) {
    return knownTokens(network, { url: loadConfig().tokenListUrl, refresh: opts.refresh });
  }

  async scanReceivedTokens(
    address: string,
    network: NetworkName,
    opts: Omit<ScanOptions, 'toBlock'>,
  ): Promise<ScanResult> {
    const provider = getProvider(network);
    const result = await scanIncoming(provider, address, opts);
    if (result.error) result.error = translateTxError(result.error, { action: 'token scan' });
    return result;
  }

  scanStartBlock(network: NetworkName): number {
    return SCAN_START_BLOCK[network];
  }

  async checkRpcEndpoints(network: NetworkName): Promise<RpcEndpointCheck[]> {
    const expected = NETWORK_CONFIGS[network].chainId;
    return Promise.all(
      getRpcUrls(network).map(async (url): Promise<RpcEndpointCheck> => {
        try {
          const p = await probeRpc(url, RPC_PROBE_TIMEOUT_MS, { withBlockNumber: true });
          const chainMatches = p.chainId === expected;
          return {
            url: maskUrl(url),
            ok: chainMatches,
            chainId: p.chainId,
            chainMatches,
            latencyMs: p.latencyMs,
            blockNumber: p.blockNumber,
            error: chainMatches ? undefined : `It serves chain ${p.chainId}, not ${network}.`,
          };
        } catch (err) {
          return {
            url: maskUrl(url),
            ok: false,
            error: err instanceof RpcNoRealAnswerError ? err.message : describeProbeFailure(err),
          };
        }
      }),
    );
  }

  async checkRelayer(network: NetworkName): Promise<RelayerCheck> {
    const base = network === 'mainnet' ? MainnetConfig.relayerUrl : SepoliaConfig.relayerUrl;
    // The key-URL endpoint the SDK fetches first; any HTTP answer means it is reachable.
    const url = `${base.replace(/\/$/, '')}/v1/keyurl`;
    const started = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(RELAYER_PROBE_TIMEOUT_MS) });
      void res.body?.cancel();
      return {
        url: maskUrl(base),
        ok: res.status < 500,
        status: res.status,
        latencyMs: Date.now() - started,
        error: res.status < 500 ? undefined : `It answered with HTTP ${res.status}.`,
      };
    } catch {
      return { url: maskUrl(base), ok: false, error: 'It did not answer. Check your connection.' };
    }
  }

  setCustomRpc(network: NetworkName, url: string) {
    return setCustomRpc(network, url);
  }

  suggestedTokens(): [] {
    // No token addresses are hard-coded for the real networks: the user pastes one, and
    // the wallet reads its name and symbol from the contract.
    return [];
  }

  explorerTxUrl(txHash: string, network: NetworkName): string {
    return getTxExplorerUrl(txHash, network);
  }
}
