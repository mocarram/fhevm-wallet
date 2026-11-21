/**
 * Decrypted transfer amounts, keyed by the amount's ciphertext handle.
 *
 * A handle never changes its value, so once a transfer amount is decrypted it can be
 * shown again without a relayer round trip or a signature. This is plaintext of
 * confidential data: the file is written owner-only (secureFs), lives in the data
 * directory, and amounts are never copied to the audit log.
 *
 * `disclosed` marks an amount this wallet published on-chain with
 * `discloseEncryptedAmount`, so the UI can say "public" instead of offering it again.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { DATA_DIR, ensureDataDir } from './paths.js';
import { writeSecureFile } from './secureFs.js';

const EntrySchema = z.object({
  /** Base units, as a decimal string. */
  value: z.string().regex(/^\d{1,20}$/),
  at: z.string(),
  disclosed: z.boolean().optional(),
  /** Hash of a disclosure (step 2) that was sent but not seen confirmed. */
  discloseTx: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
});
const FileSchema = z.record(z.string(), EntrySchema);

export type AmountEntry = z.infer<typeof EntrySchema>;

const FILE = join(DATA_DIR, 'amount-cache.json');

function key(network: string, handle: string): string {
  return `${network}:${handle.toLowerCase()}`;
}

function load(): Record<string, AmountEntry> {
  ensureDataDir();
  if (!existsSync(FILE)) return {};
  try {
    return FileSchema.parse(JSON.parse(readFileSync(FILE, 'utf-8')));
  } catch {
    // A damaged cache only costs a re-decrypt.
    return {};
  }
}

function save(data: Record<string, AmountEntry>): void {
  ensureDataDir();
  writeSecureFile(FILE, JSON.stringify(data, null, 2));
}

/** The decrypted amount (base units) for a handle, or null when not cached. */
export function getCachedAmount(network: string, handle: string): bigint | null {
  const e = load()[key(network, handle)];
  return e ? BigInt(e.value) : null;
}

/** Full cache entry for a handle (value, when, disclosed), or null. */
export function getAmountEntry(network: string, handle: string): AmountEntry | null {
  return load()[key(network, handle)] ?? null;
}

/** Save decrypted amounts in one write. */
export function setCachedAmounts(
  network: string,
  amounts: Array<{
    handle: string;
    value: bigint;
    disclosed?: boolean;
    discloseTx?: string | null;
  }>,
): void {
  if (!amounts.length) return;
  const data = load();
  const at = new Date().toISOString();
  for (const a of amounts) {
    const prev = data[key(network, a.handle)];
    const disclosed = a.disclosed || prev?.disclosed;
    // Once disclosed the pending hash is moot; null clears it explicitly.
    const discloseTx = disclosed
      ? undefined
      : a.discloseTx === null
        ? undefined
        : (a.discloseTx ?? prev?.discloseTx);
    data[key(network, a.handle)] = {
      value: a.value.toString(),
      at,
      ...(disclosed ? { disclosed: true } : {}),
      ...(discloseTx ? { discloseTx } : {}),
    };
  }
  save(data);
}

/** Forget every cached amount (tests). */
export function clearAmountCache(): void {
  save({});
}
