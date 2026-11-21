/**
 * `ora` spinners with the TUI's marks (✔ ! ✗ ·) and colour only on a colour terminal.
 *
 * ora's own marks come from log-symbols, which colours them whether or not stderr is a
 * terminal (escape codes in log files) and falls back to √ ‼ × on some terminals. This
 * wrapper keeps ora's animation and replaces the four end states.
 */

import chalk from 'chalk';
import ora, { type Ora, type Options } from 'ora';

/** Create a spinner, like `ora(options)`. */
export function spinner(options?: string | Options): Ora {
  const s = ora(options);
  const stream =
    (typeof options === 'object' && options.stream) || (process.stderr as NodeJS.WriteStream);
  const colour = Boolean((stream as { isTTY?: boolean }).isTTY) && chalk.level > 0;
  const mark = (paint: (t: string) => string, m: string) => (colour ? paint(m) : m);
  s.succeed = (text?: string) => s.stopAndPersist({ symbol: mark(chalk.green, '✔'), text });
  s.fail = (text?: string) => s.stopAndPersist({ symbol: mark(chalk.red, '✗'), text });
  s.warn = (text?: string) => s.stopAndPersist({ symbol: mark(chalk.yellow, '!'), text });
  s.info = (text?: string) => s.stopAndPersist({ symbol: mark(chalk.blue, '·'), text });
  return s;
}
