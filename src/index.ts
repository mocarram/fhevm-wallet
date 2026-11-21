#!/usr/bin/env node

/**
 * fhEVM Wallet CLI - entry point.
 *
 * Kept tiny on purpose: everything here runs before any dependency is loaded.
 *
 * - Node's compile cache is turned on in a private folder (see `compileCache.ts`), which
 *   saves about 60 ms on every later start.
 * - `startup.ts` runs the checks every command gets (backend switch, data folder trust
 *   and permissions, settings), with light modules only.
 * - `fhew --version` (or `-V`) alone is then answered from package.json without loading
 *   the commands (about 70 ms instead of about 350 ms); anything else loads `main.ts`.
 */

import { readFileSync } from 'fs';
import { enablePrivateCompileCache } from './compileCache.js';

enablePrivateCompileCache();
// The checks every command gets (they exit on failure), before anything heavy loads.
await import('./startup.js');

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    version: string;
  };
  process.stdout.write(`${pkg.version}\n`);
} else {
  await import('./main.js');
}
