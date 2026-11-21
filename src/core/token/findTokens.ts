/**
 * "Find tokens": one list of candidate tokens for a wallet, from two sources, used by
 * `fhew token find` and the TUI's Find tokens screen.
 *
 * 1. Known lists (shipped + the user's configured list): curated, so a candidate that
 *    passes the ERC-7984 check is "verified" and offered pre-selected.
 * 2. The wallet's own history: token contracts that sent it a ConfidentialTransfer.
 *    Anyone can send a transfer from any contract (spam, look-alike names), so these
 *    are "unverified" even when the check passes, and never pre-selected.
 *
 * Every candidate gets the ERC-7984 check; names and symbols come from the contract
 * (sanitised) when it answers. Scan progress is saved, so the next scan covers only new
 * blocks and earlier finds stay listed.
 */

import type { Backend } from '../backend/types.js';
import type { NetworkName } from '../network/NetworkConfig.js';
import { getScanState, saveScanState } from '../../storage/ScanStateStore.js';
import { listTokens } from './TokenRegistry.js';
import type { TokenCheck } from './erc7984Check.js';
import type { ScanProgress } from './tokenScan.js';
import { WalletTxError, translateTxError } from './txErrors.js';

/** Where a candidate was seen. */
export type CandidateSource = 'known' | 'history';

/**
 * - verified: on a known list and passes the ERC-7984 check
 * - unverified: only found in the history; passes the check, but nobody vouched for it
 * - not-erc7984: fails the check (can only be added with --force / after a warning)
 * - unchecked: the check could not run (network)
 * - tracked: already in the token list
 */
export type CandidateStatus = 'verified' | 'unverified' | 'not-erc7984' | 'unchecked' | 'tracked';

/** One row of the Find tokens list. */
export interface TokenCandidate {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  sources: CandidateSource[];
  status: CandidateStatus;
  /** Why it failed the check, or why it could not be checked. */
  problems: string[];
  warnings: string[];
  check: TokenCheck | null;
}

/** Everything a Find tokens run produced. */
export interface FindResult {
  candidates: TokenCandidate[];
  scan: {
    fromBlock: number;
    toBlock: number;
    scannedTo: number;
    cancelled: boolean;
    /** Plain-English reason the scan stopped early; what was found is still listed. */
    error?: { code: string; message: string };
    /** True when no new blocks were scanned (everything up to `toBlock` was done before). */
    upToDate: boolean;
  } | null;
  /** Why the configured token list could not be refreshed. */
  listError?: string;
}

/** Options for `findTokens`. */
export interface FindOptions {
  /** Skip the history scan (known lists only). */
  noScan?: boolean;
  /** Scan from this block instead of the saved progress. */
  fromBlock?: number;
  /** Refresh the configured token list now. */
  refreshList?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
  /** Called once the scan is over, before candidates are checked. */
  onChecking?: (count: number) => void;
}

/** Order: verified first, then unverified, unchecked, not ERC-7984, tracked; by symbol. */
const ORDER: CandidateStatus[] = ['verified', 'unverified', 'unchecked', 'not-erc7984', 'tracked'];

/** Run both sources and check every candidate. Throws only if nothing could be done. */
export async function findTokens(
  backend: Backend,
  wallet: string,
  network: NetworkName,
  opts: FindOptions = {},
): Promise<FindResult> {
  const known = await backend.knownTokens(network, { refresh: opts.refreshList });
  const sources = new Map<string, Set<CandidateSource>>();
  const names = new Map<string, { name: string; symbol: string; decimals: number }>();
  const add = (address: string, source: CandidateSource) => {
    const set = sources.get(address) ?? new Set<CandidateSource>();
    set.add(source);
    sources.set(address, set);
  };
  for (const t of known.tokens) {
    add(t.address, 'known');
    names.set(t.address, t);
  }

  let scan: FindResult['scan'] = null;
  if (!opts.noScan) {
    const saved = getScanState(wallet, network);
    const resume = opts.fromBlock === undefined && saved !== null;
    const fromBlock =
      opts.fromBlock ?? (saved ? saved.lastBlock + 1 : backend.scanStartBlock(network));
    const r = await backend.scanReceivedTokens(wallet, network, {
      fromBlock,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    const contracts = new Set([...(resume && saved ? saved.contracts : []), ...r.contracts]);
    for (const c of contracts) add(c, 'history');
    // Save what was completed, even when cancelled or stopped by an error. A scan from a
    // user-chosen block only moves the saved progress forward, never back.
    const lastBlock = Math.max(r.scannedTo, saved?.lastBlock ?? -1);
    if (lastBlock >= 0) {
      saveScanState(wallet, network, {
        lastBlock,
        contracts: [...new Set([...(saved?.contracts ?? []), ...contracts])],
      });
    }
    let error: { code: string; message: string } | undefined;
    if (r.error) {
      const e = r.error instanceof WalletTxError ? r.error : translateTxError(r.error);
      error = { code: e.code, message: e.message };
    }
    scan = {
      fromBlock: r.fromBlock,
      toBlock: r.toBlock,
      scannedTo: r.scannedTo,
      cancelled: r.cancelled,
      error,
      upToDate: r.fromBlock > r.toBlock,
    };
  }

  opts.onChecking?.(sources.size);
  const tracked = new Set(listTokens(network).map((t) => t.address.toLowerCase()));
  const candidates = await Promise.all(
    [...sources].map(async ([address, src]): Promise<TokenCandidate> => {
      const listed = names.get(address);
      const base = {
        address,
        name: listed?.name ?? 'Unknown token',
        symbol: listed?.symbol ?? '???',
        decimals: listed?.decimals ?? 0,
        sources: (['known', 'history'] as const).filter((s) => src.has(s)),
      };
      if (tracked.has(address.toLowerCase())) {
        return { ...base, status: 'tracked', problems: [], warnings: [], check: null };
      }
      let check: TokenCheck;
      try {
        check = await backend.checkToken(address, network);
      } catch (err) {
        const e = translateTxError(err, { action: 'token check' });
        return { ...base, status: 'unchecked', problems: [e.message], warnings: [], check: null };
      }
      // The contract's own (sanitised) name wins over a list's: it is what balances show.
      const shown = check.info ? { ...base, ...check.info, address } : base;
      const status: CandidateStatus = !check.compliant
        ? 'not-erc7984'
        : src.has('known')
          ? 'verified'
          : 'unverified';
      return { ...shown, status, problems: check.problems, warnings: check.warnings, check };
    }),
  );
  candidates.sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.symbol.localeCompare(b.symbol),
  );
  return { candidates, scan, listError: known.listError };
}

/** "known list", "found in your history", or both, for labels. */
export function sourceLabel(c: TokenCandidate): string {
  return c.sources.map((s) => (s === 'known' ? 'known list' : 'found in your history')).join(' · ');
}
