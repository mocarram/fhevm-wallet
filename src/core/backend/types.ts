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
import type { TokenCheck } from '../token/erc7984Check.js';
import type { KnownToken } from '../token/tokenLists.js';
import type { ScanOptions, ScanResult } from '../token/tokenScan.js';
import type { BalanceBatch, SendHooks, TokenInfo, TransferResult } from '../token/TokenService.js';
import type { DecryptSession } from '../fhe/DecryptSession.js';
import type { DiscloseRequestOptions } from '../token/txErrors.js';
import type { WrapBackend } from './wrapTypes.js';

export type { BalanceBatch } from '../token/TokenService.js';

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

/** A simulated, fee-checked contract call (operator change, disclosure) ready to sign. */
export interface PreparedTx {
  feeWei: bigint;
  ethBalanceWei: bigint;
  /** Same rules as `PreparedSend.send`: after the broadcast every error keeps its hash. */
  send: (hooks?: SendHooks) => Promise<{ txHash: string; blockNumber: number }>;
}

/** A transfer amount to decrypt: its handle and the token contract that holds it. */
export interface AmountRequest {
  token: string;
  handle: string;
}

/**
 * Where a transfer amount is in the disclosure flow:
 * - private: only the parties can decrypt it
 * - requested: made publicly decryptable on-chain (step 1 done), not published yet
 * - disclosed: published on-chain with its KMS proof (this wallet did it)
 */
export type DiscloseStage = 'private' | 'requested' | 'disclosed';

/** A prepared step 2 of a disclosure: the publicly decrypted value and its transaction. */
export interface PreparedDisclose extends PreparedTx {
  value: bigint;
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
  /** What the sync did not cover and what to do (public RPC window, request budget). */
  notice?: string;
  /** False when the sync stopped before the head (request budget): sync again. */
  complete?: boolean;
}

/** Everything the UI needs from chain and relayer (wrap/unwrap: wrapTypes.ts). */
export interface Backend extends WrapBackend {
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
   * A user-decrypt session for `signer` on `network`: signs once (EIP-712) for every
   * tracked token and is reused until the token set changes or it expires. Memory only;
   * the caller clears it when the wallet locks.
   */
  newDecryptSession(signer: UnlockedSigner, network: NetworkName): DecryptSession;

  /**
   * Decrypt the session wallet's balances of `tokens` with as few signatures and relayer
   * requests as possible. Unchanged handles come from the local cache unless
   * `forceRefresh`. Per-token failures are in `errors`; this only throws on bugs.
   */
  decryptBalances(
    session: DecryptSession,
    tokens: string[],
    opts?: { forceRefresh?: boolean },
  ): Promise<BalanceBatch>;

  /**
   * Decrypt transfer amounts with the session. Result by lowercase handle: the value,
   * or null when this wallet is not allowed to decrypt it (shown as "encrypted").
   * Handles missing from the result failed for another reason and may be retried.
   * `contracts` is the full tracked token list, so the session's signature is reused.
   */
  decryptAmounts(
    session: DecryptSession,
    requests: AmountRequest[],
    contracts: string[],
  ): Promise<Record<string, bigint | null>>;

  /**
   * Encrypt the amount, check chain, balance and gas, and simulate the transfer. Nothing is
   * signed. Throws `WalletTxError` with a plain-English title, cause and hint. With a
   * session, the balance checks before and after reuse its signature.
   */
  prepareTransfer(
    signer: UnlockedSigner,
    tokenAddress: string,
    to: string,
    amount: bigint,
    network: NetworkName,
    opts?: { session?: DecryptSession },
  ): Promise<PreparedSend>;

  /** Which of `spenders` are operators for `holder` on a token right now (by lowercase address). */
  operatorStatus(
    tokenAddress: string,
    holder: string,
    spenders: string[],
    network: NetworkName,
  ): Promise<Record<string, boolean>>;

  /** Simulate `setOperator(operator, until)` (0 revokes) and price it. Nothing is signed. */
  prepareSetOperator(
    signer: UnlockedSigner,
    tokenAddress: string,
    operator: string,
    untilUnixSeconds: number,
    network: NetworkName,
  ): Promise<PreparedTx>;

  /** Where an amount handle is in the disclosure flow. */
  discloseStage(tokenAddress: string, handle: string, network: NetworkName): Promise<DiscloseStage>;

  /**
   * Step 1: simulate `requestDiscloseEncryptedAmount(handle)`. Nothing is signed. Refuses
   * the current balance handle (`DISCLOSE_IS_BALANCE`) and, unless `opts.vouched`, any
   * handle that is no transfer amount of this wallet in local history
   * (`DISCLOSE_UNKNOWN_HANDLE`): the holder can still use its earlier balance handles.
   */
  prepareDiscloseRequest(
    signer: UnlockedSigner,
    tokenAddress: string,
    handle: string,
    network: NetworkName,
    opts?: DiscloseRequestOptions,
  ): Promise<PreparedTx>;

  /**
   * Step 2: publicly decrypt the handle through the relayer (throws
   * `PUBLIC_DECRYPT_PENDING` while that is not possible yet), then simulate
   * `discloseEncryptedAmount(handle, value, proof)`. Nothing is signed.
   */
  prepareDisclose(
    signer: UnlockedSigner,
    tokenAddress: string,
    handle: string,
    network: NetworkName,
  ): Promise<PreparedDisclose>;

  /** The ConfidentialTransfer amount handle in a transaction from or to `wallet`, if any. */
  findTransferHandle(
    txHash: string,
    wallet: string,
    tokens: string[],
    network: NetworkName,
  ): Promise<AmountRequest | null>;

  /** Pull new transfers for `address` into the local transaction store. */
  syncHistory(
    address: string,
    network: NetworkName,
    tokens: TokenEntry[],
  ): Promise<HistorySyncResult>;

  /** Ask the configured RPC endpoint which chain it serves and how fast it answers. */
  checkRpc(network: NetworkName): Promise<RpcCheck>;

  /**
   * Curated tokens for `network`: the shipped list plus the user's configured list
   * (refreshed when stale or when `refresh`). `listError` says why a refresh failed.
   */
  knownTokens(
    network: NetworkName,
    opts?: { refresh?: boolean },
  ): Promise<{ tokens: KnownToken[]; listError?: string }>;

  /**
   * Scan ConfidentialTransfer logs sent to `address` for token contracts (tokenScan.ts).
   * Never throws for a failed chunk: the result carries the error and what was found.
   */
  scanReceivedTokens(
    address: string,
    network: NetworkName,
    opts: Omit<ScanOptions, 'toBlock'>,
  ): Promise<ScanResult>;

  /** First block a scan with no saved progress starts from on `network`. */
  scanStartBlock(network: NetworkName): number;

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
