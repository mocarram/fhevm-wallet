/**
 * Persistent cache for decrypted token balances
 * Uses encrypted handle comparison to detect stale cache entries
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR, ensureDataDir } from '../../storage/paths.js';

interface CachedBalance {
  handle: string;
  value: string;
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
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
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

  return BigInt(cached.value);
}

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
  };
  saveCache(cache);
}

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

export function clearBalanceCache(): void {
  saveCache({});
}
