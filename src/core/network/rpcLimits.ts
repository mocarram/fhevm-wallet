/**
 * Recognise the ways a JSON-RPC endpoint says "not like this" rather than "no": rate
 * limits, block-range caps on eth_getLogs, pruned history and plan restrictions.
 *
 * Public endpoints differ a lot (measured on Sepolia, Nov 2026):
 * - publicnode: `4444 "pruned history unavailable"` for logs older than about a week, and
 *   `-32701 "Please specify an address in your request…"` for topic-only log queries;
 * - nodies: `-32001 "Block range too large: maximum allowed is 50 blocks on your current
 *   plan…"`;
 * - drpc: HTTP 400 `{"code":35,"message":"chain is not available on free plan…"}`.
 *
 * The provider uses this to fail over read-only calls; the log chunker (`logRange.ts`)
 * uses it to shrink a chunk to the limit the endpoint names.
 */

/**
 * Wording providers use for "too many requests" or a used-up quota. Whole phrases only:
 * single words like "limit" or "exceed" also appear in unrelated errors ("exceeds block
 * gas limit", "exceeds max transaction gas limit"), which must not read as throttling.
 */
export const RATE_LIMIT_RE =
  /\brate[\s-]?limit|too many requests|\bquota\b|(?:^|\D)-32005\b|\b429\b|throttl/i;

/** "This chunk of blocks (or its result) is too big." */
const RANGE_RE =
  /block range|range (?:is )?too|too (?:large|wide|many blocks)|more than \d+ (?:results|logs)|query returned more than|response size|limit the query|exceeds? (?:the )?(?:max(?:imum)? )?(?:block )?range|log response size|maximum allowed is \d+ blocks?|limited to (?:a )?[\d,]+k? (?:block )?range|up to (?:a )?[\d,]+k? block range|range limit/i;

/** "This endpoint does not keep that block any more." */
const PRUNED_RE =
  /pruned|missing trie node|history (?:is )?(?:not |un)available|historical (?:state|data|blocks?) (?:is |are )?(?:not |un)available|requires? (?:an )?archive|archive (?:node|data|mode)/i;

/** "This endpoint (or its free plan) will not serve this kind of request." */
const RESTRICTED_RE =
  /specify an address|dedicated (?:full )?node|not available on (?:the |your )?(?:free|current|public)|(?:free|current|paid) plan|upgrade (?:to|your)|method not (?:found|allowed|supported|available)|unsupported method|not whitelisted|unauthori[sz]ed|forbidden|invalid api key/i;

/** Why an endpoint refused a request without that being the final answer. */
export type RpcLimitKind = 'range' | 'rate' | 'pruned' | 'restricted';

/** All the human text in an ethers error or a JSON-RPC error object, joined. */
export function rpcErrorText(err: unknown): string {
  const e = (err ?? {}) as {
    message?: unknown;
    shortMessage?: unknown;
    error?: { message?: unknown };
    info?: { error?: { message?: unknown } };
  };
  return [e.message, e.shortMessage, e.error?.message, e.info?.error?.message]
    .filter((x): x is string => typeof x === 'string')
    .join(' ');
}

/** The JSON-RPC error code behind an ethers error or error object, if any. */
function rpcCode(err: unknown): number | null {
  const e = (err ?? {}) as {
    code?: unknown;
    error?: { code?: unknown };
    info?: { error?: { code?: unknown } };
  };
  for (const c of [e.error?.code, e.info?.error?.code, e.code]) {
    if (typeof c === 'number') return c;
  }
  return null;
}

/**
 * Classify a JSON-RPC error reply (or an ethers error wrapping one). Range is checked
 * first: Infura reports "query returned more than 10000 results" with code -32005, which
 * other providers use for rate limits.
 */
export function classifyRpcLimit(err: unknown): RpcLimitKind | null {
  const text = rpcErrorText(err);
  const code = rpcCode(err);
  if (/revert/i.test(text)) return null; // the contract's answer, not the endpoint's
  if (RANGE_RE.test(text) && !RATE_LIMIT_RE.test(text.replace(/-32005/g, ''))) return 'range';
  if (code === -32005 || RATE_LIMIT_RE.test(text)) return 'rate';
  if (code === 4444 || PRUNED_RE.test(text)) return 'pruned';
  if (code === -32601 || code === -32701 || code === 35 || RESTRICTED_RE.test(text)) {
    return 'restricted';
  }
  return null;
}

/** True when the endpoint refused a log query for being too large, not for rate limits. */
export function isRangeTooLarge(err: unknown): boolean {
  return classifyRpcLimit(err) === 'range';
}

/** True when the endpoint said it does not keep the blocks asked for. */
export function isPrunedHistory(err: unknown): boolean {
  return classifyRpcLimit(err) === 'pruned';
}

/** True when the endpoint is throttling us (JSON-RPC reply or HTTP 429). */
export function isRateLimited(err: unknown): boolean {
  const status = (err as { response?: { statusCode?: unknown } } | null)?.response?.statusCode;
  return status === 429 || classifyRpcLimit(err) === 'rate';
}

/** "10,000" or "2K" as a number. */
function toCount(digits: string, suffix?: string): number {
  const n = Number(digits.replace(/,/g, ''));
  return /k/i.test(suffix ?? '') ? n * 1000 : n;
}

/**
 * The largest block range the endpoint said it accepts, when it said one, e.g.
 * "maximum allowed is 50 blocks" (nodies), "limited to a 10,000 range" (QuickNode),
 * "up to a 2K block range" or "this block range should work: [0x10, 0x4f]" (Alchemy),
 * "exceed maximum block range: 1000" (Ankr). Null when it only said "too large".
 */
export function parseRangeLimit(err: unknown): number | null {
  const text = rpcErrorText(err);
  const suggested = /should work:\s*\[\s*(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\s*\]/i.exec(text);
  if (suggested) {
    const span = Number(BigInt(suggested[2]) - BigInt(suggested[1])) + 1;
    if (span > 0) return span;
  }
  const patterns = [
    /maximum (?:allowed )?(?:block )?(?:range )?(?:is |of )?([\d,]+)(k?)\s*blocks?/i,
    /(?:limited to|up to|max(?:imum)?(?: of)?)\s*(?:a\s*)?([\d,]+)(k?)\s*(?:-\s*)?(?:block|range)/i,
    /(?:max(?:imum)? )?block range(?: limit)?(?: is| of)?:?\s*([\d,]+)(k?)\b/i,
    /range (?:should|must) (?:not )?(?:exceed|be (?:less than|at most))\s*([\d,]+)(k?)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const n = toCount(m[1], m[2]);
      if (Number.isFinite(n) && n >= 1) return n;
    }
  }
  return null;
}
