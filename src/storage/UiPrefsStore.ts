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
import { z } from 'zod';
import { DATA_DIR, ensureDataDir } from './paths.js';
import { writeSecureFile } from './secureFs.js';

/** Choices offered for "Stay unlocked for" (minutes; 0 = lock after every action). */
export const UNLOCK_MINUTES_CHOICES = [0, 5, 15, 60] as const;
/** Choices offered for "Send countdown" (seconds; 0 = off, except on mainnet). */
export const COUNTDOWN_CHOICES = [0, 3, 5, 10] as const;

const LastSendSchema = z.object({
  token: z.string(),
  to: z.string(),
  amount: z.string(),
});

const NetworkPrefsSchema = z.object({
  lastToken: z.string().optional(),
  lastRecipient: z.string().optional(),
  lastSend: LastSendSchema.optional(),
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
