/**
 * The seam between the user interface and the chain + Zama relayer.
 *
 * Everything the TUI (and `fhew send`) needs from the network goes through `Backend`, so
 * the same screens run against Sepolia/Mainnet (`RealBackend`) or a deterministic offline
 * simulation (`MockBackend`, selected with `FHEW_BACKEND=mock`) for e2e tests and demos.
 *
 * Local data (keystores, contacts, tracked tokens, settings) is *not* behind this
 * interface: it always uses the real encrypted storage under the data directory.
 */

import type { HDNodeWallet, Wallet } from 'ethers';
import type { NetworkName } from '../network/NetworkConfig.js';
import type { RpcProbe } from '../network/ProviderFactory.js';
import type { TokenEntry } from '../token/TokenRegistry.js';
import type { SendHooks, TokenInfo, TransferResult } from '../token/TokenService.js';
import type { TokenCheck } from '../token/erc7984Check.js';

/** Which implementation is running. The UI shows a MOCK badge for 'mock'. */
export type BackendKind = 'real' | 'mock';

/** A decrypted wallet held in memory while unlocked. */
export type UnlockedSigner = Wallet | HDNodeWallet;

/** Outcome of a confirmed send, independent of ethers receipt objects. */
export interface SendResult {
  txHash: string;
  blockNumber: number;
  /** See `TransferResult.balanceCheck`: did the re-decrypted balance drop by the amount? */
  balanceCheck?: TransferResult['balanceCheck'];
  balanceAfter?: bigint;
}

/** A simulated, gas-checked transfer that is ready to sign and broadcast. */
export interface PreparedSend {
  /** Estimated worst-case network fee in wei. */
  feeWei: bigint;
  /** ETH balance in wei when the send was prepared. */
  ethBalanceWei: bigint;
  /** Decrypted token balance (base units) when the send was prepared. */
  tokenBalance: bigint;
  /**
   * Sign, broadcast and wait for one confirmation. Throws `WalletTxError`; after the
   * broadcast every error carries the hash (SENT_UNCONFIRMED, TX_REVERTED, TX_REPLACED).
   */
  send: (hooks?: SendHooks) => Promise<SendResult>;
}

/** Result of checking the configured RPC endpoint. */
export interface RpcCheck extends RpcProbe {
  url: string;
  /** True when the chain ID matches the selected network. */
  chainMatches: boolean;
}

/** One configured RPC endpoint, as `fhew doctor` reports it. */
export interface RpcEndpointCheck {
  /** Masked for display (`https://host/…`): the path may hold a provider key. */
  url: string;
  ok: boolean;
  chainId?: bigint;
  chainMatches?: boolean;
  latencyMs?: number;
  blockNumber?: number;
  /** Plain-English reason when it did not answer properly. */
  error?: string;
}

/** Whether the Zama relayer for a network answers. */
export interface RelayerCheck {
  url: string;
  ok: boolean;
  latencyMs?: number;
  /** HTTP status of the answer, when there was one. */
  status?: number;
  error?: string;
}

/** Result of refreshing the transaction history. */
export interface HistorySyncResult {
  newCount: number;
  method: 'etherscan' | 'rpc' | 'mock';
}

/** Everything the UI needs from chain and relayer. */
export interface Backend {
  readonly kind: BackendKind;

  /** A reason FHE operations cannot run on `network` (e.g. no Zama mainnet key), or null. */
  readinessProblem(network: NetworkName): string | null;

  /** Native ETH balance in wei. */
  getEthBalance(address: string, network: NetworkName): Promise<bigint>;

  /** Name, symbol (sanitised) and decimals of an ERC-7984 contract. */
  getTokenInfo(tokenAddress: string, network: NetworkName): Promise<TokenInfo>;

  /**
   * Check that a contract is an ERC-7984 token (ERC-165 id plus a behavioural probe, see
   * erc7984Check.ts). Throws `WalletTxError` only when the network fails; a contract that
   * is not a token comes back with `compliant: false` and the reasons.
   */
  checkToken(tokenAddress: string, network: NetworkName): Promise<TokenCheck>;

  /**
   * Decrypt `signer`'s balance of a token, in base units. Uses (and refreshes) the local
   * cache while the on-chain handle is unchanged, unless `forceRefresh`.
   */
  decryptBalance(
    tokenAddress: string,
    signer: UnlockedSigner,
    network: NetworkName,
    opts?: { forceRefresh?: boolean },
  ): Promise<bigint>;

  /**
   * Encrypt the amount, check chain, balance and gas, and simulate the transfer. Nothing is
   * signed. Throws `WalletTxError` with a plain-English title, cause and hint.
   */
  prepareTransfer(
    signer: UnlockedSigner,
    tokenAddress: string,
    to: string,
    amount: bigint,
    network: NetworkName,
  ): Promise<PreparedSend>;

  /** Pull new transfers for `address` into the local transaction store. */
  syncHistory(
    address: string,
    network: NetworkName,
    tokens: TokenEntry[],
  ): Promise<HistorySyncResult>;

  /** Ask the configured RPC endpoint which chain it serves and how fast it answers. */
  checkRpc(network: NetworkName): Promise<RpcCheck>;

  /** Probe every RPC URL in use for `network` (custom, or default plus fallbacks). */
  checkRpcEndpoints(network: NetworkName): Promise<RpcEndpointCheck[]>;

  /** Check that the Zama relayer for `network` answers. Never throws. */
  checkRelayer(network: NetworkName): Promise<RelayerCheck>;

  /** Verify and save a custom RPC URL (see `setCustomRpc`). */
  setCustomRpc(network: NetworkName, url: string): Promise<RpcProbe>;

  /** Tokens worth offering during first-run setup on `network` (may be empty). */
  suggestedTokens(network: NetworkName): TokenInfo[];

  /** Block explorer link for a transaction. */
  explorerTxUrl(txHash: string, network: NetworkName): string;
}
