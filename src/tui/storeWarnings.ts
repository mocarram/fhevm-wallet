/**
 * Where warnings about damaged data files go while the TUI owns the screen.
 *
 * A store file that cannot be parsed is moved aside (`<name>.corrupt-<time>`) and
 * reported through `setStoreWarningSink` (src/storage/jsonStore.ts), stderr by default.
 * Written to stderr during the TUI, that line would land in the middle of a frame; the
 * shell instead shows it as a notice on Home (`storeWarningNotice`). The shell calls
 * the two functions below on start and exit.
 */

import { setStoreWarningSink } from '../storage/jsonStore.js';
import { dimLine, line, seg, type Line } from './text.js';

/** The default sink (as in jsonStore): one "Warning:" line on stderr. */
export const STDERR_SINK = (message: string): void => {
  process.stderr.write(`Warning: ${message}\n`);
};

/** Route store warnings to `sink` (the TUI). */
export function installStoreWarningSink(sink: (message: string) => void): void {
  setStoreWarningSink(sink);
}

/** Back to stderr once the TUI has restored the terminal. */
export function restoreStoreWarningSink(): void {
  setStoreWarningSink(STDERR_SINK);
}

/** The Home notice for a store warning. */
export function storeWarningNotice(message: string): Line[] {
  return [
    line('  ', seg(`! ${message}`, 'yellow bold')),
    dimLine('    The damaged file was kept next to the new one; nothing else was changed.'),
  ];
}
