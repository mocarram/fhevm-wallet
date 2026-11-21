/**
 * Read a JSON store file from the data dir without ever losing it.
 *
 * Stores used to treat a file they could not parse (hand-edited, cut short by a full
 * disk, written by a newer version) as empty, and the next save then overwrote it: the
 * address book, token list, settings or history were gone. Now such a file is renamed to
 * `<name>.corrupt-<UTC time>` (it keeps its owner-only mode), one warning says where it
 * went, and the store starts empty. If it cannot be moved aside, reading fails instead of
 * returning an empty store that would be saved over it.
 */

import { existsSync, readFileSync, renameSync } from 'fs';
import { basename } from 'path';

/** Where a quarantine notice goes. stderr by default; the TUI can route it elsewhere. */
let warn: (message: string) => void = (message) => {
  process.stderr.write(`Warning: ${message}\n`);
};

/** Send store warnings to `sink` instead of stderr (the TUI owns the screen). */
export function setStoreWarningSink(sink: (message: string) => void): void {
  warn = sink;
}

/** `.corrupt-20261121T174500Z` suffix for a file moved aside at `now`. */
export function corruptSuffix(now = new Date()): string {
  return `.corrupt-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}`;
}

/** Thrown when a damaged store file could not be moved aside. */
export class StoreUnreadableError extends Error {}

/**
 * Parse `file` with `parse` (a zod parse, say). Missing file: `empty()`. Damaged file:
 * moved aside with a warning, then `empty()`. `label` names it for the user ("address
 * book").
 */
export function readJsonStore<T>(
  file: string,
  parse: (data: unknown) => T,
  empty: () => T,
  label: string,
): T {
  if (!existsSync(file)) return empty();
  const text = readFileSync(file, 'utf-8');
  try {
    return parse(JSON.parse(text));
  } catch {
    const target = file + corruptSuffix();
    try {
      renameSync(file, target);
    } catch (err) {
      throw new StoreUnreadableError(
        `Your ${label} (${file}) could not be read, and it could not be moved aside (${(err as Error).message}). Fix or move the file, then try again.`,
      );
    }
    warn(
      `Your ${label} (${basename(file)}) could not be read, so it was moved to ${basename(target)} and a new one was started. Nothing was deleted.`,
    );
    return empty();
  }
}
