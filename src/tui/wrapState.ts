/**
 * The Wrap / Unwrap part of the TUI state (flows/wrap.ts, screens/wrap.ts). In its own
 * module so the feature's state stays next to its code; `AppState.wrap` holds it.
 */

import type { WrapState } from '../core/token/wrapper.js';

/** What the Wrap screens show besides the snapshot (`s.data.wrappers`, `s.data.unwraps`). */
export interface WrapView {
  /** The wrapper check of tracked tokens is running. */
  loading: boolean;
  /** Why the check (or the public balance read) failed, for the screen. */
  error?: string;
  /** Public ERC-20 facts per wrapper token (lowercase address): balance, allowance. */
  state: Record<string, WrapState & { at: number }>;
  /** An unwrap being checked by "Finish unwrap" (its id). */
  finishing?: string;
}

/** The empty view at start and after a network or wallet switch. */
export function emptyWrapView(): WrapView {
  return { loading: false, state: {} };
}
