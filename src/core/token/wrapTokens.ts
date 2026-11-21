/**
 * Which tracked tokens are ERC-20 wrappers, and which one a typed name means. Shared by
 * `fhew wrap|unwrap` and the TUI's Wrap screen and `:wrap` command.
 */

import type { WrapBackend } from '../backend/wrapTypes.js';
import type { NetworkName } from '../network/NetworkConfig.js';
import { getCachedWrapper, setCachedWrapper } from '../../storage/WrapperCache.js';
import { resolveToken, type TokenLike } from '../send/resolve.js';
import type { WrapperInfo } from './wrapper.js';

/** Wrapper info by lowercase token address: null = not a wrapper, absent = unknown. */
export type WrapperMap = Record<string, WrapperInfo | null>;

/**
 * Wrapper info for `tokens`, from the cache when fresh, else from the chain (and then
 * cached). A token whose check failed (network) is left out, so it shows as unknown
 * rather than "not a wrapper". `refresh` re-reads every token.
 */
export async function loadWrappers(
  backend: Pick<WrapBackend, 'wrapperInfo'>,
  network: NetworkName,
  tokens: Array<{ address: string }>,
  opts: { refresh?: boolean } = {},
): Promise<WrapperMap> {
  const out: WrapperMap = {};
  // One token at a time: each check is several reads, and parallel checks would make
  // JSON-RPC batches larger than some public RPCs accept.
  for (const t of tokens) {
    await (async () => {
      const key = t.address.toLowerCase();
      const cached = opts.refresh ? undefined : safeCached(network, t.address);
      if (cached !== undefined) {
        out[key] = cached;
        return;
      }
      try {
        const info = await backend.wrapperInfo(t.address, network);
        out[key] = info;
        try {
          setCachedWrapper(network, t.address, info);
        } catch {
          // the cache only saves reads
        }
      } catch {
        // unknown for now; the caller may say "could not check"
      }
    })();
  }
  return out;
}

function safeCached(network: NetworkName, address: string): WrapperInfo | null | undefined {
  try {
    return getCachedWrapper(network, address);
  } catch {
    return undefined;
  }
}

/**
 * The wrapper token meant by `text`: a tracked token by symbol or address, or a tracked
 * wrapper by its ERC-20's symbol (`zama` → cZAMA) when that is unique. Without text, the
 * only tracked wrapper.
 */
export function resolveWrapToken<T extends TokenLike>(
  text: string | undefined,
  tokens: T[],
  wrappers: WrapperMap,
): { ok: true; token: T } | { ok: false; error: string; code: string } {
  const isWrapper = (t: T) => Boolean(wrappers[t.address.toLowerCase()]);
  const candidates = tokens.filter(isWrapper);
  if (!text?.trim()) {
    if (candidates.length === 1) return { ok: true, token: candidates[0] };
    if (candidates.length === 0) {
      return {
        ok: false,
        code: 'NOT_A_WRAPPER',
        error:
          'None of your tracked tokens is an ERC-20 wrapper. Add one (for example cZAMA) with `fhew token add <address>`.',
      };
    }
    return {
      ok: false,
      code: 'TOKEN_AMBIGUOUS',
      error: `Several tracked tokens are wrappers. Name one: ${candidates.map((t) => t.symbol).join(', ')}.`,
    };
  }
  const direct = resolveToken(text, tokens);
  if (direct.ok) {
    const info = wrappers[direct.token.address.toLowerCase()];
    if (info === null) {
      return {
        ok: false,
        code: 'NOT_A_WRAPPER',
        error: `${direct.token.symbol} is not an ERC-20 wrapper (it has no underlying token), so it cannot be wrapped or unwrapped.`,
      };
    }
    return direct;
  }
  const wanted = text.trim().toLowerCase();
  const byUnderlying = candidates.filter(
    (t) => wrappers[t.address.toLowerCase()]!.underlying.symbol.toLowerCase() === wanted,
  );
  if (byUnderlying.length === 1) return { ok: true, token: byUnderlying[0] };
  return { ok: false, code: 'TOKEN_NOT_TRACKED', error: direct.error };
}
