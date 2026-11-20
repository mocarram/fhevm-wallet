#!/usr/bin/env node

/**
 * fhEVM Wallet CLI - Entry Point
 *
 * A CLI wallet for managing encrypted ERC-7984 tokens using Zama's FHE technology.
 */

import { DATA_DIR, loadEnv, secureExistingData } from './storage/paths.js';

// Load settings: the data dir's private .env, plus allow-listed keys from ./.env.
// Failing here (data dir not writable) gets one clear sentence, not a stack trace.
try {
  const env = loadEnv();
  // A ./.env can point the wallet at another RPC: say where settings came from.
  if (env.fromCwd.length > 0) {
    process.stderr.write(`Using ${env.fromCwd.join(', ')} from ./.env in this folder.\n`);
  }
  if (env.ignoredFromCwd.length > 0) {
    process.stderr.write(
      `Ignored ${env.ignoredFromCwd.join(', ')} in ./.env: only RPC URLs and API keys are read from there.\n`,
    );
  }

  // Older versions wrote wallet data with default (often world-readable) permissions.
  // Fix them on every start; mention it on stderr so stdout stays scriptable.
  const { tightened, warning } = secureExistingData();
  if (tightened > 0) {
    process.stderr.write(
      `Restricted ${tightened} wallet data item(s) (files or folders) to your user only.\n`,
    );
  }
  if (warning) process.stderr.write(`Warning: ${warning}\n`);
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  process.stderr.write(
    code === 'EACCES' || code === 'EPERM'
      ? `Cannot use the wallet data folder ${DATA_DIR}: permission denied. Make it writable by your user, or set FHEVM_WALLET_HOME to another folder.\n`
      : `Cannot open the wallet data folder ${DATA_DIR}: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

import { createProgram, runInteractiveMode } from './cli/index.js';
import { describeError } from './cli/utils/userError.js';

// Last line of defence: an error no command caught must not print its raw message or
// stack, which for ethers errors includes the RPC URL and its API key.
const failSafely = (err: unknown): void => {
  process.stderr.write(`Error: ${describeError(err)}\n`);
  process.exitCode = 1;
};
process.on('unhandledRejection', failSafely);
process.on('uncaughtException', (err) => {
  failSafely(err);
  process.exit(1); // state is unknown after an uncaught exception: stop
});

const program = createProgram();

// If no arguments provided, launch interactive mode
if (process.argv.length <= 2) {
  runInteractiveMode().catch(failSafely);
} else {
  program.parseAsync(process.argv).catch(failSafely);
}
