/**
 * Show a secret (private key, recovery phrase) without leaving it in terminal scrollback.
 *
 * On a TTY the secret is drawn on the terminal's *alternate screen* (the buffer full-screen
 * apps like vim use). Leaving the alternate screen restores the previous contents, and
 * most terminals do not keep alternate-screen output in scrollback. The user presses any
 * key to wipe it.
 *
 * When stdout is not a TTY (piped, CI) there is no alternate screen; the secret is printed
 * with a warning, because the user explicitly asked for it.
 */

import type { ReadStream } from 'tty';

const ENTER_ALT = '\x1b[?1049h\x1b[H\x1b[2J';
const LEAVE_ALT = '\x1b[2J\x1b[?1049l';

export interface SecretScreenIO {
  input: NodeJS.ReadableStream & Partial<Pick<ReadStream, 'isTTY' | 'setRawMode'>>;
  output: NodeJS.WritableStream & { isTTY?: boolean };
  /**
   * Ignore key presses for this long after the screen opens (default 300 ms), so a key
   * still buffered from the previous prompt cannot wipe the secret before it is seen.
   */
  ignoreInputMs?: number;
}

/**
 * Display `lines` under `title`. On a TTY, resolves `true` once the user pressed a key
 * and the screen was wiped; resolves `false` when it could only print the secret.
 */
export async function showSecretScreen(
  title: string,
  lines: string[],
  io: SecretScreenIO = { input: process.stdin, output: process.stdout },
): Promise<boolean> {
  const { input, output, ignoreInputMs = 300 } = io;
  const body = ['', `  ${title}`, '', ...lines.map((l) => `    ${l}`), ''];

  if (!output.isTTY || !input.isTTY || !input.setRawMode) {
    output.write(body.join('\n') + '\n');
    output.write('  (Not an interactive terminal: clear your scrollback after copying this.)\n');
    return false;
  }

  output.write(ENTER_ALT);
  output.write(
    [
      ...body,
      '  Write it down or store it in a password manager.',
      '  Press any key to wipe this screen.',
      '',
    ].join('\n'),
  );

  input.setRawMode(true);
  input.resume();
  const openedAt = Date.now();
  let onData: () => void = () => {};
  let onEnd: () => void = () => {};
  try {
    await new Promise<void>((resolve) => {
      onData = () => {
        if (Date.now() - openedAt >= ignoreInputMs) resolve();
      };
      // If stdin closes there is no key to wait for; wipe rather than hang.
      onEnd = () => resolve();
      input.on('data', onData);
      input.once('end', onEnd);
    });
  } finally {
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    // Always restore the terminal, or the user is left in raw mode on the alternate screen.
    input.setRawMode(false);
    input.pause();
    output.write(LEAVE_ALT);
  }
  return true;
}

/** Group a recovery phrase into numbered words, four per line, for easier copying. */
export function formatPhrase(phrase: string): string[] {
  const words = phrase.trim().split(/\s+/);
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 4) {
    lines.push(
      words
        .slice(i, i + 4)
        .map((w, j) => `${String(i + j + 1).padStart(2)} ${w.padEnd(10)}`)
        .join(' '),
    );
  }
  return lines;
}
