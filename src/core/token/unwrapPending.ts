/**
 * The pending-unwrap state machine, shared by `fhew unwrap` and the TUI.
 *
 * An unwrap is a request transaction, a wait for the public decryption, then a finalize
 * transaction. Every step is recorded in the unwrap store (UnwrapStore.ts) *when it is
 * signed*, before it is broadcast. Before anything is sent again, `reconcileUnwrap`
 * asks the chain what happened to the recorded transactions:
 *
 * - The request is never sent again by a resume. A request that is not visible yet
 *   (pending, or unknown to the node) is waited for; only a mined revert ends it.
 * - The finalize is only sent when the request is still open on-chain
 *   (`unwrapRequester`, or finalize's simulation on 0.3.x wrappers) and no finalize of
 *   ours is pending. One that is mined, or a request someone else finished, is done.
 *   A finalize can never pay twice (the wrapper deletes the request), but a second one
 *   would waste gas and look like a second payment, so it is not sent while ours may
 *   still land.
 *
 * This is the lesson from disclosure, where a re-run could resend step 2: the state on
 * disk says what was sent, and the chain says what happened.
 */

import type { Backend, UnlockedSigner } from '../backend/types.js';
import type {
  PreparedFinalize,
  PreparedUnwrap,
  UnwrapRequestResult,
} from '../backend/wrapTypes.js';
import type { NetworkName } from '../network/NetworkConfig.js';
import type { SendHooks } from './TokenService.js';
import { translateTxError, WalletTxError } from './txErrors.js';
import type { WrapperInfo } from './wrapper.js';
import { recordWrapHistory } from './wrapHistory.js';
import {
  addUnwrap,
  listUnwraps,
  updateUnwrap,
  type UnwrapEntry,
} from '../../storage/UnwrapStore.js';

/**
 * A finalize signed this recently may not be visible to the RPC yet (another node took
 * it): until then a "missing" finalize is waited for, not re-sent.
 */
export const FINALIZE_GRACE_MS = 3 * 60_000;

/** What to do next with an unwrap, after checking the chain. */
export type UnwrapNext =
  /** The request is not mined yet (`missing`: the node does not know it). Never resend. */
  | { kind: 'wait-request'; missing: boolean }
  /** The request is open on-chain: decrypt and finalize. */
  | { kind: 'finalize' }
  /** Our finalize is not mined yet (`missing`: not visible yet). Not sent again. */
  | { kind: 'wait-finalize'; missing: boolean }
  /** The underlying tokens were sent. */
  | { kind: 'done' }
  /** The request reverted: nothing was burnt. */
  | { kind: 'failed'; reason: string }
  /**
   * The request was mined, but no unwrap request of this wallet was found in it. Tokens
   * may have been burnt: never say "nothing burnt"; the user checks the explorer.
   */
  | { kind: 'unclear'; reason: string };

/** Why an `unclear` entry needs a look at the explorer. */
export const UNCLEAR_REASON =
  'The request was mined, but the wallet found no unwrap request in it. Tokens may have been burnt: check the transaction on the explorer.';

/**
 * A recorded request without a nonce (from before nonces were recorded) that the network
 * does not know may be forgotten only after this long: it cannot be proven dead.
 */
export const FORGET_LEGACY_MIN_AGE_MS = 30 * 60_000;

/** The WrapperInfo an entry was made for (no network call). */
export function entryInfo(e: UnwrapEntry): WrapperInfo {
  return {
    address: e.token,
    name: e.symbol,
    symbol: e.symbol,
    decimals: e.decimals,
    rate: BigInt(e.rate),
    underlying: { ...e.underlying, name: e.underlying.symbol },
    hasRequester: e.hasRequester,
  };
}

/**
 * An earlier unwrap of the same token whose request is not confirmed yet. A new request
 * is refused until it is checked: the earlier one may still be mined.
 */
export function unconfirmedRequest(
  network: NetworkName,
  wallet: string,
  token: string,
): UnwrapEntry | null {
  return (
    listUnwraps({ network, wallet, open: true }).find(
      (e) => e.state === 'signed' && e.token.toLowerCase() === token.toLowerCase(),
    ) ?? null
  );
}

/** The refusal for a new unwrap while `e` is unconfirmed. */
export function unconfirmedRequestError(e: UnwrapEntry): WalletTxError {
  return new WalletTxError(
    'UNWRAP_UNCONFIRMED',
    `An earlier unwrap of ${e.symbol} is not confirmed yet.`,
    `Its request (${e.requestTxHash}) may still be mined. Sending another one now could unwrap twice.`,
    'Run `fhew unwrap --resume` (or Home › Finish unwrap) to check it first.',
  );
}

/**
 * Send a prepared unwrap request, recording it the moment it is signed (before the
 * broadcast) and again once mined with its request id. Errors keep the hash, as usual;
 * the entry then stays `signed` for `reconcileUnwrap` to check later. The burn also goes
 * into the local history, confirmed or unconfirmed (wrapHistory.ts).
 */
export async function sendUnwrapRequest(
  prepared: PreparedUnwrap,
  ctx: { network: NetworkName; wallet: string; info: WrapperInfo; amount: bigint },
  hooks: SendHooks = {},
): Promise<{ result: UnwrapRequestResult; entry: UnwrapEntry }> {
  let entry: UnwrapEntry | null = null;
  const { info } = ctx;
  function sendRequest(): Promise<UnwrapRequestResult> {
    return prepared.send({
      ...hooks,
      onSigned: (txHash, meta) => {
        entry = addUnwrap({
          id: txHash,
          ...(meta ? { requestNonce: meta.nonce } : {}),
          network: ctx.network,
          wallet: ctx.wallet,
          token: info.address,
          symbol: info.symbol,
          decimals: info.decimals,
          rate: info.rate.toString(),
          underlying: {
            address: info.underlying.address,
            symbol: info.underlying.symbol,
            decimals: info.underlying.decimals,
          },
          hasRequester: info.hasRequester,
          amount: ctx.amount.toString(),
          requestTxHash: txHash,
        });
        hooks.onSigned?.(txHash, meta);
      },
    });
  }
  let result: UnwrapRequestResult;
  try {
    result = await sendRequest();
  } catch (err) {
    // Not confirmed in time: History shows the burn as unconfirmed (wrapHistory.ts).
    const e = translateTxError(err);
    if (e.code === 'SENT_UNCONFIRMED' && e.txHash) recordWrapHistory('unwrap', ctx, e.txHash, 0);
    throw err;
  }
  recordWrapHistory('unwrap', ctx, result.txHash, result.blockNumber);
  if (!entry) {
    // onSigned is best-effort inside the send path; record it now if that failed.
    entry = addUnwrap({
      id: result.txHash,
      network: ctx.network,
      wallet: ctx.wallet,
      token: info.address,
      symbol: info.symbol,
      decimals: info.decimals,
      rate: info.rate.toString(),
      underlying: {
        address: info.underlying.address,
        symbol: info.underlying.symbol,
        decimals: info.underlying.decimals,
      },
      hasRequester: info.hasRequester,
      amount: ctx.amount.toString(),
      requestTxHash: result.txHash,
    });
  }
  const confirmed = result.requestId
    ? updateUnwrap((entry as UnwrapEntry).id, {
        state: 'requested',
        requestId: result.requestId,
        requestBlock: result.blockNumber,
      })
    : (entry as UnwrapEntry);
  return { result, entry: confirmed };
}

/**
 * Bring an entry up to date with the chain and say what comes next. Saves what it learnt.
 * Never sends anything. Network failures are thrown (the entry is unchanged).
 */
export async function reconcileUnwrap(
  backend: Backend,
  entry: UnwrapEntry,
  now = Date.now(),
): Promise<{ entry: UnwrapEntry; next: UnwrapNext }> {
  const info = entryInfo(entry);
  const network = entry.network;
  let e = entry;
  if (e.state === 'finished') return { entry: e, next: { kind: 'done' } };
  if (e.state === 'failed') {
    return { entry: e, next: { kind: 'failed', reason: 'The request reverted.' } };
  }
  if (e.state === 'unclear') return { entry: e, next: { kind: 'unclear', reason: UNCLEAR_REASON } };

  if (e.state === 'signed') {
    const o = await backend.txOutcome(e.requestTxHash, network);
    if (o.status === 'pending') return { entry: e, next: { kind: 'wait-request', missing: false } };
    if (o.status === 'missing') return { entry: e, next: { kind: 'wait-request', missing: true } };
    if (o.status === 'reverted') {
      e = updateUnwrap(e.id, { state: 'failed', requestBlock: o.blockNumber });
      return {
        entry: e,
        next: { kind: 'failed', reason: 'The request was mined but reverted: nothing was burnt.' },
      };
    }
    const id = await backend.unwrapRequestId(info, e.requestTxHash, e.wallet, network);
    if (!id) {
      // Not "failed": the burn may have happened (an unexpected wrapper, or a receipt
      // without its logs). Only the explorer can tell, so say that and keep it apart.
      e = updateUnwrap(e.id, { state: 'unclear', requestBlock: o.blockNumber });
      return { entry: e, next: { kind: 'unclear', reason: UNCLEAR_REASON } };
    }
    e = updateUnwrap(e.id, { state: 'requested', requestId: id, requestBlock: o.blockNumber });
    // The process that sent it may have ended before the receipt (killed, closed): put
    // the burn into local history now. Keyed by hash, so a second record only updates it
    // (and turns an "unconfirmed" one confirmed).
    recordWrapHistory(
      'unwrap',
      { network, wallet: e.wallet, info, amount: BigInt(e.amount) },
      e.requestTxHash,
      o.blockNumber,
    );
  }

  if (e.state === 'finalizing' && e.finalizeTxHash) {
    const o = await backend.txOutcome(e.finalizeTxHash, network);
    if (o.status === 'mined') {
      e = updateUnwrap(e.id, {
        state: 'finished',
        finishedBy: 'wallet',
        finalizeBlock: o.blockNumber,
      });
      return { entry: e, next: { kind: 'done' } };
    }
    if (o.status === 'pending')
      return { entry: e, next: { kind: 'wait-finalize', missing: false } };
    const signedAt = e.finalizeSignedAt ? Date.parse(e.finalizeSignedAt) : 0;
    if (o.status === 'missing' && now - signedAt < FINALIZE_GRACE_MS) {
      return { entry: e, next: { kind: 'wait-finalize', missing: true } };
    }
    // Reverted, or dropped long ago: only the request's own state decides now.
  }

  const status = await backend.unwrapRequestStatus(info, e.requestId!, network);
  if (status === 'finalized') {
    e = updateUnwrap(e.id, { state: 'finished', finishedBy: e.finishedBy ?? 'other' });
    return { entry: e, next: { kind: 'done' } };
  }
  if (e.state === 'finalizing') e = updateUnwrap(e.id, { state: 'requested' });
  return { entry: e, next: { kind: 'finalize' } };
}

/**
 * Prepare step 2 for an entry that `reconcileUnwrap` said is ready. A request the
 * wrapper reports as already finished is recorded as done and rethrown
 * (UNWRAP_ALREADY_FINISHED), so the caller shows it instead of sending.
 */
export async function prepareFinish(
  backend: Backend,
  signer: UnlockedSigner,
  entry: UnwrapEntry,
): Promise<PreparedFinalize> {
  if (entry.state !== 'requested' || !entry.requestId) {
    throw new Error('This unwrap is not waiting for step 2.');
  }
  try {
    return await backend.prepareFinalizeUnwrap(
      signer,
      entryInfo(entry),
      entry.requestId,
      entry.network,
    );
  } catch (err) {
    const e = translateTxError(err, { action: 'unwrap finish' });
    if (e.code === 'UNWRAP_ALREADY_FINISHED') {
      updateUnwrap(entry.id, { state: 'finished', finishedBy: entry.finishedBy ?? 'other' });
    }
    throw e;
  }
}

/**
 * Send a prepared step 2, recording it when signed (state `finalizing`) and when mined
 * (`finished`). After the broadcast, errors keep the hash and the entry stays
 * `finalizing`, so a resume checks that transaction before anything else.
 */
export async function sendFinish(
  prepared: PreparedFinalize,
  entry: UnwrapEntry,
  hooks: SendHooks = {},
): Promise<{ txHash: string; blockNumber: number; entry: UnwrapEntry }> {
  if (prepared.value === 0n) {
    // The request burnt nothing (the balance was short at the time): nothing to send.
    const e = updateUnwrap(entry.id, { state: 'finished', value: '0', finishedBy: 'wallet' });
    return { txHash: '', blockNumber: 0, entry: e };
  }
  const r = await prepared.send({
    ...hooks,
    onSigned: (txHash) => {
      updateUnwrap(entry.id, {
        state: 'finalizing',
        finalizeTxHash: txHash,
        finalizeSignedAt: new Date().toISOString(),
        value: prepared.value.toString(),
      });
      hooks.onSigned?.(txHash);
    },
  });
  const e = updateUnwrap(entry.id, {
    state: 'finished',
    finishedBy: 'wallet',
    finalizeTxHash: r.txHash,
    finalizeBlock: r.blockNumber,
    value: prepared.value.toString(),
  });
  return { ...r, entry: e };
}

/** One line on where an unwrap is, for lists ("waiting for decryption", …). */
export function describeUnwrapState(e: UnwrapEntry): string {
  switch (e.state) {
    case 'signed':
      return 'request sent, not confirmed yet';
    case 'requested':
      return 'step 1 done, waiting to finish';
    case 'finalizing':
      return 'finish sent, not confirmed yet';
    case 'finished':
      return e.finishedBy === 'other' ? 'finished (by another account)' : 'finished';
    case 'failed':
      return 'request reverted, nothing burnt';
    case 'unclear':
      return 'request mined, no unwrap found in it: check the explorer';
  }
}

/** Whether `fhew unwrap --forget` may remove an entry, after checking the chain. */
export type ForgetCheck =
  /** `warning`: shown before the user confirms (tokens may have been burnt). */
  | { ok: true; entry: UnwrapEntry; warning?: string }
  | { ok: false; entry: UnwrapEntry; code: 'UNWRAP_STILL_OPEN'; message: string };

/**
 * Decide whether an entry may be forgotten. Never sends anything; network failures are
 * thrown (nothing is removed then).
 *
 * A request the RPC does not know (no receipt, no transaction) is not proof that it was
 * dropped: behind a load-balanced endpoint it may sit in another node's mempool and be
 * mined later, burning the tokens with no entry left to finish the unwrap. So a `signed`
 * request is only forgettable once its nonce is provably taken: the account's mined
 * nonce is past it and our hash still has no receipt (read in that order, so a request
 * mined in between is seen). Entries from before nonces were recorded need an age
 * instead (`FORGET_LEGACY_MIN_AGE_MS`).
 */
export async function checkForget(
  backend: Backend,
  start: UnwrapEntry,
  now = Date.now(),
  depth = 0,
): Promise<ForgetCheck> {
  const open = (entry: UnwrapEntry, message: string): ForgetCheck => ({
    ok: false,
    entry,
    code: 'UNWRAP_STILL_OPEN',
    message,
  });
  const waitingForStep2 =
    'This unwrap is waiting for step 2: its tokens are burnt and the ERC-20 has not been sent yet. Finish it with `fhew unwrap --resume` instead.';
  if (start.state === 'requested' || start.state === 'finalizing')
    return open(start, waitingForStep2);
  if (start.state === 'finished' || start.state === 'failed') return { ok: true, entry: start };
  if (start.state === 'unclear') return { ok: true, entry: start, warning: UNCLEAR_REASON };

  const { entry, next } = await reconcileUnwrap(backend, start, now);
  switch (next.kind) {
    case 'done':
    case 'failed':
      return { ok: true, entry };
    case 'unclear':
      return { ok: true, entry, warning: UNCLEAR_REASON };
    case 'finalize':
    case 'wait-finalize':
      return open(entry, waitingForStep2);
    case 'wait-request':
      if (!next.missing) {
        return open(
          entry,
          'The network has this request and has not mined it yet, so it may still burn the tokens. Wait for it, then run `fhew unwrap --resume`.',
        );
      }
  }
  if (entry.requestNonce === undefined) {
    const age = now - Date.parse(entry.createdAt);
    if (age < FORGET_LEGACY_MIN_AGE_MS) {
      const mins = Math.ceil((FORGET_LEGACY_MIN_AGE_MS - age) / 60_000);
      return open(
        entry,
        `The network does not know this request, but it may still be mined (another node may have it). Try again in ${mins} minute${mins === 1 ? '' : 's'}; send any transaction from this wallet first to be sure.`,
      );
    }
    return { ok: true, entry };
  }
  const mined = await backend.minedNonce(entry.wallet, entry.network);
  if (mined <= entry.requestNonce) {
    return open(
      entry,
      `The network does not know this request, but it can still be mined: its nonce (${entry.requestNonce}) is not used yet. Wait; any later transaction from this wallet settles it, then check again.`,
    );
  }
  // The nonce is taken. Our hash may be what took it (mined since the first look).
  const o = await backend.txOutcome(entry.requestTxHash, entry.network);
  if (o.status === 'missing') return { ok: true, entry };
  if (depth > 0) {
    return open(entry, 'The network gives changing answers about this request. Try again later.');
  }
  return checkForget(backend, entry, now, depth + 1);
}
