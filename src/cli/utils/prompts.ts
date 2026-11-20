/**
 * Prompts for the non-interactive subcommands (`fhew wallet create`, `fhew send` without
 * arguments, …), built on `@inquirer/prompts`.
 *
 * The functions are grouped in one mutable object so tests can stub a single prompt with
 * `vi.spyOn(prompts, 'select')` without mocking the whole module. The full-screen TUI
 * (`src/tui`) does not use these: it has its own keymap and renderer.
 */

import { confirm, input, password, select } from '@inquirer/prompts';

/** Characters echoed for each typed secret character. */
export const SECRET_MASK = '*';

/** The prompt functions used by commander subcommands. */
export const prompts = {
  /** Pick one value from a list. */
  select,
  /** Free text, with optional validation. */
  input,
  /** Masked text for passwords, private keys and phrases. */
  password,
  /** Yes / no. */
  confirm,
};

/** Value returned by list prompts when the user picks "Cancel". */
export const CANCEL = '__cancel__';
