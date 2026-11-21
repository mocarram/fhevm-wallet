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
  | { kind: 'failed'; reason: string };

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
 * the entry then stays `signed` for `reconcileUnwrap` to check later.
 */
export async function sendUnwrapRequest(
  prepared: PreparedUnwrap,
  ctx: { network: NetworkName; wallet: string; info: WrapperInfo; amount: bigint },
  hooks: SendHooks = {},
): Promise<{ result: UnwrapRequestResult; entry: UnwrapEntry }> {
  let entry: UnwrapEntry | null = null;
  const { info } = ctx;
  const result = await prepared.send({
    ...hooks,
    onSigned: (txHash) => {
      entry = addUnwrap({
        id: txHash,
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
      hooks.onSigned?.(txHash);
    },
  });
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
      e = updateUnwrap(e.id, { state: 'failed', requestBlock: o.blockNumber });
      return {
        entry: e,
        next: {
          kind: 'failed',
          reason: 'The request was mined, but the wrapper reported no unwrap request in it.',
        },
      };
    }
    e = updateUnwrap(e.id, { state: 'requested', requestId: id, requestBlock: o.blockNumber });
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
  }
}
