/**
 * `fhew interactive` (alias `i`) and `fhew` with no arguments: launch the terminal UI.
 *
 * The UI itself lives in src/tui (one module per screen, shared flows in src/tui/flows
 * and src/core/send). This file only wires it into commander. The TUI is loaded lazily so
 * plain subcommands never pay for it.
 */

import type { Command } from 'commander';

/**
 * Start the interactive terminal UI, on `network` when given (validated by the program's
 * preAction hook); resolves never (the process exits when it ends).
 */
export async function runInteractiveMode(network?: string): Promise<void> {
  const { runTui } = await import('../../tui/index.js');
  await runTui({ network });
}

/** Register `fhew interactive` / `fhew i`. */
export function registerInteractiveCommand(program: Command): void {
  program
    .command('interactive')
    .alias('i')
    .description('Launch the interactive terminal UI (same as running fhew with no arguments)')
    .option('-n, --network <network>', 'Network to start on (sepolia or mainnet)')
    .action(async (options: { network?: string }) => {
      await runInteractiveMode(options.network);
    });
}
