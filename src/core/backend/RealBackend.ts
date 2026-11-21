/**
 * Backend for the real networks: a thin adapter over the existing core modules
 * (TokenService, ProviderFactory, rpcSettings, historySync). It adds no behaviour of its
 * own, so the safety rules documented in AGENTS.md (sign locally first, SENT_UNCONFIRMED
 * after broadcast, balance checks) keep applying unchanged.
 */

import type { NetworkName } from '../network/NetworkConfig.js';
import { NETWORK_CONFIGS, getRpcUrls } from '../network/NetworkConfig.js';
import { getProvider, probeRpc } from '../network/ProviderFactory.js';
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
import type { TokenEntry } from '../token/TokenRegistry.js';
import type {
  Backend,
  HistorySyncResult,
  PreparedSend,
  RpcCheck,
  UnlockedSigner,
} from './types.js';

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
