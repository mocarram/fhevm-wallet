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

/**
 * Refuse to prompt when stdin is not a terminal. inquirer v9 failed with "readline was
 * closed" there, which describeError words as "no interactive terminal"; @inquirer/prompts
 * instead treats the closed input like Ctrl+C and says "Cancelled.", which would hide
 * why the command stopped. The error is named so `describePromptError` recognises it.
 */
function needsTerminal<A extends unknown[], R>(prompt: (...args: A) => R): (...args: A) => R {
  return (...args: A) => {
    if (!process.stdin.isTTY) {
      throw Object.assign(new Error('No interactive terminal for the prompt.'), {
        name: 'AbortPromptError',
      });
    }
    return prompt(...args);
  };
}

/** The prompt functions used by commander subcommands. */
export const prompts = {
  /** Pick one value from a list. */
  select: needsTerminal(select),
  /** Free text, with optional validation. */
  input: needsTerminal(input),
  /** Masked text for passwords, private keys and phrases. */
  password: needsTerminal(password),
  /** Yes / no. */
  confirm: needsTerminal(confirm),
};

/** Value returned by list prompts when the user picks "Cancel". */
export const CANCEL = '__cancel__';
