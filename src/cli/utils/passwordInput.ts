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

/** True when decrypting a keystore failed because of the password (not a broken file). */
export function isWrongPassword(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /(?:in)?correct password|invalid password/i.test(message);
}

/** The wrong-password sentence, the same wording as the terminal UI. */
export function wrongPasswordMessage(walletName: string): string {
  return `That password did not unlock ${walletName}. Check it and try again.`;
}

/**
 * Without a terminal and without --password-stdin there is nobody to ask: the sentence
 * that names the option (null when the password can be asked or read).
 */
export function passwordStdinNeeded(
  passwordStdin: boolean | undefined,
  command = '',
  stdin: { isTTY?: boolean } = process.stdin,
): string | null {
  if (passwordStdin || stdin.isTTY) return null;
  return `No terminal to ask for the wallet password. Pipe it in and add --password-stdin, e.g. \`pass show my-wallet | fhew ${command ? `${command} ` : ''}… --password-stdin\`.`;
}

/** Read all of stdin (a pipe) as text. */
async function readStdin(stdin: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> {
  if (stdin.isTTY) {
    throw new Error('--password-stdin reads from a pipe, e.g. `pass show w | fhew …`.');
  }
  let text = '';
  for await (const chunk of stdin) text += chunk.toString();
  return text;
}

/**
 * For `wallet import --password-stdin`: the recovery phrase or private key on the first
 * line of stdin and the new password on the second (spaces in the password are kept).
 */
export async function readSecretAndPasswordFromStdin(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): Promise<{ secret: string; password: string }> {
  const lines = (await readStdin(stdin)).split(/\r?\n/);
  const secret = (lines[0] ?? '').trim();
  const password = lines[1] ?? '';
  if (!secret || !password) {
    throw new Error(
      'Pipe in two lines: the recovery phrase (or private key) first, then the password.',
    );
  }
  return { secret, password };
}

/** Rule for a new wallet password (the prompt and --password-stdin share it). */
export function newPasswordProblem(password: string): string | null {
  return password.length >= 8 ? null : 'Password must be at least 8 characters';
}
