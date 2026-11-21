/**
 * Choose the backend for this process. The real one is the default; the offline mock is
 * only used when explicitly asked for with `FHEW_BACKEND=mock`.
 */

import { realpathSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { MockBackend, mockOptionsFromEnv } from './MockBackend.js';
import { RealBackend } from './RealBackend.js';
import type { Backend } from './types.js';

/** Why the mock may not run with this environment, or null when it may. */
export function mockDataDirProblem(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  const advice =
    'The offline mock writes simulated tokens, balances and history to the data folder, so it only runs with FHEVM_WALLET_HOME set to a separate, throwaway folder, for example: FHEW_BACKEND=mock FHEVM_WALLET_HOME=$(mktemp -d) fhew';
  const dir = env.FHEVM_WALLET_HOME?.trim();
  if (!dir) return `FHEVM_WALLET_HOME is not set. ${advice}`;
  // Compare real paths, so a symlink or "~/.fhevm-wallet/." cannot point back at it.
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  if (real(dir) === real(join(home, '.fhevm-wallet'))) {
    return `FHEVM_WALLET_HOME points at your real wallet folder. ${advice}`;
  }
  return null;
}

/**
 * Create the backend named by `FHEW_BACKEND` (`real` or unset → real, `mock` → mock).
 * An unknown value is an error rather than a silent fallback, so a typo cannot make a
 * user believe they are on a simulation while real funds move (or the reverse). The mock
 * refuses to run against the default data folder (see `mockDataDirProblem`).
 */
export function createBackend(env: NodeJS.ProcessEnv = process.env, home?: string): Backend {
  const wanted = (env.FHEW_BACKEND ?? '').trim().toLowerCase();
  if (wanted === '' || wanted === 'real') return new RealBackend();
  if (wanted === 'mock') {
    const problem = mockDataDirProblem(env, home);
    if (problem) throw new Error(problem);
    return new MockBackend(mockOptionsFromEnv(env));
  }
  throw new Error(`Unknown FHEW_BACKEND "${env.FHEW_BACKEND}". Use "real" or "mock".`);
}
