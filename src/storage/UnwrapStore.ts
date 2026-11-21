/**
 * Unwraps in progress (unwraps.json, owner-only). An unwrap is two transactions with a
 * wait in between (request → public decryption → finalize), and the process can end at
 * any point: closed terminal, lost connection, a crash. Each entry records what was
 * signed and sent, so `fhew unwrap --resume` and the TUI's "Finish unwrap" can carry on
 * without ever sending a step again that may already be on-chain.
 *
 * An entry is created when the request is *signed*, before it is broadcast (its hash is
 * known then). `amount` and `value` are confidential amounts of this wallet: like
 * amount-cache.json, this file is owner-only and amounts never reach the audit log.
 *
 * A damaged file is never overwritten: reads for display return nothing, and writes
 * throw, so a new unwrap refuses to start instead of losing track of an earlier one.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { NetworkName } from '../core/network/NetworkConfig.js';
import { DATA_DIR, ensureDataDir } from './paths.js';
import { writeSecureFile } from './secureFs.js';

const HASH = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const UINT = z.string().regex(/^\d{1,78}$/);

/**
 * - signed: request signed (and maybe broadcast), not seen mined yet
 * - requested: request mined, `requestId` known; waiting for decryption / finalize
 * - finalizing: finalize signed (and maybe broadcast), not seen mined yet
 * - finished: the underlying tokens were sent (by our finalize or anyone's)
 * - failed: the request reverted (nothing was burnt)
 * - unclear: the request was mined, but no unwrap request of this wallet was found in
 *   it. Tokens may be burnt; the user checks the explorer. Never pruned.
 */
export const UNWRAP_STATES = [
  'signed',
  'requested',
  'finalizing',
  'finished',
  'failed',
  'unclear',
] as const;
export type UnwrapStateName = (typeof UNWRAP_STATES)[number];

const EntrySchema = z.object({
  /** The request transaction hash: known first and unique. */
  id: HASH,
  network: z.enum(['sepolia', 'mainnet']),
  wallet: ADDRESS,
  token: ADDRESS,
  symbol: z.string().max(32),
  decimals: z.number().int().min(0).max(36),
  rate: UINT,
  underlying: z.object({
    address: ADDRESS,
    symbol: z.string().max(32),
    decimals: z.number().int().min(0).max(77),
  }),
  hasRequester: z.boolean(),
  /** Confidential base units asked for. */
  amount: UINT,
  state: z.enum(UNWRAP_STATES),
  requestTxHash: HASH,
  /**
   * The nonce the request was signed with (missing on entries from before it was
   * recorded). Once the account's mined nonce is past it and the request has no
   * receipt, the request can never be mined, so the entry may be forgotten.
   */
  requestNonce: z.number().int().nonnegative().optional(),
  requestBlock: z.number().int().nonnegative().optional(),
  requestId: HASH.optional(),
  finalizeTxHash: HASH.optional(),
  finalizeBlock: z.number().int().nonnegative().optional(),
  /** When the finalize transaction was signed (ISO): a fresh one may not be visible yet. */
  finalizeSignedAt: z.string().optional(),
  /** Confidential base units actually burnt (from the public decryption). */
  value: UINT.optional(),
  /** Who sent the finalize that finished it. */
  finishedBy: z.enum(['wallet', 'other']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const FileSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema).max(5000) });

export type UnwrapEntry = z.infer<typeof EntrySchema>;

/** The unwrap store could not be read; it is left untouched. */
export class UnwrapStoreError extends Error {
  readonly code = 'UNWRAP_STORE_DAMAGED';
}

const FILE = join(DATA_DIR, 'unwraps.json');
/** Finished and failed entries are kept this long (they show as recent), then dropped. */
const KEEP_DONE_MS = 90 * 24 * 3600_000;

function load(): UnwrapEntry[] {
  if (!existsSync(FILE)) return [];
  try {
    return FileSchema.parse(JSON.parse(readFileSync(FILE, 'utf-8'))).entries;
  } catch (err) {
    throw new UnwrapStoreError(
      `${FILE} could not be read (${err instanceof Error ? err.message.slice(0, 120) : 'invalid'}). It lists unwraps in progress, so the wallet will not overwrite it. Fix or move the file, then try again.`,
    );
  }
}

function save(entries: UnwrapEntry[]): void {
  ensureDataDir();
  const now = Date.now();
  const kept = entries.filter(
    (e) =>
      (e.state !== 'finished' && e.state !== 'failed') ||
      now - Date.parse(e.updatedAt) < KEEP_DONE_MS,
  );
  writeSecureFile(FILE, JSON.stringify({ version: 1, entries: kept }, null, 2));
}

/** True for states that still need something (a confirmation or step 2). */
export function isOpenUnwrap(e: Pick<UnwrapEntry, 'state'>): boolean {
  return e.state === 'signed' || e.state === 'requested' || e.state === 'finalizing';
}

/**
 * Unwraps of `wallet` on `network` (newest first). `open` keeps only unfinished ones.
 * Throws UnwrapStoreError when the file is damaged (see `listUnwrapsSafe`).
 */
export function listUnwraps(
  filter: {
    network?: NetworkName;
    wallet?: string;
    open?: boolean;
  } = {},
): UnwrapEntry[] {
  return load()
    .filter((e) => !filter.network || e.network === filter.network)
    .filter((e) => !filter.wallet || e.wallet.toLowerCase() === filter.wallet.toLowerCase())
    .filter((e) => !filter.open || isOpenUnwrap(e))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** `listUnwraps` for display: a damaged file shows as empty instead of throwing. */
export function listUnwrapsSafe(filter: Parameters<typeof listUnwraps>[0] = {}): UnwrapEntry[] {
  try {
    return listUnwraps(filter);
  } catch {
    return [];
  }
}

/** Throw now (before anything is signed) if a new entry could not be saved. */
export function assertUnwrapStoreWritable(): void {
  save(load());
}

/** Add a new entry (its request was just signed). */
export function addUnwrap(
  entry: Omit<UnwrapEntry, 'createdAt' | 'updatedAt' | 'state'> & { state?: UnwrapStateName },
): UnwrapEntry {
  const entries = load();
  if (entries.some((e) => e.id.toLowerCase() === entry.id.toLowerCase())) {
    throw new Error('This unwrap request is already recorded.');
  }
  const at = new Date().toISOString();
  const full: UnwrapEntry = EntrySchema.parse({
    ...entry,
    state: entry.state ?? 'signed',
    createdAt: at,
    updatedAt: at,
  });
  save([...entries, full]);
  return full;
}

/** Merge `patch` into the entry `id` and save. Returns the updated entry. */
export function updateUnwrap(
  id: string,
  patch: Partial<Omit<UnwrapEntry, 'id' | 'createdAt'>>,
): UnwrapEntry {
  const entries = load();
  const i = entries.findIndex((e) => e.id.toLowerCase() === id.toLowerCase());
  if (i < 0) throw new Error('Unknown unwrap.');
  const next = EntrySchema.parse({ ...entries[i], ...patch, updatedAt: new Date().toISOString() });
  entries[i] = next;
  save(entries);
  return next;
}

/** Remove one entry (`fhew unwrap --forget`). */
export function removeUnwrap(id: string): void {
  const entries = load();
  save(entries.filter((e) => e.id.toLowerCase() !== id.toLowerCase()));
}

/**
 * Find an entry by any of its hashes or ids (or a unique prefix of 10+ characters):
 * request tx hash, request id, finalize tx hash.
 */
export function findUnwrap(
  ref: string,
  filter: Parameters<typeof listUnwraps>[0] = {},
): UnwrapEntry[] {
  const r = ref.trim().toLowerCase();
  if (!/^0x[0-9a-f]{8,64}$/.test(r)) return [];
  return listUnwraps(filter).filter((e) =>
    [e.id, e.requestId, e.finalizeTxHash].some((h) => h?.toLowerCase().startsWith(r)),
  );
}
