/**
 * Effects: descriptions of I/O for the terminal shell to run.
 *
 * Key handlers return effects instead of doing I/O. The shell runs each effect with the
 * `Deps` (backend, secret screen, …) and applies the state update it resolves to. Long
 * effects can push intermediate updates through `deps.dispatch` (e.g. "broadcast, now
 * pending" before the confirmation arrives).
 */

import type { Backend } from '../core/backend/types.js';
import type { AppState } from './state.js';

/** A state change produced by an effect. May return follow-up effects. */
export type Updater = (s: AppState) => Effect[] | void;

/** What effects may use. */
export interface Deps {
  backend: Backend;
  /** Apply a state update now and re-render. */
  dispatch: (update: Updater) => void;
  /**
   * Show a secret on a screen that is wiped on the next key press (the existing
   * `showSecretScreen`). The TUI is suspended meanwhile.
   */
  showSecret: (title: string, lines: string[]) => Promise<void>;
  /** Offer text to the terminal's clipboard (OSC 52). Returns false when not possible. */
  copyToClipboard: (text: string) => boolean;
  /** Current time in ms. */
  now: () => number;
}

/** One unit of I/O. `kind` names it for tests and debugging. */
export interface Effect {
  kind: string;
  run: (deps: Deps) => Promise<Updater | void>;
}

/** Make an effect. */
export function effect(kind: string, run: (deps: Deps) => Promise<Updater | void>): Effect {
  return { kind, run };
}

/** The effect that ends the app; the shell restores the terminal and exits with code 0. */
export const QUIT: Effect = effect('quit', async () => (s) => {
  s.quit = true;
});
