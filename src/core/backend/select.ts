/**
 * Choose the backend for this process. The real one is the default; the offline mock is
 * only used when the process was started with `FHEW_BACKEND=mock`.
 */

import {
  assertNotMockDataDir,
  LAUNCH_ENV,
  prepareMockDataDir,
  type GuardPaths,
  type LaunchEnv,
} from './mockGuard.js';
import { MockBackend, mockOptionsFromEnv } from './MockBackend.js';
import { RealBackend } from './RealBackend.js';
import type { Backend } from './types.js';

/**
 * Create the backend named by `FHEW_BACKEND` (`real` or unset → real, `mock` → mock),
 * read from the launch environment, never from a `.env` file. An unknown value is an
 * error rather than a silent fallback, so a typo cannot make a user believe they are on a
 * simulation while real funds move (or the reverse). The mock only runs in a mock data
 * folder, and the real backend refuses one (see mockGuard.ts).
 */
export function createBackend(env: LaunchEnv = LAUNCH_ENV, paths: GuardPaths = {}): Backend {
  const wanted = (env.FHEW_BACKEND ?? '').trim().toLowerCase();
  if (wanted === '' || wanted === 'real') {
    assertNotMockDataDir(paths.dataDir);
    return new RealBackend();
  }
  if (wanted === 'mock') {
    prepareMockDataDir(env, paths);
    // Only the FHEW_MOCK_* test knobs are read from the full environment.
    return new MockBackend(mockOptionsFromEnv(process.env));
  }
  throw new Error(`Unknown FHEW_BACKEND "${env.FHEW_BACKEND}". Use "real" or "mock".`);
}
