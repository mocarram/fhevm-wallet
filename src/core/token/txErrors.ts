/**
 * Translate low-level ethers / RPC errors into messages a wallet user can act on.
 *
 * ethers v6 reports most send failures as a generic CALL_EXCEPTION or a long
 * "missing revert data" string. That is what users saw when sends failed on
 * Sepolia. Here we map the common shapes to a short title, a likely cause and
 * what to try next, while keeping the (redacted) raw text for technical details.
 */

import type { Interface } from 'ethers';
import { redactSecrets } from '../../utils/redact.js';

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

  constructor(
    code: TxErrorCode,
    title: string,
    cause: string,
    hint: string,
    raw = '',
    txHash?: string,
  ) {
    super(title);
    this.name = 'WalletTxError';
    this.code = code;
    this.likelyCause = cause;
    this.hint = hint;
    this.raw = redactSecrets(raw);
    this.txHash = txHash;
  }
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
  receipt?: { hash?: string } | null;
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

/** Pull a readable raw string out of anything that was thrown (redacted in the constructor). */
function rawText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Make contract-supplied text safe to print: tokens are user-added and untrusted, so a
 * revert reason could carry terminal escape sequences or misleading instructions.
 */
export function sanitizeContractText(text: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
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
 * Convert any error thrown while preparing or sending a transaction into a WalletTxError.
 * Already-translated errors pass through unchanged.
 */
export function translateTxError(err: unknown, opts: TranslateOptions = {}): WalletTxError {
  if (err instanceof WalletTxError) return err;

  const action = opts.action ?? 'send';
  const e = (err ?? {}) as EthersLikeError;
  const raw = rawText(err);
  const lower = raw.toLowerCase();

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

  // A custom error from the token contract: decoded by ethers, or decoded here from data.
  const revertName = e.revert?.name ?? decodeCustomError(e.data, opts.iface);
  if (revertName && CUSTOM_ERRORS[revertName]) {
    const m = CUSTOM_ERRORS[revertName];
    return new WalletTxError(m.code, m.title, m.cause, m.hint, raw);
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
 * Wrap an error that happened *after* a transaction was broadcast. The transaction may
 * still confirm, so the user must not be told to "try again".
 */
export function sentButUnconfirmed(
  err: unknown,
  txHash: string,
  explorerUrl: string,
  opts: TranslateOptions = {},
): WalletTxError {
  const translated = translateTxError(err, opts);
  if (translated.code === 'TX_REVERTED') return translated;
  return new WalletTxError(
    'SENT_UNCONFIRMED',
    'The transaction was sent, but its confirmation could not be checked.',
    'The connection dropped or timed out while waiting. The transaction may still confirm.',
    `Do not send again yet. Check ${explorerUrl} first.`,
    translated.raw,
    txHash,
  );
}

/** Format a WalletTxError as plain lines for non-interactive output. */
export function formatTxError(err: WalletTxError, includeRaw = wantsErrorDetails()): string {
  const lines = [err.message, '', `Likely cause: ${err.likelyCause}`, `What to try:  ${err.hint}`];
  if (err.txHash) lines.push(`Transaction:  ${err.txHash}`);
  if (includeRaw && err.raw) lines.push('', `Technical details: ${err.raw}`);
  else if (err.raw) lines.push('', 'Set FHEW_DEBUG=1 to see technical details.');
  return lines.join('\n');
}

/** Whether the user asked for technical details on errors (FHEW_DEBUG=1). */
export function wantsErrorDetails(): boolean {
  return process.env.FHEW_DEBUG === '1';
}
