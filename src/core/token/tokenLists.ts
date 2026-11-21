/**
 * Known confidential tokens per network, for "Find tokens".
 *
 * Two sources, both in the token-list JSON format (https://tokenlists.org: name,
 * timestamp, version, tokens[{chainId, address, name, symbol, decimals}]):
 *
 * - the list shipped with the wallet (src/core/token/lists/<network>.json). It only
 *   holds addresses someone verified; see docs/token-lists.md for the sources checked.
 *   Both lists are empty today: no official Zama or community registry of ERC-7984
 *   tokens with verifiable addresses was found.
 * - an optional list from a URL the user configures (`fhew config --token-list-url`),
 *   fetched over https with a timeout and a size cap, validated, and cached in the data
 *   folder (token-lists.json).
 *
 * Every entry is untrusted input: addresses are checksummed, names and symbols
 * sanitised, and an entry is never added without the ERC-7984 check.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAddress } from 'ethers';
import { z } from 'zod';
import mainnetList from './lists/mainnet.json' with { type: 'json' };
import sepoliaList from './lists/sepolia.json' with { type: 'json' };
import { NETWORK_CONFIGS, type NetworkName } from '../network/NetworkConfig.js';
import { sanitizeTokenName, sanitizeTokenSymbol } from './tokenText.js';
import { DATA_DIR, ensureDataDir } from '../../storage/paths.js';
import { writeSecureFile } from '../../storage/secureFs.js';
import { validateRpcUrl } from '../../utils/validation.js';

/** One known token, cleaned. */
export interface KnownToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  /** Which list it came from: "shipped" or the (masked) URL host. */
  list: string;
}

const TokenListSchema = z.object({
  name: z.string().optional(),
  tokens: z
    .array(
      z.object({
        chainId: z.number().int(),
        address: z.string(),
        name: z.string(),
        symbol: z.string(),
        decimals: z.number().int().min(0).max(255),
      }),
    )
    .max(5000),
});

/** Most bytes read from a token-list URL: real lists are well under 1 MB. */
export const MAX_TOKEN_LIST_BYTES = 1_000_000;
/** How long a token-list download may take. */
export const TOKEN_LIST_TIMEOUT_MS = 10_000;

/** The valid entries of a parsed list for `network`; malformed entries are skipped. */
export function tokensFromList(raw: unknown, network: NetworkName, list: string): KnownToken[] {
  const parsed = TokenListSchema.safeParse(raw);
  if (!parsed.success) throw new Error('That is not a token list (token-list JSON format).');
  const chainId = NETWORK_CONFIGS[network].chainIdNumber;
  const seen = new Set<string>();
  const out: KnownToken[] = [];
  for (const t of parsed.data.tokens) {
    if (t.chainId !== chainId) continue;
    let address: string;
    try {
      address = getAddress(t.address);
    } catch {
      continue;
    }
    if (seen.has(address)) continue;
    seen.add(address);
    out.push({
      address,
      name: sanitizeTokenName(t.name),
      symbol: sanitizeTokenSymbol(t.symbol),
      decimals: t.decimals,
      list,
    });
  }
  return out;
}

/** The list shipped with the wallet for `network`. */
export function shippedTokens(network: NetworkName): KnownToken[] {
  return tokensFromList(network === 'mainnet' ? mainnetList : sepoliaList, network, 'shipped');
}

const CACHE_FILE = join(DATA_DIR, 'token-lists.json');

const CacheSchema = z.object({
  url: z.string(),
  fetchedAt: z.string(),
  list: z.unknown(),
});

/** The cached download of the configured list, if it is for `url`. */
export function cachedList(url: string): { fetchedAt: string; list: unknown } | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const c = CacheSchema.parse(JSON.parse(readFileSync(CACHE_FILE, 'utf-8')));
    return c.url === url ? { fetchedAt: c.fetchedAt, list: c.list } : null;
  } catch {
    return null;
  }
}

/** Host of a list URL, for labels ("from tokens.example"). Never the path or query. */
export function listLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'your list';
  }
}

/** Why `url` cannot be used as a token-list URL, or null. Same rules as RPC URLs. */
export function validateTokenListUrl(url: string): string | null {
  return validateRpcUrl(url);
}

/**
 * Download the list at `url` (https, 10 s, 1 MB), check it parses, and cache it.
 * Throws with a plain sentence on failure; the cache is left as it was.
 */
export async function refreshTokenList(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const problem = validateTokenListUrl(url);
  if (problem) throw new Error(problem);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(TOKEN_LIST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new Error('The token list URL did not answer. Check it and your connection.');
  }
  if (!res.ok) throw new Error(`The token list URL answered with HTTP ${res.status}.`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_TOKEN_LIST_BYTES) throw new Error('That token list is too large (over 1 MB).');
  const text = await res.text();
  if (text.length > MAX_TOKEN_LIST_BYTES)
    throw new Error('That token list is too large (over 1 MB).');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The token list URL did not return JSON.');
  }
  // Validate before caching, so a broken download never replaces a good list.
  tokensFromList(raw, 'sepolia', 'check');
  ensureDataDir();
  writeSecureFile(
    CACHE_FILE,
    JSON.stringify({ url, fetchedAt: new Date().toISOString(), list: raw }),
  );
  return raw;
}

/** Re-download the configured list when the cached copy is older than this. */
export const TOKEN_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Shipped plus configured tokens for `network`. The configured list is refreshed when
 * `refresh` is set or the cache is older than a day; a failed refresh falls back to the
 * cache and is reported in `listError`.
 */
export async function knownTokens(
  network: NetworkName,
  opts: { url?: string; refresh?: boolean; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<{ tokens: KnownToken[]; listError?: string }> {
  const tokens = shippedTokens(network);
  if (!opts.url) return { tokens };
  let raw: unknown = null;
  let listError: string | undefined;
  const cached = cachedList(opts.url);
  const stale =
    !cached || (opts.now ?? Date.now()) - Date.parse(cached.fetchedAt) > TOKEN_LIST_MAX_AGE_MS;
  if (opts.refresh || stale) {
    try {
      raw = await refreshTokenList(opts.url, opts.fetchImpl);
    } catch (err) {
      listError = err instanceof Error ? err.message : String(err);
      raw = cached?.list ?? null;
    }
  } else {
    raw = cached.list;
  }
  if (raw !== null) {
    try {
      const extra = tokensFromList(raw, network, listLabel(opts.url));
      const have = new Set(tokens.map((t) => t.address));
      tokens.push(...extra.filter((t) => !have.has(t.address)));
    } catch (err) {
      listError = err instanceof Error ? err.message : String(err);
    }
  }
  return { tokens, listError };
}
