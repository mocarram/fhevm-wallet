#!/usr/bin/env node

/**
 * fhEVM Wallet CLI - Entry Point
 *
 * A CLI wallet for managing encrypted ERC-7984 tokens using Zama's FHE technology.
 */

import { loadEnv, secureExistingData } from './storage/paths.js';

// Load environment variables (checks ~/.fhevm-wallet/.env first, then cwd)
loadEnv();

// Older versions wrote wallet data with default (often world-readable) permissions.
// Fix them silently on every start; mention it on stderr so stdout stays scriptable.
const tightened = secureExistingData();
if (tightened > 0) {
  process.stderr.write(`Secured permissions on ${tightened} wallet data file(s).\n`);
}

import { createProgram, runInteractiveMode } from './cli/index.js';

const program = createProgram();

// If no arguments provided, launch interactive mode
if (process.argv.length <= 2) {
  runInteractiveMode().catch(console.error);
} else {
  program.parse(process.argv);
}
