/**
 * What the wallet learnt about tracked tokens' wrapper interface (wrappers.json,
 * owner-only): for an ERC-20 wrapper its rate and the underlying ERC-20's address, name,
 * symbol and decimals (sanitised when read from the contract); for any other token that
 * it is not one. Saves a round of contract reads every time Balances or Wrap opens.
 *
 * Contracts can be upgraded (the Sepolia mocks are proxies), so entries are re-checked
 * after `MAX_AGE_MS`, and the flows re-read the wrapper before signing anything.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { NetworkName } from '../core/network/NetworkConfig.js';
import type { WrapperInfo } from '../core/token/wrapper.js';
import { DATA_DIR, ensureDataDir } from './paths.js';
import { writeSecureFile } from './secureFs.js';

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const InfoSchema = z.object({
  address: ADDRESS,
  name: z.string().max(80),
  symbol: z.string().max(32),
  decimals: z.number().int().min(0).max(36),
  rate: z.string().regex(/^[1-9]\d{0,77}$/),
  underlying: z.object({
    address: ADDRESS,
    name: z.string().max(80),
    symbol: z.string().max(32),
    decimals: z.number().int().min(0).max(77),
  }),
  hasRequester: z.boolean(),
});
const EntrySchema = z.object({
  checkedAt: z.string(),
  /** null: checked, not a wrapper. */
  info: InfoSchema.nullable(),
});
const FileSchema = z.record(z.string(), EntrySchema);

/** How long a check is trusted before it is read from the chain again. */
export const MAX_AGE_MS = 7 * 24 * 3600_000;

const FILE = join(DATA_DIR, 'wrappers.json');

function key(network: NetworkName, address: string): string {
  return `${network}:${address.toLowerCase()}`;
}

function load(): z.infer<typeof FileSchema> {
  if (!existsSync(FILE)) return {};
  try {
    return FileSchema.parse(JSON.parse(readFileSync(FILE, 'utf-8')));
  } catch {
    return {}; // a damaged cache only costs a few contract reads
  }
}

function toInfo(i: z.infer<typeof InfoSchema>): WrapperInfo {
  return { ...i, rate: BigInt(i.rate), underlying: { ...i.underlying } };
}

/**
 * The cached check for a token: `undefined` when unknown or stale, `null` when it is no
 * wrapper, else its info.
 */
export function getCachedWrapper(
  network: NetworkName,
  address: string,
  now = Date.now(),
): WrapperInfo | null | undefined {
  const e = load()[key(network, address)];
  if (!e || now - Date.parse(e.checkedAt) > MAX_AGE_MS) return undefined;
  return e.info ? toInfo(e.info) : null;
}

/** Every fresh cached wrapper on `network`, by lowercase token address. */
export function cachedWrappers(
  network: NetworkName,
  now = Date.now(),
): Record<string, WrapperInfo> {
  const out: Record<string, WrapperInfo> = {};
  for (const [k, e] of Object.entries(load())) {
    if (!k.startsWith(`${network}:`) || !e.info) continue;
    if (now - Date.parse(e.checkedAt) > MAX_AGE_MS) continue;
    out[k.slice(network.length + 1)] = toInfo(e.info);
  }
  return out;
}

/** Remember the result of a wrapper check (`null`: not a wrapper). */
export function setCachedWrapper(
  network: NetworkName,
  address: string,
  info: WrapperInfo | null,
): void {
  ensureDataDir();
  const data = load();
  data[key(network, address)] = {
    checkedAt: new Date().toISOString(),
    info: info ? InfoSchema.parse({ ...info, rate: info.rate.toString() }) : null,
  };
  writeSecureFile(FILE, JSON.stringify(data, null, 2));
}
