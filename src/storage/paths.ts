/**
 * Centralized path configuration for data storage
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Root data directory - stored in user's home directory
 */
export const DATA_DIR = join(homedir(), '.fhevm-wallet');

/**
 * Ensure data directory exists
 */
export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}
