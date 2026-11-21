/**
 * Where warnings about damaged data files go while the TUI owns the screen.
 *
 * wip/fix-core moves a store file it cannot parse aside (`<name>.corrupt-<time>`) and
 * reports it through `setStoreWarningSink` (src/storage/jsonStore.ts), stderr by
 * default. Written to stderr during the TUI, that line would land in the middle of a
 * frame; the shell instead shows it as a notice on Home (`storeWarningNotice`).
 *
 * INTEGRATION ADAPTER: this base has no jsonStore yet. When wip/fix-core is merged,
 * make the two functions below call `setStoreWarningSink(sink)` and
 * `setStoreWarningSink(STDERR_SINK)`; the shell already calls them on start and exit.
 */

import { dimLine, line, seg, type Line } from './text.js';

/** The default sink (as in jsonStore): one "Warning:" line on stderr. */
export const STDERR_SINK = (message: string): void => {
  process.stderr.write(`Warning: ${message}\n`);
};

/** Route store warnings to `sink` (the TUI). */
export function installStoreWarningSink(sink: (message: string) => void): void {
  void sink; // INTEGRATION: setStoreWarningSink(sink);
}

/** Back to stderr once the TUI has restored the terminal. */
export function restoreStoreWarningSink(): void {
  // INTEGRATION: setStoreWarningSink(STDERR_SINK);
}

/** The Home notice for a store warning. */
export function storeWarningNotice(message: string): Line[] {
  return [
    line('  ', seg(`! ${message}`, 'yellow bold')),
    dimLine('    The damaged file was kept next to the new one; nothing else was changed.'),
  ];
}
