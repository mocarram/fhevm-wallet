/**
 * The network the user typed with -n/--network, wherever they typed it.
 *
 * The program defines a global `-n, --network`, and commander gives a flag to the
 * program-level option even when it comes after the subcommand (`fhew balance -n
 * mainnet`). The subcommands' own `-n` options therefore never received a value and
 * they silently fell back to the configured default network. This module moves the
 * typed value to the subcommand that runs, so every command reads `options.network`
 * as before and gets what the user typed.
 */

import type { Command } from 'commander';

/** The `-n/--network` value typed on the command line for `actionCommand`, if any. */
export function typedNetwork(actionCommand: Command): string | undefined {
  const value = (actionCommand.optsWithGlobals() as { network?: unknown }).network;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Copy the typed network to the running subcommand's own `network` option, if it has
 * one. Called from the program's preAction hook, before the action reads its options.
 */
export function adoptTypedNetwork(actionCommand: Command): void {
  const value = typedNetwork(actionCommand);
  if (value === undefined) return;
  if (actionCommand.options.some((o) => o.attributeName() === 'network')) {
    actionCommand.setOptionValue('network', value);
  }
}
