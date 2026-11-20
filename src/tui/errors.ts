/**
 * The one place the TUI turns a caught error into something it shows the user.
 *
 * Every user-visible error in src/tui goes through `describeError` (or the line helpers
 * below that call it). It never shows a raw `err.message`: wallet errors keep their
 * plain-English title, likely cause and hint; ethers errors are translated with
 * `translateTxError`; anything else is cut to its first line with secrets (API keys in
 * RPC URLs, labelled private keys), URL paths and terminal escapes removed. The redacted
 * raw text is kept separately for "Show technical details".
 *
 * Phase 2 adds a shared `describeError` in src/cli/utils/userError.ts; once this branch
 * is rebased onto it, `describeError` here should delegate to it for the summary text.
 */

import {
  sanitizeContractText,
  translateTxError,
  WalletTxError,
  type TxErrorCode,
} from '../core/token/txErrors.js';
import { redactSecrets } from '../utils/redact.js';
import { dimLine, line, seg, type Line } from './text.js';

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

/** Keep only scheme and host of URLs: paths and queries often carry provider keys. */
function maskUrlPaths(text: string): string {
  return text.replace(/\b(https?:\/\/[^/\s"'<>]+)[^\s"'<>]*/gi, (_m, origin: string) => origin);
}

/** Make any error text safe to print: first line, redacted, no escapes, bounded length. */
export function safeText(text: string, max = 300): string {
  const firstLine = text.split('\n')[0];
  return sanitizeContractText(maskUrlPaths(redactSecrets(firstLine)), max);
}

/** True for errors that look like ethers / RPC errors (they carry a string `code`). */
function isEthersLike(err: unknown): boolean {
  const e = err as { code?: unknown; shortMessage?: unknown } | null;
  return Boolean(e && typeof e === 'object' && typeof e.code === 'string' && 'shortMessage' in e);
}

/**
 * Describe `err` for the user. `action` names what was being done ("send", "decrypt",
 * "add token") so translated ethers errors read correctly outside the send flow.
 */
export function describeError(
  err: unknown,
  opts: { action?: string; fallback?: string } = {},
): ShownError {
  const fallback = opts.fallback ?? 'Something went wrong.';
  if (err instanceof WalletTxError || isEthersLike(err)) {
    const t = translateTxError(err, { action: opts.action });
    // Our own wording: keep explorer links intact, still redact and strip escapes.
    const clean = (x: string) => sanitizeContractText(redactSecrets(x), 400);
    return {
      title: clean(t.message),
      cause: clean(t.likelyCause),
      hint: clean(t.hint),
      raw: t.raw,
      code: t.code,
      txHash: t.txHash,
      replacementHash: t.replacementHash,
    };
  }
  const e = err as { message?: unknown } | null;
  const text =
    (e && typeof e === 'object' && typeof e.message === 'string' && e.message) ||
    (typeof err === 'string' ? err : '');
  const title = text ? safeText(text) : '';
  return {
    title: title || fallback,
    cause: '',
    hint: '',
    raw: text ? redactSecrets(text) : '',
  };
}

/** One-line summary: title plus hint. Used under text fields and in short notices. */
export function errorSummary(err: unknown, opts: { action?: string; fallback?: string } = {}) {
  const d = describeError(err, opts);
  return d.hint ? `${d.title} ${d.hint}` : d.title;
}

/** Flash lines for an error: `✗ title`, then cause and hint dimmed. */
export function errorLines(
  err: unknown,
  opts: { action?: string; fallback?: string } = {},
): Line[] {
  const d = describeError(err, opts);
  const out: Line[] = [line('  ', seg(`✗ ${d.title}`, 'red'))];
  if (d.cause) out.push(dimLine(`    ${d.cause}`));
  if (d.hint) out.push(dimLine(`    ${d.hint}`));
  if (process.env.FHEW_DEBUG === '1' && d.raw) out.push(dimLine(`    ${safeText(d.raw, 400)}`));
  return out;
}

/** A field error pair [problem, what to do] from an error and a fallback hint. */
export function fieldErrorFrom(
  err: unknown,
  hint: string,
  opts: { action?: string; fallback?: string } = {},
): [string, string] {
  const d = describeError(err, opts);
  return [d.title, d.hint || hint];
}
