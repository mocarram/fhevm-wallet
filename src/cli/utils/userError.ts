/**
 * One way to turn any caught error into text that is safe to show the user.
 *
 * ethers transport errors carry the full request URL (`info.requestUrl`), and custom RPC
 * URLs usually embed an API key, so printing `err.message` can leak the key to the
 * terminal, scrollback or a CI log. Every CLI catch goes through `describeError`.
 * Shared by the commander commands and the (Phase 3) TUI.
 */

import {
  sanitizeContractText,
  translateTxError,
  wantsErrorDetails,
  WalletTxError,
} from '../../core/token/txErrors.js';
import { maskUrlsInText, redactSecrets } from '../../utils/redact.js';

/**
 * Translations that read well in any context: the network or the relayer is the problem,
 * whatever was being attempted. Send-specific ones (reverts, nonces) are left out: send
 * flows use `formatTxError` themselves, and "the send failed" would be wrong for, say,
 * adding a token.
 */
const GENERIC_CODES = new Set([
  'RPC_UNAVAILABLE',
  'WRONG_CHAIN',
  'RELAYER_TIMEOUT',
  'RELAYER_UNAVAILABLE',
]);

/** Strip anything that could carry a secret or terminal escapes from a message. */
export function safeText(text: string, max = 300): string {
  const firstLine = text.split('\n')[0];
  return sanitizeContractText(maskUrlsInText(redactSecrets(firstLine)), max);
}

/** The wallet's own explanation of `err`, if it has one that fits any context. */
function walletExplanation(err: unknown): WalletTxError | null {
  if (err instanceof WalletTxError) return err;
  const t = translateTxError(err);
  return GENERIC_CODES.has(t.code) ? t : null;
}

/** Options for `describeError`. */
export interface DescribeOptions {
  /** Append redacted technical details. Defaults to FHEW_DEBUG=1. */
  details?: boolean;
}

/**
 * A short, redacted, plain-English description of `err`, or `fallback` when there is
 * nothing useful to say. Wallet errors keep their title and hint; network and relayer
 * failures are translated; anything else is reduced to its first line with secrets and
 * URLs masked. With FHEW_DEBUG=1 the redacted original text follows on its own line.
 */
export function describeError(
  err: unknown,
  fallback = 'Something went wrong.',
  opts: DescribeOptions = {},
): string {
  const prompt = describePromptError(err);
  if (prompt) return prompt;
  const explained = walletExplanation(err);
  let text: string;
  if (explained) {
    text = safeText(`${explained.message} ${explained.hint}`, 400);
  } else {
    const e = err as { shortMessage?: unknown; message?: unknown } | null;
    // ethers puts a URL-free summary in shortMessage; the full message has request details.
    const summary =
      (e && typeof e.shortMessage === 'string' && e.shortMessage) ||
      (e && typeof e.message === 'string' && e.message) ||
      (typeof err === 'string' ? err : '');
    text = (summary ? safeText(summary) : '') || fallback;
  }
  const details = (opts.details ?? wantsErrorDetails()) ? technicalDetails(err) : '';
  return details ? `${text}\nTechnical details: ${details}` : text;
}

/**
 * A few words for a table cell: the wallet's title for known failures, else the first
 * line of the message, cut short. Never includes technical details.
 */
export function describeErrorShort(err: unknown, max = 60): string {
  const explained = walletExplanation(err);
  if (explained) return safeText(explained.message, max);
  return safeText(describeError(err, 'Failed', { details: false }), max);
}

/**
 * The original error text for FHEW_DEBUG=1, redacted (keys, configured RPC URL pieces,
 * URLs cut to scheme and host) and stripped of terminal escapes, on one line.
 */
export function technicalDetails(err: unknown, max = 2000): string {
  let raw: string;
  if (err instanceof WalletTxError) raw = err.raw;
  else if (err instanceof Error) raw = err.message;
  else {
    try {
      raw = JSON.stringify(err) ?? String(err);
    } catch {
      raw = String(err);
    }
  }
  return sanitizeContractText(maskUrlsInText(redactSecrets(raw)).replace(/\s*\n\s*/g, ' | '), max);
}

/** What a prompt library throws when stdin is closed, not a TTY, or Ctrl+C was pressed. */
export const NO_TERMINAL_MESSAGE =
  'This command needs to ask you something, but there is no interactive terminal. Run it in a terminal, or pass the values as options.';

/**
 * Recognise prompt failures (inquirer today, the Phase 3 TUI later) so they read as a
 * sentence instead of "readline was closed" or an ERR_USE_AFTER_CLOSE stack.
 */
export function describePromptError(err: unknown): string | null {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === 'ExitPromptError') return 'Cancelled.';
  const message = typeof e.message === 'string' ? e.message : '';
  if (
    e.code === 'ERR_USE_AFTER_CLOSE' ||
    e.name === 'AbortPromptError' ||
    /readline was closed/i.test(message)
  ) {
    return NO_TERMINAL_MESSAGE;
  }
  return null;
}
