/**
 * Choose the backend for this process. The real one is the default; the offline mock is
 * only used when explicitly asked for with `FHEW_BACKEND=mock`.
 */

import { MockBackend, mockOptionsFromEnv } from './MockBackend.js';
import { RealBackend } from './RealBackend.js';
import type { Backend } from './types.js';

/**
 * Create the backend named by `FHEW_BACKEND` (`real` or unset → real, `mock` → mock).
 * An unknown value is an error rather than a silent fallback, so a typo cannot make a
 * user believe they are on a simulation while real funds move (or the reverse).
 */
export function createBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  const wanted = (env.FHEW_BACKEND ?? '').trim().toLowerCase();
  if (wanted === '' || wanted === 'real') return new RealBackend();
  if (wanted === 'mock') return new MockBackend(mockOptionsFromEnv(env));
  throw new Error(`Unknown FHEW_BACKEND "${env.FHEW_BACKEND}". Use "real" or "mock".`);
}
