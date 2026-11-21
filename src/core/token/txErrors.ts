/**
 * Translate low-level ethers / RPC errors into messages a wallet user can act on.
 *
 * ethers v6 reports most send failures as a generic CALL_EXCEPTION or a long
 * "missing revert data" string. That is what users saw when sends failed on
 * Sepolia. Here we map the common shapes to a short title, a likely cause and
 * what to try next, while keeping the (redacted) raw text for technical details.
 */

import type { Interface } from 'ethers';
import { maskUrlsInText, redactDebugText, redactSecrets } from '../../utils/redact.js';
import { TimeoutError } from '../../utils/timeout.js';
import { stripUnsafeChars } from '../../utils/text.js';
import { classifyRpcLimit, RATE_LIMIT_RE } from '../network/rpcLimits.js';

export { RATE_LIMIT_RE };

/** Stable codes so UI code and tests can branch on the kind of failure. */
export type TxErrorCode =
  | 'INSUFFICIENT_GAS_FUNDS'
  | 'CONTRACT_REJECTED'
  | 'NOT_ERC7984'
  | 'INVALID_RECEIVER'
  | 'UNAUTHORIZED'
  | 'RPC_UNAVAILABLE'
  | 'NONCE_CONFLICT'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'TX_REVERTED'
  | 'SENT_UNCONFIRMED'
  | 'TX_REPLACED'
  | 'WRONG_CHAIN'
  | 'INSUFFICIENT_TOKEN_BALANCE'
  | 'BALANCE_CHECK_FAILED'
  | 'RELAYER_TIMEOUT'
  | 'RELAYER_UNAVAILABLE'
  | 'NOT_A_TOKEN'
  | 'RPC_ERROR'
  | 'RPC_RATE_LIMITED'
  | 'RPC_AUTH'
  | 'RPC_BAD_ANSWER'
  | 'PUBLIC_DECRYPT_PENDING'
  | 'DISCLOSE_IS_BALANCE'
  | 'DISCLOSE_UNKNOWN_HANDLE'
  | 'UNKNOWN';

/** A user-facing transaction error. `raw` is only shown when the user asks for details. */
export class WalletTxError extends Error {
  readonly code: TxErrorCode;
  /** One or two sentences on why this probably happened. */
  readonly likelyCause: string;
  /** What the user can do next. */
  readonly hint: string;
  /** Original error text with secrets masked, for the technical-details view. */
  readonly raw: string;
  /**
   * Set when a transaction was already broadcast. The UI must show it: the user needs it
   * to check the explorer instead of resending (which could send the money twice).
   */
  readonly txHash?: string;
  /**
   * Set for TX_REPLACED: the hash of the transaction that was mined in place of `txHash`
   * (same nonce). The UI shows it so the user can look up what actually happened.
   */
  readonly replacementHash?: string;

  constructor(
    code: TxErrorCode,
    title: string,
    cause: string,
    hint: string,
    raw = '',
    txHash?: string,
    replacementHash?: string,
  ) {
    super(title);
    this.name = 'WalletTxError';
    this.code = code;
    this.likelyCause = cause;
    this.hint = hint;
    // Shown with FHEW_DEBUG=1: keys masked, URLs cut to scheme and host, no escapes.
    this.raw = stripUnsafeChars(maskUrlsInText(redactDebugText(raw)));
    this.txHash = txHash;
    this.replacementHash = replacementHash;
  }
}

/**
 * Thrown by the decrypt step (the relayer SDK's user decrypt), wrapping what it threw.
 * Lets callers tell "the relayer failed" apart from "the contract read failed" without
 * guessing from the text: only this one becomes BALANCE_CHECK_FAILED before a send.
 */
export class DecryptionFailedError extends Error {
  readonly code = 'DECRYPTION_FAILED';
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'DecryptionFailedError';
  }
}

/**
 * True for errors that come from Zama's relayer SDK rather than the RPC: its messages
 * name the relayer ("Relayer didn't response correctly. Bad JSON.") and its error codes
 * start with RELAYER_.
 */
export function isRelayerError(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof e.code === 'string' && /^RELAYER_/i.test(e.code)) return true;
  if (typeof e.name === 'string' && /relayer/i.test(e.name)) return true;
  return typeof e.message === 'string' && /\brelayer\b/i.test(e.message);
}

/**
 * True when a read call got `0x` back: ethers' BAD_DATA ("could not decode result data").
 * That is what an address with no code (or a contract without that function and a
 * silent fallback) returns. A revert with no data is *not* enough on its own: ethers
 * gives a JSON-RPC error (rate limit, bad key) the same CALL_EXCEPTION shape, so callers
 * confirm "no contract" with eth_getCode (see TokenService).
 */
export function isNoContractAnswer(err: unknown): boolean {
  return ((err ?? {}) as EthersLikeError).code === 'BAD_DATA';
}

/** A revert with no data and no JSON-RPC error behind it: maybe no contract at all. */
export function isEmptyRevert(err: unknown): boolean {
  const e = (err ?? {}) as EthersLikeError;
  return (
    e.code === 'CALL_EXCEPTION' &&
    e.action === 'call' &&
    (e.data === null || e.data === undefined || e.data === '0x') &&
    rpcErrorOf(err) === null
  );
}

/** A JSON-RPC error object the node sent back (`{"error": {code, message}}`). */
export interface RpcErrorReply {
  code: number | null;
  message: string;
}

/**
 * The node's own JSON-RPC error behind an ethers error, unless it is a revert (which is
 * the contract's answer, not the endpoint's). ethers keeps it under `info.error` (calls
 * and estimates: CALL_EXCEPTION) or `error` (UNKNOWN_ERROR "could not coalesce error").
 */
export function rpcErrorOf(err: unknown): RpcErrorReply | null {
  const e = (err ?? {}) as {
    code?: unknown;
    error?: { code?: unknown; message?: unknown };
    info?: { error?: { code?: unknown; message?: unknown } };
  };
  if (e.code !== 'CALL_EXCEPTION' && e.code !== 'UNKNOWN_ERROR') return null;
  const rpc = e.info?.error ?? e.error;
  if (!rpc || typeof rpc !== 'object') return null;
  const message = typeof rpc.message === 'string' ? rpc.message : '';
  if (/revert/i.test(message)) return null;
  if (!message && typeof rpc.code !== 'number') return null;
  return { code: typeof rpc.code === 'number' ? rpc.code : null, message };
}

/** ...and for a missing, wrong or expired key. */
const AUTH_RE =
  /unauthori[sz]ed|forbidden|invalid (?:api )?key|api key|not allowed|authenticat|permission denied/i;

/** Translate a JSON-RPC error from the endpoint itself into plain words. */
function rpcReplyError(reply: RpcErrorReply, raw: string): WalletTxError {
  // Range and pruning first: Infura sends "query returned more than 10000 results" with
  // -32005, the code others use for rate limits.
  const limit = classifyRpcLimit({ code: reply.code ?? undefined, message: reply.message });
  if (limit === 'pruned') {
    return new WalletTxError(
      'RPC_ERROR',
      'Your RPC endpoint does not keep blocks that old.',
      'Public endpoints keep only recent history (about a week); older logs need an archive node.',
      'Set an Etherscan API key (fhevm-wallet config --etherscan-key -) or an archive RPC URL.',
      raw,
    );
  }
  if (limit === 'range') {
    return new WalletTxError(
      'RPC_ERROR',
      'Your RPC endpoint refused a log query of that size.',
      'It limits how many blocks one eth_getLogs request may cover.',
      'Try again, or set an RPC URL with higher limits or an Etherscan API key.',
      raw,
    );
  }
  if (reply.code === -32005 || RATE_LIMIT_RE.test(reply.message)) {
    return new WalletTxError(
      'RPC_RATE_LIMITED',
      'Your RPC endpoint is limiting requests.',
      'It answered that the rate limit or daily quota of this endpoint is used up.',
      'Wait a while, or set an RPC URL with a higher limit (fhevm-wallet config --rpc-sepolia -).',
      raw,
    );
  }
  if (AUTH_RE.test(reply.message)) {
    return new WalletTxError(
      'RPC_AUTH',
      'Your RPC endpoint refused the request.',
      'The API key in the RPC URL may be missing, wrong or expired.',
      'Check the key with your provider, then set the URL again (fhevm-wallet config --rpc-sepolia -).',
      raw,
    );
  }
  // The reason is the provider's text: redact and sanitise it before showing it.
  const reason = sanitizeContractText(maskUrlsInText(redactSecrets(reply.message)), 160);
  return new WalletTxError(
    'RPC_ERROR',
    reason
      ? `The RPC endpoint returned an error: ${reason}`
      : 'The RPC endpoint returned an error.',
    `It answered with JSON-RPC error ${reply.code ?? 'without a code'} instead of a result.`,
    'Try again. If it keeps happening, check the RPC URL or use another endpoint.',
    raw,
  );
}

/** Shape of the ethers v6 error fields we look at. All optional: errors come from many places. */
interface EthersLikeError {
  code?: string;
  action?: string;
  shortMessage?: string;
  message?: string;
  reason?: string | null;
  data?: string | null;
  revert?: { name?: string; args?: unknown[] } | null;
  receipt?: { hash?: string; status?: number | null } | null;
  /**
   * TRANSACTION_REPLACED only: the hash of the transaction that was mined *instead*
   * (ethers sets `hash`, `replacement` and `receipt` all to the replacement).
   */
  hash?: string;
  replacement?: { hash?: string } | null;
}

/** Custom errors declared by OpenZeppelin's ERC7984, mapped to plain language. */
const CUSTOM_ERRORS: Record<
  string,
  { code: TxErrorCode; title: string; cause: string; hint: string }
> = {
  ERC7984InvalidReceiver: {
    code: 'INVALID_RECEIVER',
    title: 'The token refused this recipient.',
    cause: 'ERC-7984 tokens reject the zero address and some contract addresses as receivers.',
    hint: 'Check the recipient address.',
  },
  ERC7984InvalidSender: {
    code: 'UNAUTHORIZED',
    title: 'The token refused this sender.',
    cause: 'The sending address is not allowed to transfer from this account.',
    hint: 'Make sure you are sending from the wallet that holds the tokens.',
  },
  ERC7984UnauthorizedSpender: {
    code: 'UNAUTHORIZED',
    title: 'This wallet is not an operator for that account.',
    cause: 'Transfers on behalf of someone else need an operator approval that has not expired.',
    hint: 'Ask the holder to set you as an operator, or send from your own wallet.',
  },
  ERC7984UnauthorizedUseOfEncryptedAmount: {
    code: 'UNAUTHORIZED',
    title: 'The encrypted amount was not accepted.',
    cause: 'The encrypted input was created for a different sender or contract.',
    hint: 'Try again; the amount will be re-encrypted for this wallet.',
  },
  ERC7984ZeroBalance: {
    code: 'CONTRACT_REJECTED',
    title: 'This wallet has no balance of that token.',
    cause: 'The token has never credited this address.',
    hint: 'Check you picked the right wallet and token.',
  },
  ZamaProtocolUnsupported: {
    code: 'CONTRACT_REJECTED',
    title: 'This token does not support the current Zama protocol.',
    cause: 'The token was deployed for a different fhEVM configuration.',
    hint: 'Check the token address and network with the token issuer.',
  },
};

/** Options for `translateTxError`. */
export interface TranslateOptions {
  /**
   * Contract interface used to decode custom-error revert data. ethers only decodes
   * custom errors in staticCall; estimateGas and wait() leave the raw selector in `data`.
   */
  iface?: Interface;
  /** What was being attempted, for titles: "send" (default) or e.g. "operator change". */
  action?: string;
}

/** The relayer failed in some way other than a timeout. */
function relayerUnavailable(raw: string): WalletTxError {
  return new WalletTxError(
    'RELAYER_UNAVAILABLE',
    "Zama's relayer could not complete the request.",
    'Encryption and decryption go through the relayer, which returned an error or an unreadable answer.',
    'Try again in a few minutes. Your RPC settings are not the problem.',
    raw,
  );
}

/** Pull a readable raw string out of anything that was thrown (redacted in the constructor). */
function rawText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    // JSON.stringify(undefined) is undefined, not a string.
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Make contract-supplied text safe to print: tokens are user-added and untrusted, so a
 * revert reason could carry terminal escape sequences or misleading instructions.
 */
export function sanitizeContractText(text: string, max = 120): string {
  // Control characters (terminal escapes) plus bidi, line-separator and invisible
  // characters, which could visually reorder or hide parts of an address.
  const clean = stripUnsafeChars(text).trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/** Try to decode a custom-error name from revert data with the given interface. */
function decodeCustomError(data: string | null | undefined, iface?: Interface): string | null {
  if (!iface || !data || data.length < 10) return null;
  try {
    return iface.parseError(data)?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the error for ethers' TRANSACTION_REPLACED, which wait() throws when another
 * transaction with the same nonce was mined instead of ours. ethers classifies it:
 * - "repriced":  same recipient, data and value, different fee. The same action most
 *   likely happened, under a different hash.
 * - "cancelled": a zero-value self-send took the nonce. This action did not happen.
 * - "replaced":  some other transaction took the nonce. This action did not happen as sent.
 * We never claim success here: the user checks the explorer, which is the source of truth.
 */
function replacedError(
  e: EthersLikeError,
  raw: string,
  action: string,
  txHash?: string,
  explorerUrl?: string,
): WalletTxError {
  // In ethers' TRANSACTION_REPLACED error, `hash`, `replacement` and `receipt` all describe
  // the replacement, never our transaction. The original hash is only known when the
  // caller passes it (sentButUnconfirmed); on the bare translateTxError path it stays
  // undefined rather than being mislabelled.
  const original = txHash;
  const replacementHash = e.replacement?.hash ?? e.hash ?? e.receipt?.hash ?? undefined;
  // Point at the transaction that was actually mined when we know it. Explorer URLs end
  // in /tx/<hash>, so swap the hash rather than needing the network here.
  let link = explorerUrl;
  if (link && original && replacementHash && link.endsWith(original)) {
    link = link.slice(0, -original.length) + replacementHash;
  }
  const check = link ? `Check ${link}` : 'Check the transaction on the block explorer';
  if (e.reason === 'repriced') {
    // Same call, different fee. ethers reports this once the replacement is mined, but
    // mined is not succeeded: its receipt can still say it reverted.
    if (e.receipt?.status === 0) {
      return new WalletTxError(
        'TX_REPLACED',
        'The transaction was re-sent with a different fee, and that version reverted.',
        `Another transaction with the same nonce, recipient and data was mined instead, but it reverted on-chain, so the ${action} did not go through. The network fee was still paid.`,
        `${check} before trying again.`,
        raw,
        original,
        replacementHash,
      );
    }
    return new WalletTxError(
      'TX_REPLACED',
      'The transaction was re-sent with a different fee.',
      `Another transaction with the same nonce, recipient and data was mined instead, so the ${action} most likely went through under a different hash.`,
      `Do not send again. ${check} to confirm it.`,
      raw,
      original,
      replacementHash,
    );
  }
  const how = e.reason === 'cancelled' ? 'cancelled' : 'replaced';
  return new WalletTxError(
    'TX_REPLACED',
    `The transaction was ${how} by another one with the same nonce.`,
    `A different transaction from this wallet was mined in its place, so this ${action} did not happen as sent.`,
    `${check} to see what was mined before trying again.`,
    raw,
    original,
    replacementHash,
  );
}

/**
 * Convert any error thrown while preparing or sending a transaction into a WalletTxError.
 * Already-translated errors pass through unchanged.
 */
export function translateTxError(err: unknown, opts: TranslateOptions = {}): WalletTxError {
  if (err instanceof WalletTxError) return err;

  const action = opts.action ?? 'send';
  const e = (err ?? {}) as EthersLikeError;
  const raw = rawText(err);
  const lower = raw.toLowerCase();

  // The decrypt step failed: judge it by what the relayer SDK threw.
  if (err instanceof DecryptionFailedError) {
    const inner = translateTxError(err.cause, opts);
    if (inner.code === 'RELAYER_TIMEOUT' || inner.code === 'RELAYER_UNAVAILABLE') return inner;
    return relayerUnavailable(raw);
  }

  // withTimeout gave up on the relayer SDK (encryption or decryption). That is not an
  // RPC problem, so don't send the user off to check their RPC settings.
  if (err instanceof TimeoutError) {
    return new WalletTxError(
      'RELAYER_TIMEOUT',
      'The Zama relayer did not answer in time.',
      `${err.message}. Encryption and decryption go through Zama's relayer, which is slow or unreachable right now.`,
      'Try again in a minute. If it keeps happening, check your connection.',
      raw,
    );
  }

  // The relayer answered badly or not at all (not a timeout). Also not an RPC problem.
  if (isRelayerError(err)) return relayerUnavailable(raw);

  // Not enough ETH to pay for gas. Nodes word this differently, so check text too.
  if (e.code === 'INSUFFICIENT_FUNDS' || lower.includes('insufficient funds')) {
    return new WalletTxError(
      'INSUFFICIENT_GAS_FUNDS',
      'Not enough ETH to pay the network fee.',
      'Every transaction needs a little ETH for gas, even though token amounts are encrypted.',
      'Add ETH to this wallet (on Sepolia, use a faucet) and try again.',
      raw,
    );
  }

  // The endpoint itself answered with a JSON-RPC error (rate limit, bad key, an internal
  // error). ethers wraps those as CALL_EXCEPTION or UNKNOWN_ERROR "could not coalesce
  // error"; neither means the contract said anything.
  const reply = rpcErrorOf(err);
  if (reply) return rpcReplyError(reply, raw);

  // An answer the wallet could not read at all (malformed JSON-RPC result). Callers
  // that can tell "no contract" apart (`0x` from an empty address) do so first.
  if (e.code === 'BAD_DATA') {
    return new WalletTxError(
      'RPC_BAD_ANSWER',
      'The RPC endpoint sent an answer the wallet could not read.',
      'Its reply did not have the shape a JSON-RPC node returns.',
      'Try again, or use another RPC endpoint.',
      raw,
    );
  }

  // A mined transaction that reverted: ethers' wait() throws CALL_EXCEPTION with
  // action "sendTransaction" and the receipt attached. Gas was spent; say so.
  if (e.code === 'CALL_EXCEPTION' && e.action === 'sendTransaction' && e.receipt) {
    return new WalletTxError(
      'TX_REVERTED',
      `The ${action} was mined but reverted on-chain.`,
      'The contract rejected it after the simulation passed. The network fee was still paid.',
      'Check the transaction on the block explorer before trying again.',
      raw,
      e.receipt.hash,
    );
  }

  // wait() saw another transaction with the same nonce mined instead of this one.
  if (e.code === 'TRANSACTION_REPLACED') {
    return replacedError(e, raw, action);
  }

  // A custom error from the token contract: decoded by ethers, or decoded here from data.
  const revertName = e.revert?.name ?? decodeCustomError(e.data, opts.iface);
  if (revertName && CUSTOM_ERRORS[revertName]) {
    const m = CUSTOM_ERRORS[revertName];
    return new WalletTxError(m.code, m.title, m.cause, m.hint, raw);
  }

  // The RPC answers for another chain (ProviderFactory's WrongChainError). Signing for
  // one chain while reading another would give nonsense balances and failed sends.
  if (e.code === 'WRONG_CHAIN') {
    return new WalletTxError(
      'WRONG_CHAIN',
      'Your RPC endpoint is on the wrong network.',
      e.message ?? 'The RPC endpoint serves a different chain.',
      'Fix the RPC URL in Settings, or reset it to the default.',
      raw,
    );
  }

  // The RPC is unreachable, slow or misbehaving.
  if (
    e.code === 'NETWORK_ERROR' ||
    e.code === 'TIMEOUT' ||
    e.code === 'SERVER_ERROR' ||
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound')
  ) {
    return new WalletTxError(
      'RPC_UNAVAILABLE',
      'Could not reach the network.',
      'The RPC endpoint did not answer, or answered with an error.',
      'Check your connection or RPC settings, then try again.',
      raw,
    );
  }

  if (e.code === 'NONCE_EXPIRED' || e.code === 'REPLACEMENT_UNDERPRICED') {
    return new WalletTxError(
      'NONCE_CONFLICT',
      'Another transaction from this wallet is still pending.',
      'The network saw a transaction with the same nonce.',
      'Wait for the pending transaction to confirm, then try again.',
      raw,
    );
  }

  if (e.code === 'CALL_EXCEPTION') {
    // No revert data at all during simulation usually means the function does not exist
    // on this contract: wrong address, wrong network, or not an ERC-7984 token.
    const missingData = e.data === null || e.data === undefined;
    if (e.action === 'estimateGas' && missingData && lower.includes('missing revert data')) {
      return new WalletTxError(
        'NOT_ERC7984',
        `The token contract rejected the ${action} when it was simulated.`,
        'The contract returned no reason. It may not be an ERC-7984 token, or it may be on a different network.',
        'Check the token address and network on a block explorer.',
        raw,
      );
    }
    const reason = e.reason ? sanitizeContractText(e.reason) : '';
    return new WalletTxError(
      'CONTRACT_REJECTED',
      `The token contract rejected the ${action}.`,
      reason
        ? `The contract's own message (unverified): "${reason}".`
        : 'The contract reverted without a reason.',
      'Check the token, recipient and amount, then try again.',
      raw,
    );
  }

  return new WalletTxError(
    'UNKNOWN',
    `The ${action} failed.`,
    e.shortMessage ? sanitizeContractText(e.shortMessage, 200) : 'An unexpected error occurred.',
    'Try again. If it keeps failing, check your RPC and network settings.',
    raw,
  );
}

/**
 * Node refusals (ethers error codes) that prove a broadcast transaction was NOT accepted,
 * so a retry after fixing the cause is safe.
 *
 * NONCE_EXPIRED ("nonce too low") is deliberately not here. Public RPC gateways retry
 * eth_sendRawTransaction across backends: backend A can accept and mine our transaction
 * while backend B then answers "nonce too low" because of that very transaction. Treating
 * that as "not sent" would tell the user to send again and pay twice.
 */
const DEFINITELY_NOT_SENT = new Set(['INSUFFICIENT_FUNDS', 'REPLACEMENT_UNDERPRICED']);

/**
 * Wrap an error that happened *after* a transaction was signed and handed to the network
 * (broadcast or wait). The transaction may still confirm, so the user must not be told to
 * "try again" unless the node's answer proves it was refused (see DEFINITELY_NOT_SENT).
 */
export function sentButUnconfirmed(
  err: unknown,
  txHash: string,
  explorerUrl: string,
  opts: TranslateOptions = {},
): WalletTxError {
  const e = (err ?? {}) as EthersLikeError;
  const action = opts.action ?? 'send';
  const translated = translateTxError(err, opts);
  if (translated.code === 'TX_REVERTED') {
    // Mined and reverted: point straight at the explorer entry.
    return new WalletTxError(
      'TX_REVERTED',
      translated.message,
      translated.likelyCause,
      `Check ${explorerUrl} before trying again.`,
      translated.raw,
      txHash,
    );
  }
  if (translated.code === 'TX_REPLACED') {
    return replacedError(e, translated.raw, action, txHash, explorerUrl);
  }
  // Decide on the original ethers code, not the translated one: NONCE_EXPIRED and
  // REPLACEMENT_UNDERPRICED both translate to NONCE_CONFLICT but mean different things here.
  // Anything else, including an unclassified error that merely mentions "insufficient
  // funds", errs on the side of "may have been sent".
  if (e.code !== undefined && DEFINITELY_NOT_SENT.has(e.code)) {
    return translated;
  }
  const cause =
    e.code === 'NONCE_EXPIRED'
      ? "The network said this wallet's nonce was already used. That can happen when this very transaction was already accepted, so it may confirm."
      : 'The connection dropped, timed out or returned an unclear answer. The transaction may still confirm.';
  return new WalletTxError(
    'SENT_UNCONFIRMED',
    'The transaction may have been sent, but its confirmation could not be checked.',
    cause,
    `Do not send again yet. Check ${explorerUrl} first.`,
    translated.raw,
    txHash,
  );
}

/** Format a WalletTxError as plain lines for non-interactive output. */
export function formatTxError(err: WalletTxError, includeRaw = wantsErrorDetails()): string {
  const lines = [err.message, '', `Likely cause: ${err.likelyCause}`, `What to try:  ${err.hint}`];
  if (err.txHash) lines.push(`Transaction:  ${err.txHash}`);
  if (err.replacementHash) lines.push(`Replaced by:  ${err.replacementHash}`);
  if (includeRaw && err.raw) lines.push('', `Technical details: ${stripUnsafeChars(err.raw)}`);
  else if (err.raw) lines.push('', 'Set FHEW_DEBUG=1 to see technical details.');
  return lines.join('\n');
}

/** Whether the user asked for technical details on errors (FHEW_DEBUG=1). */
export function wantsErrorDetails(): boolean {
  return process.env.FHEW_DEBUG === '1';
}

/** The amount is not publicly decryptable yet (step 1 not mined, or the relayer is behind). */
export function pendingPublicDecryption(raw?: string): WalletTxError {
  return new WalletTxError(
    'PUBLIC_DECRYPT_PENDING',
    'This amount is not publicly decryptable yet.',
    'Step 1 (the disclosure request) has to be confirmed on-chain, and the Zama gateway then needs a little time.',
    'Wait a minute and try again. Nothing was signed or sent.',
    raw,
  );
}

/**
 * Refusal to disclose a balance handle. `requestDiscloseEncryptedAmount` accepts any
 * handle the caller may use, including its own `confidentialBalanceOf`, and would make
 * the whole balance publicly decryptable for good.
 */
export function discloseIsBalanceError(): WalletTxError {
  return new WalletTxError(
    'DISCLOSE_IS_BALANCE',
    'That handle is your current balance, not a transfer amount.',
    'Disclosing it would make your whole balance public, for good.',
    'Pass the transaction hash of the transfer you want to disclose.',
  );
}

/**
 * Refusal to disclose a handle that is no known transfer amount of this wallet. The
 * holder keeps ACL access to its earlier balance handles, so an unchecked handle could
 * publish an old balance for good.
 */
export function discloseUnknownHandleError(): WalletTxError {
  return new WalletTxError(
    'DISCLOSE_UNKNOWN_HANDLE',
    "That handle is not a transfer amount in this wallet's history.",
    'It could be an earlier balance of this wallet; disclosing it would publish that for good.',
    'Pass the transaction hash of the transfer, or run `fhew history` first to sync it.',
  );
}

/** Options for disclosure step 1. */
export interface DiscloseRequestOptions {
  /**
   * The caller already checked the handle some other way: it came from the transfer's
   * receipt, or the user typed an explicit confirmation. Otherwise the handle must be a
   * transfer amount in local history.
   */
  vouched?: boolean;
}
