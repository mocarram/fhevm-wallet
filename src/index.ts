#!/usr/bin/env node

/**
 * fhEVM Wallet CLI - Entry Point
 *
 * A CLI wallet for managing encrypted ERC-7984 tokens using Zama's FHE technology.
 */

import { loadEnv } from './storage/paths.js';

// Load environment variables (checks ~/.fhevm-wallet/.env first, then cwd)
loadEnv();

import { createProgram, runInteractiveMode } from './cli/index.js';

const program = createProgram();

// If no arguments provided, launch interactive mode
if (process.argv.length <= 2) {
  runInteractiveMode().catch(console.error);
} else {
  program.parse(process.argv);
}
