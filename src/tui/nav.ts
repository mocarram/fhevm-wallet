/**
 * Opening screens. A screen may declare `onEnter` effects (load history, run checks);
 * `open` pushes the screen and returns them, so every way of reaching a screen (menu,
 * letter key, command bar) loads it the same way.
 */

import type { Effect } from './effects.js';
import { goHome, push, replace, type AppState } from './state.js';
import { SCREENS } from './screens/registry.js';
import type { Line } from './text.js';

/** Push screen `id` and return its enter effects. */
export function open(s: AppState, id: string, params: Record<string, string> = {}): Effect[] {
  push(s, id, params);
  return SCREENS[id]?.onEnter?.(s) ?? [];
}

/** Replace the current screen with `id` and return its enter effects. */
export function openInstead(
  s: AppState,
  id: string,
  params: Record<string, string> = {},
): Effect[] {
  replace(s, id, params);
  return SCREENS[id]?.onEnter?.(s) ?? [];
}

/** Go to the root screen, then open `id` on top of it (command bar navigation). */
export function openFromRoot(s: AppState, id: string, flash: Line[] | null = null): Effect[] {
  goHome(s);
  const effects = open(s, id);
  s.flash = flash;
  return effects;
}

/** Pop screens until `id` is on top (or only the root is left). Returns true if found. */
export function popTo(s: AppState, id: string): boolean {
  while (s.stack.length > 1 && s.stack[s.stack.length - 1].id !== id) s.stack.pop();
  return s.stack[s.stack.length - 1].id === id;
}
