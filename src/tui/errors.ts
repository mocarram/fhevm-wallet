/**
 * The one place the TUI turns a caught error into something it shows the user.
 *
 * Every user-visible error in src/tui goes through `describeError` (or the line helpers
 * below that call it). The wording and redaction come from the CLI's shared
 * `src/cli/utils/userError.ts`, so the TUI and the commands say the same thing and mask
 * the same secrets (API keys, configured RPC URL pieces, URL paths, terminal escapes).
 * This module only adds the structure the TUI needs: title, likely cause and hint as
 * separate fields, and the redacted technical text for "Show technical details".
 */

import {
  sanitizeContractText,
  translateTxError,
  WalletTxError,
  type TxErrorCode,
} from '../core/token/txErrors.js';
import { describeError as describeCliError, technicalDetails } from '../cli/utils/userError.js';
import { redactSecrets } from '../utils/redact.js';
import { dimLine, line, seg, type Line } from './text.js';

export { safeText } from '../cli/utils/userError.js';

/** A user-facing description of an error. */
export interface ShownError {
  title: string;
  /** Why it probably happened (may be empty). */
  cause: string;
  /** What to try next (may be empty). */
  hint: string;
  /** Redacted technical text, shown only on request. */
  raw: string;
  code?: TxErrorCode;
  txHash?: string;
  replacementHash?: string;
}

/** Options for `describeError`. */
export interface ShowOptions {
  /**
   * What was being done. With "send", every ethers error is translated by the send
   * rules (reverts, nonces, gas); otherwise only failures that read well in any context
   * are (see userError.ts), and the rest are summarised.
   */
  action?: string;
  fallback?: string;
}

/** True for errors that look like ethers / RPC errors (they carry a string `code`). */
function isEthersLike(err: unknown): boolean {
  const e = err as { code?: unknown } | null;
  return Boolean(e && typeof e === 'object' && typeof e.code === 'string');
}

/** Describe `err` for the user. */
export function describeError(err: unknown, opts: ShowOptions = {}): ShownError {
  const fallback = opts.fallback ?? 'Something went wrong.';
  const raw = technicalDetails(err);
  if (err instanceof WalletTxError || (opts.action === 'send' && isEthersLike(err))) {
    const t = translateTxError(err, { action: opts.action });
    // The wallet's own wording: redacted and stripped of escapes, but its explorer links
    // are kept whole (the user needs them to check a transaction).
    const clean = (x: string) => sanitizeContractText(redactSecrets(x), 400);
    return {
      title: clean(t.message),
      cause: clean(t.likelyCause),
      hint: clean(t.hint),
      raw,
      code: t.code,
      txHash: t.txHash,
      replacementHash: t.replacementHash,
    };
  }
  const translated = isEthersLike(err) ? translateTxError(err) : null;
  return {
    title: describeCliError(err, fallback, { details: false }),
    cause: '',
    hint: '',
    raw,
    code: translated?.code,
  };
}

/** One-line summary: title plus hint. Used under text fields and in short notices. */
export function errorSummary(err: unknown, opts: ShowOptions = {}) {
  const d = describeError(err, opts);
  return d.hint ? `${d.title} ${d.hint}` : d.title;
}

/** Flash lines for an error: `✗ title`, then cause and hint dimmed. */
export function errorLines(err: unknown, opts: ShowOptions = {}): Line[] {
  const d = describeError(err, opts);
  const out: Line[] = [line('  ', seg(`✗ ${d.title}`, 'red'))];
  if (d.cause) out.push(dimLine(`    ${d.cause}`));
  if (d.hint) out.push(dimLine(`    ${d.hint}`));
  if (process.env.FHEW_DEBUG === '1' && d.raw) out.push(dimLine(`    ${d.raw.slice(0, 400)}`));
  return out;
}

/** A field error pair [problem, what to do] from an error and a fallback hint. */
export function fieldErrorFrom(
  err: unknown,
  hint: string,
  opts: ShowOptions = {},
): [string, string] {
  const d = describeError(err, opts);
  return [d.title, d.hint || hint];
}
