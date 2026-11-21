/**
 * Progress of the "Find tokens" log scan, per wallet and network (scan-state.json, owner
 * only). Remembering the last scanned block makes the next scan cover only new blocks;
 * remembering what was found keeps earlier finds listed without scanning again.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { NetworkName } from '../core/network/NetworkConfig.js';
import { DATA_DIR, ensureDataDir } from './paths.js';
import { writeSecureFile } from './secureFs.js';

const EntrySchema = z.object({
  /** Last block included in a completed chunk. */
  lastBlock: z.number().int().nonnegative(),
  /** Token contracts seen sending to the wallet (checksummed). */
  contracts: z.array(z.string()).max(10_000),
  updatedAt: z.string(),
});
const FileSchema = z.object({ entries: z.record(z.string(), EntrySchema) });

export type ScanState = z.infer<typeof EntrySchema>;

const FILE = join(DATA_DIR, 'scan-state.json');

function key(address: string, network: NetworkName): string {
  return `${network}:${address.toLowerCase()}`;
}

function load(): z.infer<typeof FileSchema> {
  if (!existsSync(FILE)) return { entries: {} };
  try {
    return FileSchema.parse(JSON.parse(readFileSync(FILE, 'utf-8')));
  } catch {
    return { entries: {} }; // a damaged file only costs a full rescan
  }
}

/** The saved scan progress for this wallet on `network`, or null. */
export function getScanState(address: string, network: NetworkName): ScanState | null {
  return load().entries[key(address, network)] ?? null;
}

/** Save scan progress (replaces the entry). */
export function saveScanState(
  address: string,
  network: NetworkName,
  state: { lastBlock: number; contracts: string[] },
): void {
  ensureDataDir();
  const data = load();
  data.entries[key(address, network)] = { ...state, updatedAt: new Date().toISOString() };
  writeSecureFile(FILE, JSON.stringify(data, null, 2));
}

/** Forget the progress, so the next scan starts from the beginning. */
export function clearScanState(address: string, network: NetworkName): void {
  const data = load();
  if (!data.entries[key(address, network)]) return;
  delete data.entries[key(address, network)];
  writeSecureFile(FILE, JSON.stringify(data, null, 2));
}
