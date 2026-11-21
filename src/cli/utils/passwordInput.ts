/**
 * The wallet password for one command: asked with hidden input on a terminal, or read
 * from stdin with `--password-stdin` (balance and send) for scripts and password
 * managers. Without either there is no prompt and the command says so (see prompts.ts).
 */

import { prompts, SECRET_MASK } from './prompts.js';

/**
 * Read a password from stdin for `--password-stdin`: everything piped in, minus one
 * trailing line break (spaces are kept: they can be part of a password).
 */
export async function readPasswordFromStdin(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (stdin.isTTY) {
    throw new Error(
      '--password-stdin reads the password from a pipe, e.g. `pass show w | fhew …`.',
    );
  }
  let text = '';
  for await (const chunk of stdin) text += chunk.toString();
  const password = text.replace(/\r?\n$/, '');
  if (!password) throw new Error('No password was piped in on stdin.');
  return password;
}

/** Ask for the wallet password, or read it from stdin with `--password-stdin`. */
export async function walletPassword(passwordStdin?: boolean): Promise<string> {
  if (passwordStdin) return readPasswordFromStdin();
  return prompts.password({ message: 'Enter wallet password:', mask: SECRET_MASK });
}

/** Help text for --password-stdin. */
export const PASSWORD_STDIN_HELP =
  'Read the wallet password from stdin (e.g. `pass show w | fhew …`) instead of asking';
