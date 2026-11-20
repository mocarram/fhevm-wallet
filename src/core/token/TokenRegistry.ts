/**
 * Token registry for tracking user's tokens
 */

import { existsSync, readFileSync } from 'fs';
import { writeSecureFile } from '../../storage/secureFs.js';
import { join } from 'path';
import { z } from 'zod';
import { NetworkName } from '../network/NetworkConfig.js';
import { getTokenInfo, type TokenInfo } from './TokenService.js';
import { sanitizeTokenName, sanitizeTokenSymbol } from './tokenText.js';
import { logEvent } from '../../storage/AuditLog.js';
import { DATA_DIR, ensureDataDir } from '../../storage/paths.js';

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

const TOKENS_FILE = join(DATA_DIR, 'tokens.json');

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
    const registry = TokenRegistrySchema.parse(JSON.parse(data));
    // Entries saved by older versions were stored unsanitized; clean them on the way out.
    registry.tokens = registry.tokens.map((t) => ({
      ...t,
      name: sanitizeTokenName(t.name),
      symbol: sanitizeTokenSymbol(t.symbol),
    }));
    return registry;
  } catch {
    return { tokens: [] };
  }
}

/**
 * Save token registry to file
 */
function saveRegistry(registry: TokenRegistry): void {
  ensureDataDir();
  writeSecureFile(TOKENS_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Add a token to the registry, fetching its name, symbol and decimals from the chain.
 */
export async function addToken(tokenAddress: string, network: NetworkName): Promise<TokenEntry> {
  if (isTokenRegistered(tokenAddress, network)) {
    throw new Error(`Token ${tokenAddress} already exists on ${network}`);
  }
  const info = await getTokenInfo(tokenAddress, network);
  return addTokenWithInfo(info, network);
}

/**
 * Add a token whose details are already known (fetched through a `Backend`, which may be
 * the offline mock). Name and symbol are sanitised again here: they come from a contract.
 */
export function addTokenWithInfo(info: TokenInfo, network: NetworkName): TokenEntry {
  if (!Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 255) {
    throw new Error('The token reported an invalid number of decimals.');
  }
  const registry = loadRegistry();

  const existing = registry.tokens.find(
    (t) => t.address.toLowerCase() === info.address.toLowerCase() && t.network === network,
  );
  if (existing) {
    throw new Error(`Token ${info.address} already exists on ${network}`);
  }

  const entry: TokenEntry = {
    address: info.address,
    name: sanitizeTokenName(info.name),
    symbol: sanitizeTokenSymbol(info.symbol),
    decimals: info.decimals,
    network,
    addedAt: new Date().toISOString(),
  };

  registry.tokens.push(entry);
  saveRegistry(registry);

  logEvent('TOKEN_ADDED', { address: entry.address, symbol: entry.symbol, network });

  return entry;
}

/**
 * Remove a token from the registry
 */
export function removeToken(tokenAddress: string, network: NetworkName): boolean {
  const registry = loadRegistry();

  const index = registry.tokens.findIndex(
    (t) => t.address.toLowerCase() === tokenAddress.toLowerCase() && t.network === network,
  );

  if (index === -1) {
    return false;
  }

  registry.tokens.splice(index, 1);
  saveRegistry(registry);

  logEvent('TOKEN_REMOVED', { address: tokenAddress, network });

  return true;
}

/**
 * List all tokens for a network
 */
export function listTokens(network?: NetworkName): TokenEntry[] {
  const registry = loadRegistry();

  if (network) {
    return registry.tokens.filter((t) => t.network === network);
  }

  return registry.tokens;
}

/**
 * Get a specific token entry
 */
export function getToken(tokenAddress: string, network: NetworkName): TokenEntry | null {
  const registry = loadRegistry();

  return (
    registry.tokens.find(
      (t) => t.address.toLowerCase() === tokenAddress.toLowerCase() && t.network === network,
    ) ?? null
  );
}

/**
 * Check if a token is registered
 */
export function isTokenRegistered(tokenAddress: string, network: NetworkName): boolean {
  return getToken(tokenAddress, network) !== null;
}
