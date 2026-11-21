/**
 * Show a secret (private key, recovery phrase) without leaving it in terminal scrollback.
 *
 * On a TTY the secret is drawn on the terminal's *alternate screen* (the buffer full-screen
 * apps like vim use). Leaving the alternate screen restores the previous contents, and
 * most terminals do not keep alternate-screen output in scrollback. The user presses Enter
 * to wipe it (Ctrl+C also wipes); other keys are ignored, so a stray key press cannot
 * wipe a recovery phrase before it was written down.
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
  /** Where termination signals arrive and how to exit; the real process by default. */
  proc?: Pick<NodeJS.Process, 'once' | 'removeListener' | 'exit'>;
}

/** Signals that end the process while the secret is on screen. */
const EXIT_SIGNALS: Record<'SIGINT' | 'SIGTERM' | 'SIGHUP', number> = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGHUP: 1,
};

/**
 * Display `lines` under `title`. On a TTY, resolves `true` once the user pressed a key
 * and the screen was wiped; resolves `false` when it could only print the secret.
 */
export async function showSecretScreen(
  title: string,
  lines: string[],
  io: SecretScreenIO = { input: process.stdin, output: process.stdout },
): Promise<boolean> {
  const { input, output, ignoreInputMs = 300, proc = process } = io;
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
      '  Press Enter when you have it. The screen is then wiped.',
      '',
    ].join('\n'),
  );

  // Restore the terminal exactly once, whichever way the screen ends.
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    input.setRawMode!(false);
    input.pause();
    output.write(LEAVE_ALT);
  };
  // Killed while the secret is showing (kill, closed terminal, Ctrl+C when raw mode is
  // not in effect): leave raw mode and the alternate screen before exiting, so the
  // user's shell is usable and the secret is not left on screen.
  const onSignal = (signal: NodeJS.Signals): void => {
    restore();
    proc.exit(128 + EXIT_SIGNALS[signal as keyof typeof EXIT_SIGNALS]);
  };
  for (const signal of Object.keys(EXIT_SIGNALS)) proc.once(signal, onSignal);

  input.setRawMode(true);
  input.resume();
  const openedAt = Date.now();
  let onData: (chunk?: Buffer | string) => void = () => {};
  let onEnd: () => void = () => {};
  try {
    await new Promise<void>((resolve) => {
      onData = (chunk?: Buffer | string) => {
        if (Date.now() - openedAt < ignoreInputMs) return;
        const text = chunk === undefined ? '' : chunk.toString();
        // Enter wipes; Ctrl+C and Ctrl+D (raw mode delivers them as bytes) too.
        if (['\r', '\n', '\x03', '\x04'].some((c) => text.includes(c))) resolve();
      };
      // If stdin closes there is no key to wait for; wipe rather than hang.
      onEnd = () => resolve();
      input.on('data', onData);
      input.once('end', onEnd);
    });
  } finally {
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    for (const signal of Object.keys(EXIT_SIGNALS)) proc.removeListener(signal, onSignal);
    // Always restore the terminal, or the user is left in raw mode on the alternate screen.
    restore();
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
