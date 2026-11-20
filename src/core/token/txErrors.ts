/**
 * Translate low-level ethers / RPC errors into messages a wallet user can act on.
 *
 * ethers v6 reports most send failures as a generic CALL_EXCEPTION or a long
 * "missing revert data" string. That is what users saw when sends failed on
 * Sepolia. Here we map the common shapes to a short title, a likely cause and
 * what to try next, while keeping the raw text for "Show technical details".
 */

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
  | 'UNKNOWN';

/** A user-facing transaction error. `raw` is never shown unless the user asks. */
export class WalletTxError extends Error {
  readonly code: TxErrorCode;
  /** One or two sentences on why this probably happened. */
  readonly likelyCause: string;
  /** What the user can do next. */
  readonly hint: string;
  /** Original error text, for the "technical details" view and logs. */
  readonly raw: string;

  constructor(code: TxErrorCode, title: string, cause: string, hint: string, raw = '') {
    super(title);
    this.name = 'WalletTxError';
    this.code = code;
    this.likelyCause = cause;
    this.hint = hint;
    this.raw = raw;
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
  info?: { error?: { code?: number; message?: string } };
  error?: { code?: number; message?: string };
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
    hint: 'Try the send again; the amount will be re-encrypted for this wallet.',
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

/** Pull a readable raw string out of anything that was thrown. */
function rawText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Convert any error thrown while preparing or sending a transfer into a WalletTxError.
 * Already-translated errors pass through unchanged.
 */
export function translateTxError(err: unknown): WalletTxError {
  if (err instanceof WalletTxError) return err;

  const e = (err ?? {}) as EthersLikeError;
  const raw = rawText(err);
  const lower = raw.toLowerCase();

  // Not enough ETH to pay for gas. Nodes word this differently, so check text too.
  if (e.code === 'INSUFFICIENT_FUNDS' || lower.includes('insufficient funds')) {
    return new WalletTxError(
      'INSUFFICIENT_GAS_FUNDS',
      'Not enough ETH to pay the network fee.',
      'Every send needs a little ETH for gas, even though the token amount is encrypted.',
      'Add ETH to this wallet (on Sepolia, use a faucet) and try again.',
      raw,
    );
  }

  // A decoded custom error from the token contract.
  const revertName = e.revert?.name;
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
      'Run "fhew doctor" to test your RPC, or set another endpoint in Settings.',
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

  // Revert during gas estimation with no data: the function is missing on this
  // contract (wrong address, wrong network, or not an ERC-7984 token).
  if (e.code === 'CALL_EXCEPTION') {
    const noData = e.data === null || e.data === '0x' || lower.includes('missing revert data');
    if (e.action === 'estimateGas' && noData) {
      return new WalletTxError(
        'NOT_ERC7984',
        'The token contract rejected the transfer when it was simulated.',
        'The contract has no working confidentialTransfer function, so it may not be an ERC-7984 token, or it is on a different network.',
        'Run "fhew doctor" to check the token and your RPC, and check the address on a block explorer.',
        raw,
      );
    }
    return new WalletTxError(
      'CONTRACT_REJECTED',
      'The token contract rejected the transfer.',
      e.reason ? `The contract said: ${e.reason}.` : 'The contract reverted without a reason.',
      'Check the token, recipient and amount, then try again.',
      raw,
    );
  }

  return new WalletTxError(
    'UNKNOWN',
    'The send failed.',
    e.shortMessage ?? 'An unexpected error occurred.',
    'Try again. If it keeps failing, run "fhew doctor".',
    raw,
  );
}

/** Format a WalletTxError as plain lines for non-interactive output. */
export function formatTxError(err: WalletTxError, includeRaw = false): string {
  const lines = [err.message, '', `Likely cause: ${err.likelyCause}`, `What to try:  ${err.hint}`];
  if (includeRaw && err.raw) lines.push('', `Technical details: ${err.raw}`);
  return lines.join('\n');
}
