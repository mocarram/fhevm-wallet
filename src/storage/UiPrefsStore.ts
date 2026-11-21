/**
 * Preferences and sticky defaults for the interactive TUI, stored in `ui-prefs.json` in
 * the data directory (owner-only, atomic writes via secureFs).
 *
 * Sticky defaults are per network: the last token and recipient used, and the last send
 * (for "repeat last send"). The last amount is stored here like it is in the local
 * transaction history; it is never written to the audit log.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isAddress } from 'ethers';
import { z } from 'zod';
import { MAX_EUINT64 } from '../core/token/limits.js';
import { DATA_DIR, ensureDataDir } from './paths.js';
import { writeSecureFile } from './secureFs.js';

/** Choices offered for "Stay unlocked for" (minutes; 0 = lock after every action). */
export const UNLOCK_MINUTES_CHOICES = [0, 5, 15, 60] as const;
/** Choices offered for "Send countdown" (seconds; 0 = off, except on mainnet). */
export const COUNTDOWN_CHOICES = [0, 3, 5, 10] as const;

/** An Ethereum address (any letter case that ethers accepts). */
const AddressSchema = z.string().refine((v) => isAddress(v), 'not an address');

/**
 * Base units as a decimal string, 1 to 2^64 - 1. The file is user-editable, so a value
 * like "1.5" must be dropped here rather than crash `BigInt()` in the UI later.
 */
const BaseUnitsSchema = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  // zod runs this even when the regex failed, so never hand BigInt() a non-integer.
  .refine((v) => /^\d+$/.test(v) && BigInt(v) <= MAX_EUINT64, 'above the 64-bit limit');

const LastSendSchema = z.object({
  token: AddressSchema,
  to: AddressSchema,
  amount: BaseUnitsSchema,
});

// Each sticky default is dropped on its own when malformed (`catch`), so one bad entry
// never resets the rest of the preferences.
const NetworkPrefsSchema = z.object({
  lastToken: AddressSchema.optional().catch(undefined),
  lastRecipient: AddressSchema.optional().catch(undefined),
  lastSend: LastSendSchema.optional().catch(undefined),
  /**
   * Expiries of operator grants made from this computer, "token:holder:operator"
   * (lowercase) → Unix seconds. ERC-7984 has no getter for the expiry, so this is how
   * the operator lists can say "until …" for grants they know about.
   */
  operatorUntil: z.record(z.string(), z.number().int().min(0)).optional().catch(undefined),
});

const UiPrefsSchema = z.object({
  unlockMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(15),
  countdownSeconds: z.number().int().min(0).max(60).default(5),
  networks: z
    .object({
      sepolia: NetworkPrefsSchema.default({}),
      mainnet: NetworkPrefsSchema.default({}),
    })
    .default({ sepolia: {}, mainnet: {} }),
});

export type UiPrefs = z.infer<typeof UiPrefsSchema>;
export type NetworkPrefs = z.infer<typeof NetworkPrefsSchema>;
export type LastSend = z.infer<typeof LastSendSchema>;

const PREFS_FILE = join(DATA_DIR, 'ui-prefs.json');

/** Defaults used when nothing is saved yet (or the file is unreadable). */
export function defaultUiPrefs(): UiPrefs {
  return UiPrefsSchema.parse({});
}

/** Load preferences; a missing or corrupt file gives the defaults. */
export function loadUiPrefs(): UiPrefs {
  ensureDataDir();
  if (!existsSync(PREFS_FILE)) return defaultUiPrefs();
  try {
    return UiPrefsSchema.parse(JSON.parse(readFileSync(PREFS_FILE, 'utf-8')));
  } catch {
    return defaultUiPrefs();
  }
}

/** Save preferences (owner-only). */
export function saveUiPrefs(prefs: UiPrefs): void {
  ensureDataDir();
  writeSecureFile(PREFS_FILE, JSON.stringify(UiPrefsSchema.parse(prefs), null, 2));
}

const operatorKey = (token: string, holder: string, operator: string) =>
  `${token}:${holder}:${operator}`.toLowerCase();

/** Remember the expiry of a grant made here (0 = revoked: forgotten). */
export function rememberOperatorUntil(
  network: 'sepolia' | 'mainnet',
  token: string,
  holder: string,
  operator: string,
  until: number,
): void {
  const prefs = loadUiPrefs();
  const map = { ...(prefs.networks[network].operatorUntil ?? {}) };
  const key = operatorKey(token, holder, operator);
  if (until > 0) map[key] = until;
  else delete map[key];
  prefs.networks[network].operatorUntil = map;
  saveUiPrefs(prefs);
}

/** The expiry of a grant made here, or undefined when not known. */
export function knownOperatorUntil(
  network: 'sepolia' | 'mainnet',
  token: string,
  holder: string,
  operator: string,
): number | undefined {
  return loadUiPrefs().networks[network].operatorUntil?.[operatorKey(token, holder, operator)];
}
