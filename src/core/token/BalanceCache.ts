/**
 * Persistent cache for decrypted token balances
 * Uses encrypted handle comparison to detect stale cache entries
 */

import { existsSync, readFileSync } from 'fs';
import { writeSecureFile } from '../../storage/secureFs.js';
import { join } from 'path';
import { DATA_DIR, ensureDataDir } from '../../storage/paths.js';

interface CachedBalance {
  handle: string;
  value: string;
  /** When the value was decrypted (ISO time). Missing in caches written before Phase 3. */
  updatedAt?: string;
}

/** A cached balance read without checking the on-chain handle, for "cached 2m ago" displays. */
export interface PeekedBalance {
  value: bigint;
  /** When it was decrypted; undefined for entries written by older versions. */
  updatedAt?: Date;
}

interface CacheData {
  [key: string]: CachedBalance;
}

const CACHE_FILE = join(DATA_DIR, 'balance-cache.json');

function loadCache(): CacheData {
  ensureDataDir();

  if (!existsSync(CACHE_FILE)) {
    return {};
  }

  try {
    const data = readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveCache(cache: CacheData): void {
  ensureDataDir();
  writeSecureFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function getCacheKey(walletAddress: string, tokenAddress: string, network: string): string {
  return `${walletAddress.toLowerCase()}:${tokenAddress.toLowerCase()}:${network}`;
}

/**
 * Get cached balance if the handle matches (balance unchanged)
 * Returns null if no cache or handle changed (needs re-decryption)
 */
export function getCachedBalance(
  walletAddress: string,
  tokenAddress: string,
  network: string,
  currentHandle: bigint,
): bigint | null {
  const cache = loadCache();
  const key = getCacheKey(walletAddress, tokenAddress, network);
  const cached = cache[key];

  if (!cached) {
    return null;
  }

  // Handle changed = balance changed, cache is stale
  if (cached.handle !== currentHandle.toString()) {
    return null;
  }

  return toBigIntOrNull(cached.value);
}

/** A cached decimal string as bigint, or null when the file holds something else. */
function toBigIntOrNull(value: unknown): bigint | null {
  return typeof value === 'string' && /^\d{1,30}$/.test(value) ? BigInt(value) : null;
}

/**
 * Read the last decrypted balance without an RPC call or handle check. The value may be
 * stale: callers must label it as cached (with its age) and never use it to decide a send.
 */
export function peekCachedBalance(
  walletAddress: string,
  tokenAddress: string,
  network: string,
): PeekedBalance | null {
  const cached = loadCache()[getCacheKey(walletAddress, tokenAddress, network)];
  if (!cached) return null;
  try {
    const updatedAt = cached.updatedAt ? new Date(cached.updatedAt) : undefined;
    return {
      value: BigInt(cached.value),
      updatedAt: updatedAt && !isNaN(updatedAt.getTime()) ? updatedAt : undefined,
    };
  } catch {
    return null; // a hand-edited or corrupt entry is treated as "no cache"
  }
}

/** Store a decrypted balance together with the encrypted handle it came from. */
export function setCachedBalance(
  walletAddress: string,
  tokenAddress: string,
  network: string,
  handle: bigint,
  value: bigint,
): void {
  const cache = loadCache();
  const key = getCacheKey(walletAddress, tokenAddress, network);
  cache[key] = {
    handle: handle.toString(),
    value: value.toString(),
    updatedAt: new Date().toISOString(),
  };
  saveCache(cache);
}

/** Drop one cached balance (its handle changed, e.g. after a send). */
export function invalidateBalance(
  walletAddress: string,
  tokenAddress: string,
  network: string,
): void {
  const cache = loadCache();
  const key = getCacheKey(walletAddress, tokenAddress, network);
  delete cache[key];
  saveCache(cache);
}

/** Drop every cached balance. */
export function clearBalanceCache(): void {
  saveCache({});
}
