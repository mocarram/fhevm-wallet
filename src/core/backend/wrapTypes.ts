/**
 * What the UI needs from the chain for wrapping and unwrapping (ERC-20 ⇄ ERC-7984
 * wrapper tokens). Part of `Backend`, kept in its own file so the wrap feature stays
 * in its own modules: `realWrap.ts` implements it for the networks, `mockWrap.ts` for
 * FHEW_BACKEND=mock.
 */

import type { NetworkName } from '../network/NetworkConfig.js';
import type { DecryptSession } from '../fhe/DecryptSession.js';
import type { SendHooks } from '../token/TokenService.js';
import type { TxOutcome, WrapperInfo, WrapState } from '../token/wrapper.js';
import type { UnlockedSigner } from './types.js';

export type { TxOutcome, WrapperInfo, WrapState } from '../token/wrapper.js';

/** One transaction of a wrap, in the order they are sent. */
export type WrapStep = 'reset' | 'approve' | 'wrap';

/** Progress of a multi-transaction wrap (all hooks are best-effort). */
export interface WrapHooks extends SendHooks {
  /** A step's transaction confirmed. */
  onStepConfirmed?: (step: WrapStep, txHash: string) => void;
  /** A step is about to be signed. */
  onStep?: (step: WrapStep) => void;
}

/** Outcome of a confirmed wrap. */
export interface WrapResult {
  /** The `wrap` transaction. */
  txHash: string;
  blockNumber: number;
  approveTxHash?: string;
  resetTxHash?: string;
  /**
   * Did the re-decrypted confidential balance go up by exactly the wrapped amount?
   * `unknown` when it could not be decrypted (before or after).
   */
  balanceCheck: 'moved' | 'unchanged' | 'changed' | 'unknown';
  balanceBefore?: bigint;
  balanceAfter?: bigint;
}

/**
 * A checked wrap: the approval (when needed) is simulated; the wrap itself is simulated
 * now when no approval is needed, else right after the approval confirms (it cannot be
 * simulated before: `transferFrom` would fail).
 */
export interface PreparedWrap {
  steps: WrapStep[];
  /** Total fee: simulated steps exactly, the rest estimated (`feeEstimated`). */
  feeWei: bigint;
  /** True when part of `feeWei` is an estimate (steps after an approval). */
  feeEstimated: boolean;
  ethBalanceWei: bigint;
  /** ERC-20 balance and allowance when prepared. */
  state: WrapState;
  /**
   * Send every step in order, waiting for each confirmation. Errors after a broadcast keep
   * that transaction's hash. If the approval confirmed but the wrap cannot be sent, the
   * error is WRAP_APPROVED_ONLY (no hash: wrapping again only sends the wrap).
   */
  send: (hooks?: WrapHooks) => Promise<WrapResult>;
}

/** Outcome of a confirmed unwrap request. */
export interface UnwrapRequestResult {
  txHash: string;
  blockNumber: number;
  /** From the receipt's `UnwrapRequested` event; null if it was not found there. */
  requestId: string | null;
}

/** A checked unwrap request (step 1). */
export interface PreparedUnwrap {
  feeWei: bigint;
  /** Estimated fee of step 2 (finalize), which is simulated once decryptable. */
  finalizeFeeWei: bigint;
  ethBalanceWei: bigint;
  /** Decrypted confidential balance the amount was checked against. */
  balance: bigint;
  /** `onSigned` fires before the broadcast: save the pending unwrap there. */
  send: (hooks?: SendHooks) => Promise<UnwrapRequestResult>;
}

/** A checked finalize (step 2) with the publicly decrypted amount. */
export interface PreparedFinalize {
  feeWei: bigint;
  ethBalanceWei: bigint;
  /** Confidential base units the request actually burnt (public now). */
  value: bigint;
  /** Underlying base units that arrive (`value × rate`). */
  receive: bigint;
  send: (hooks?: SendHooks) => Promise<{ txHash: string; blockNumber: number }>;
}

/** The wrap/unwrap part of the Backend. */
export interface WrapBackend {
  /**
   * The wrapper interface of a token, or null when it is no wrapper. Throws
   * `WalletTxError` when the network fails (never "not a wrapper" for an RPC error).
   */
  wrapperInfo(tokenAddress: string, network: NetworkName): Promise<WrapperInfo | null>;

  /** ERC-20 balance, allowance for the wrapper and supply room of `owner`. */
  wrapState(info: WrapperInfo, owner: string, network: NetworkName): Promise<WrapState>;

  /**
   * Check and price a wrap of `pull` underlying units (a multiple of the rate, from
   * `planWrap`). Nothing is signed.
   */
  prepareWrap(
    signer: UnlockedSigner,
    info: WrapperInfo,
    pull: bigint,
    network: NetworkName,
    opts?: { session?: DecryptSession },
  ): Promise<PreparedWrap>;

  /**
   * Check the decrypted balance, encrypt and simulate an unwrap request of `amount`
   * confidential units. Nothing is signed.
   */
  prepareUnwrap(
    signer: UnlockedSigner,
    info: WrapperInfo,
    amount: bigint,
    network: NetworkName,
    opts?: { session?: DecryptSession },
  ): Promise<PreparedUnwrap>;

  /** Is the request still open on-chain? `unknown` when the wrapper cannot tell. */
  unwrapRequestStatus(
    info: WrapperInfo,
    requestId: string,
    network: NetworkName,
  ): Promise<'pending' | 'finalized' | 'unknown'>;

  /** What the chain says about one of this wallet's transactions. */
  txOutcome(txHash: string, network: NetworkName): Promise<TxOutcome>;

  /**
   * How many transactions of `address` are mined (its `latest` transaction count). A
   * signed transaction whose nonce is below this and that has no receipt can never be
   * mined: another transaction took its nonce.
   */
  minedNonce(address: string, network: NetworkName): Promise<number>;

  /** The request id in a mined request transaction for `receiver`, or null. */
  unwrapRequestId(
    info: WrapperInfo,
    txHash: string,
    receiver: string,
    network: NetworkName,
  ): Promise<string | null>;

  /**
   * Publicly decrypt the request's amount through the relayer (PUBLIC_DECRYPT_PENDING
   * while not possible yet) and simulate `finalizeUnwrap`. Nothing is signed. A request
   * that is already finished fails as UNWRAP_ALREADY_FINISHED.
   */
  prepareFinalizeUnwrap(
    signer: UnlockedSigner,
    info: WrapperInfo,
    requestId: string,
    network: NetworkName,
  ): Promise<PreparedFinalize>;

  /** Public ERC-20 balance of `owner`. */
  underlyingBalance(info: WrapperInfo, owner: string, network: NetworkName): Promise<bigint>;
}
