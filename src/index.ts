#!/usr/bin/env node

/**
 * fhEVM Wallet CLI - entry point.
 *
 * Kept tiny on purpose: everything here runs before any dependency is loaded.
 *
 * - `fhew --version` (or `-V`) alone is answered from package.json without loading the
 *   wallet (about 40 ms instead of about 350 ms).
 * - Node's compile cache is turned on in a private folder (see `compileCache.ts`), which
 *   saves about 60 ms on every later start.
 * - Then `main.ts` runs the usual start-up: data-folder checks, settings, commands.
 */

import { readFileSync } from 'fs';
import { enablePrivateCompileCache } from './compileCache.js';

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    version: string;
  };
  process.stdout.write(`${pkg.version}\n`);
} else {
  enablePrivateCompileCache();
  await import('./main.js');
}
