/**
 * Start the interactive terminal UI (`fhew` with no arguments, or `fhew interactive`).
 */

import { createBackend } from '../core/backend/select.js';
import type { Backend } from '../core/backend/types.js';
import type { NetworkName } from '../core/network/NetworkConfig.js';
import { getDefaultNetwork } from '../storage/ConfigStore.js';
import { isValidNetwork } from '../utils/validation.js';
import { describeError } from './errors.js';
import { refreshEth, reload } from './flows/data.js';
import { runShell } from './shell.js';
import { loadSnapshot } from './snapshot.js';
import { initialState } from './state.js';

/** The network to start on: `-n/--network` (via OVERRIDE_NETWORK), else the saved default. */
export function startNetwork(env: NodeJS.ProcessEnv = process.env): NetworkName {
  const override = env.OVERRIDE_NETWORK;
  if (override && isValidNetwork(override)) return override as NetworkName;
  return getDefaultNetwork();
}

/**
 * Run the TUI and exit the process with its code. Needs an interactive terminal on both
 * stdin and stdout; otherwise explains how to use the commands instead.
 */
export async function runTui(opts: { backend?: Backend } = {}): Promise<never> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'The interactive wallet needs a terminal. Run `fhew --help` to see the commands you can use in scripts.\n',
    );
    process.exit(1);
  }
  let backend: Backend;
  try {
    backend = opts.backend ?? createBackend();
  } catch (err) {
    process.stderr.write(`${describeError(err).title}\n`);
    process.exit(1);
  }

  const network = startNetwork();
  const state = initialState({
    network,
    backendKind: backend.kind,
    data: loadSnapshot(network),
    now: Date.now(),
  });
  const result = await runShell({
    state,
    backend,
    startEffects: [reload(state), refreshEth(state)],
  });

  const out: string[] = [];
  if (result.code === 0) {
    out.push(`Bye. Your wallets stay encrypted in ${result.state.data.dataDir}`);
  }
  for (const p of result.state.pending) {
    out.push(
      `Still confirming: ${p.amountText} to ${p.toLabel}${p.txHash ? ` · ${backend.explorerTxUrl(p.txHash, result.state.network)}` : ''}`,
    );
    out.push('Check it on the explorer before sending again.');
  }
  if (out.length) process.stdout.write(out.join('\n') + '\n');
  // Pending confirmations and SDK workers must not keep the process alive after Quit.
  process.exit(result.code);
}
