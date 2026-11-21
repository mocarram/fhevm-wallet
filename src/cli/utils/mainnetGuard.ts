/**
 * Mainnet guard for one-shot commands that sign a transaction (`fhew send`, `fhew operator
 * set|revoke`, `fhew disclose`).
 *
 * When nobody will be asked to confirm (`--yes`, or no terminal), a Mainnet transaction
 * needs two explicit signs of intent on the command line: `-n mainnet` (so a configured
 * default network can never pick Mainnet silently) and `--mainnet`.
 */

import type { NetworkName } from '../../core/network/NetworkConfig.js';

/** Help text for the `--mainnet` option. */
export const MAINNET_OPTION_HELP =
  'Allow a Mainnet transaction without confirmation (with --yes or no terminal); needs -n mainnet too';

/** The error code a refused unconfirmed Mainnet transaction reports (e.g. with --json). */
export const MAINNET_GUARD_CODE = 'MAINNET_NOT_CONFIRMED';

/**
 * Returns the refusal to show, or null when the command may go on. `what` completes
 * "this would … without asking you" (default: a send's "move real funds on Mainnet").
 */
export function mainnetGuardProblem(opts: {
  network: NetworkName;
  networkOption?: string;
  mainnetFlag?: boolean;
  willAsk: boolean;
  what?: string;
}): string | null {
  if (opts.network !== 'mainnet' || opts.willAsk) return null;
  if (opts.networkOption === 'mainnet' && opts.mainnetFlag) return null;
  const what = opts.what ?? 'move real funds on Mainnet';
  return `Nothing was sent: this would ${what} without asking you. To allow it, pass both -n mainnet and --mainnet, or run the command in a terminal without --yes.`;
}
