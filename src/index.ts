#!/usr/bin/env node

/**
 * fhEVM Wallet CLI - Entry Point
 *
 * A CLI wallet for managing encrypted ERC-7984 tokens using Zama's FHE technology.
 */

import { DATA_DIR, loadEnv, secureExistingData } from './storage/paths.js';

// Load environment variables (the data dir's .env, plus allowed keys from ./.env).
// Failing here (data dir not writable) gets one clear sentence, not a stack trace.
try {
  loadEnv();

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

const program = createProgram();

// If no arguments provided, launch interactive mode
if (process.argv.length <= 2) {
  runInteractiveMode().catch(console.error);
} else {
  program.parse(process.argv);
}
