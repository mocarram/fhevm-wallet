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
  WalletTxError,
} from '../../core/token/txErrors.js';
import { maskUrlsInText, redactSecrets } from '../../utils/redact.js';

/**
 * Connection-level codes that `translateTxError` words well in any context. Send-specific
 * codes (reverts, nonces) are left out: send flows use `formatTxError` themselves, and
 * "the send failed" would be wrong for, say, adding a token.
 */
const TRANSLATED_CODES = new Set(['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'WRONG_CHAIN']);

/** Strip anything that could carry a secret or terminal escapes from a message. */
export function safeText(text: string, max = 300): string {
  const firstLine = text.split('\n')[0];
  return sanitizeContractText(maskUrlsInText(redactSecrets(firstLine)), max);
}

/**
 * A short, redacted, plain-English description of `err`, or `fallback` when there is
 * nothing useful to say. Wallet errors keep their title and hint; ethers errors are
 * translated; anything else is reduced to its first line with secrets and URLs masked.
 */
export function describeError(err: unknown, fallback = 'Something went wrong.'): string {
  const prompt = describePromptError(err);
  if (prompt) return prompt;
  if (err instanceof WalletTxError) return safeText(`${err.message} ${err.hint}`, 400);
  const e = err as { code?: unknown; shortMessage?: unknown; message?: unknown } | null;
  if (e && typeof e.code === 'string' && TRANSLATED_CODES.has(e.code)) {
    const t = translateTxError(err);
    return safeText(`${t.message} ${t.hint}`, 400);
  }
  // ethers puts a URL-free summary in shortMessage; the full message has request details.
  const text =
    (e && typeof e.shortMessage === 'string' && e.shortMessage) ||
    (e && typeof e.message === 'string' && e.message) ||
    (typeof err === 'string' ? err : '');
  const clean = text ? safeText(text) : '';
  return clean || fallback;
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
