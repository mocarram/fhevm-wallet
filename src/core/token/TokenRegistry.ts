/**
 * Token registry for tracking user's tokens
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { NetworkName } from '../network/NetworkConfig.js';
import { getTokenInfo, TokenInfo } from './TokenService.js';

const TokenEntrySchema = z.object({
  address: z.string(),
  name: z.string(),
  symbol: z.string(),
  decimals: z.number(),
  network: z.enum(['mainnet', 'sepolia']),
  addedAt: z.string(),
});

const TokenRegistrySchema = z.object({
  tokens: z.array(TokenEntrySchema),
});

export type TokenEntry = z.infer<typeof TokenEntrySchema>;
type TokenRegistry = z.infer<typeof TokenRegistrySchema>;

const DATA_DIR = join(process.cwd(), 'data');
const TOKENS_FILE = join(DATA_DIR, 'tokens.json');

/**
 * Ensure data directory exists
 */
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Load token registry from file
 */
function loadRegistry(): TokenRegistry {
  ensureDataDir();

  if (!existsSync(TOKENS_FILE)) {
    return { tokens: [] };
  }

  try {
    const data = readFileSync(TOKENS_FILE, 'utf-8');
    return TokenRegistrySchema.parse(JSON.parse(data));
  } catch {
    return { tokens: [] };
  }
}

/**
 * Save token registry to file
 */
function saveRegistry(registry: TokenRegistry): void {
  ensureDataDir();
  writeFileSync(TOKENS_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Add a token to the registry
 */
export async function addToken(
  tokenAddress: string,
  network: NetworkName,
): Promise<TokenEntry> {
  const registry = loadRegistry();

  // Check if already exists
  const existing = registry.tokens.find(
    t => t.address.toLowerCase() === tokenAddress.toLowerCase() && t.network === network,
  );

  if (existing) {
    throw new Error(`Token ${tokenAddress} already exists on ${network}`);
  }

  // Fetch token info from chain
  const info = await getTokenInfo(tokenAddress, network);

  const entry: TokenEntry = {
    address: tokenAddress,
    name: info.name,
    symbol: info.symbol,
    decimals: info.decimals,
    network,
    addedAt: new Date().toISOString(),
  };

  registry.tokens.push(entry);
  saveRegistry(registry);

  return entry;
}

/**
 * Remove a token from the registry
 */
export function removeToken(tokenAddress: string, network: NetworkName): boolean {
  const registry = loadRegistry();

  const index = registry.tokens.findIndex(
    t => t.address.toLowerCase() === tokenAddress.toLowerCase() && t.network === network,
  );

  if (index === -1) {
    return false;
  }

  registry.tokens.splice(index, 1);
  saveRegistry(registry);

  return true;
}

/**
 * List all tokens for a network
 */
export function listTokens(network?: NetworkName): TokenEntry[] {
  const registry = loadRegistry();

  if (network) {
    return registry.tokens.filter(t => t.network === network);
  }

  return registry.tokens;
}

/**
 * Get a specific token entry
 */
export function getToken(tokenAddress: string, network: NetworkName): TokenEntry | null {
  const registry = loadRegistry();

  return registry.tokens.find(
    t => t.address.toLowerCase() === tokenAddress.toLowerCase() && t.network === network,
  ) ?? null;
}

/**
 * Check if a token is registered
 */
export function isTokenRegistered(tokenAddress: string, network: NetworkName): boolean {
  return getToken(tokenAddress, network) !== null;
}
