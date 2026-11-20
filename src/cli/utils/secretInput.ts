/**
 * Read an API key given on the command line without putting it in shell history.
 *
 * `--etherscan-key VALUE` stays for scripts, but the value then lands in ~/.bash_history
 * and `ps` output. `--etherscan-key` with no value (or `-`) asks for it with hidden input
 * on a terminal; `-` with piped stdin reads it from there (`pass show x | fhew config
 * --etherscan-key -`).
 */

import inquirer from 'inquirer';

/** Minimal readable stream we need, so tests can pass their own. */
export interface SecretInputIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  ask: (label: string) => Promise<string>;
}

const defaultIO: SecretInputIO = {
  stdin: process.stdin,
  ask: async (label) => {
    const { value } = await inquirer.prompt([
      { type: 'password', name: 'value', message: `${label}:`, mask: '*' },
    ]);
    return String(value);
  },
};

/** Read all of `stream` as text. */
async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += chunk.toString();
  return text;
}

/**
 * Turn a commander option value into the secret: the value itself, or (for `true`, i.e.
 * the flag without a value, or `-`) the hidden prompt or stdin. Returns it trimmed.
 */
export async function resolveSecretOption(
  value: string | true,
  label: string,
  io: SecretInputIO = defaultIO,
): Promise<string> {
  if (value !== true && value !== '-') return value.trim();
  if (value === '-' && !io.stdin.isTTY) return (await readAll(io.stdin)).trim();
  return (await io.ask(label)).trim();
}

/** Help text for a key option, with the shell-history warning. */
export function secretOptionHelp(what: string): string {
  return `Set ${what}. Omit the value (or use -) to type it hidden or pipe it in; a value typed on the command line is kept in your shell history`;
}
