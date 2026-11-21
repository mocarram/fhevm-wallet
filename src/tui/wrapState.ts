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
  /**
   * Unwraps whose step 2 runs in the background after an Unwrap's confirm (ids): Home's
   * "Finish unwrap" must not start a second finalize for them meanwhile.
   */
  background: string[];
}

/** The empty view at start. */
export function emptyWrapView(): WrapView {
  return { loading: false, state: {}, background: [] };
}
