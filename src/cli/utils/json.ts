/**
 * `--json` output for non-interactive commands.
 *
 * Contract (documented in the README, keep it stable):
 * - stdout carries exactly one JSON document, pretty-printed, then a newline. Nothing
 *   else goes to stdout: no colours, spinners or tables. Notices stay on stderr.
 * - Keys are camelCase and never renamed; new keys may be added.
 * - bigint values (wei, base units) are decimal strings, so no precision is lost.
 * - Errors are `{"error": {"code": "...", "message": "..."}}` with exit code 1.
 * - Every string is redacted like text output (API keys, RPC URL keys), and RPC URLs are
 *   shown masked (`https://host/…`) by the commands that print them.
 */

import chalk from 'chalk';
import { redactSecrets } from '../../utils/redact.js';
import { WalletTxError } from '../../core/token/txErrors.js';
import { describeError } from './userError.js';

/** Turn off colours for the rest of the process (chalk is used deep in helpers). */
export function enterJsonMode(): void {
  chalk.level = 0;
}

/** A deep copy with bigints as strings and every string redacted. */
export function toJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = toJsonValue(v);
    }
    return out;
  }
  return value;
}

/** Print one JSON document to stdout. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(toJsonValue(value), null, 2) + '\n');
}

/** The `{code, message}` for an error: the wallet's own code when it has one. */
export function jsonErrorOf(err: unknown, fallback: string): { code: string; message: string } {
  const code =
    err instanceof WalletTxError
      ? err.code
      : typeof (err as { code?: unknown })?.code === 'string'
        ? ((err as { code: string }).code as string)
        : 'ERROR';
  return { code, message: describeError(err, fallback, { details: false }) };
}

/** Print `{"error": {...}}` and set exit code 1. */
export function printJsonError(code: string, message: string): void {
  process.exitCode = 1;
  printJson({ error: { code, message } });
}

/** Print an error object as JSON (see `jsonErrorOf`) and set exit code 1. */
export function failJson(err: unknown, fallback: string): void {
  const e = jsonErrorOf(err, fallback);
  printJsonError(e.code, e.message);
}
