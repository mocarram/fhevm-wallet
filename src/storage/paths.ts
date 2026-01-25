/**
 * Centralized path configuration for data storage
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as dotenvConfig } from 'dotenv';

/**
 * Root data directory - stored in user's home directory
 */
export const DATA_DIR = join(homedir(), '.fhevm-wallet');

/**
 * Path to .env file in data directory
 */
export const ENV_FILE_PATH = join(DATA_DIR, '.env');

/**
 * Ensure data directory exists
 */
export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Load environment variables from .env files
 * Priority: ~/.fhevm-wallet/.env first, then cwd/.env
 * This allows user-specific config to override project defaults
 */
export function loadEnv(): void {
  // First, load from cwd (lower priority)
  dotenvConfig();

  // Then, load from ~/.fhevm-wallet/.env (higher priority, overrides cwd)
  ensureDataDir();
  if (existsSync(ENV_FILE_PATH)) {
    dotenvConfig({ path: ENV_FILE_PATH, override: true });
  }
}

/**
 * Save or update an environment variable in ~/.fhevm-wallet/.env
 * Creates the file if it doesn't exist
 */
export function saveEnvVar(key: string, value: string): void {
  ensureDataDir();

  let content = '';
  if (existsSync(ENV_FILE_PATH)) {
    content = readFileSync(ENV_FILE_PATH, 'utf-8');
  }

  // Parse existing content into lines
  const lines = content.split('\n');
  const keyPattern = new RegExp(`^${key}=`);
  let found = false;

  // Update existing key or mark as found
  const updatedLines = lines.map((line) => {
    if (keyPattern.test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  // Add new key if not found
  if (!found) {
    // Remove trailing empty lines, add the new key, then add final newline
    while (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] === '') {
      updatedLines.pop();
    }
    updatedLines.push(`${key}=${value}`);
  }

  // Write back with trailing newline
  writeFileSync(ENV_FILE_PATH, updatedLines.join('\n') + '\n');

  // Update process.env immediately
  process.env[key] = value;
}

/**
 * Get an environment variable from ~/.fhevm-wallet/.env file directly
 * (not from process.env, which may include values from other sources)
 */
export function getEnvVar(key: string): string | undefined {
  if (!existsSync(ENV_FILE_PATH)) {
    return undefined;
  }

  const content = readFileSync(ENV_FILE_PATH, 'utf-8');
  const lines = content.split('\n');
  const keyPattern = new RegExp(`^${key}=(.*)$`);

  for (const line of lines) {
    const match = line.match(keyPattern);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * Remove an environment variable from ~/.fhevm-wallet/.env
 */
export function removeEnvVar(key: string): boolean {
  if (!existsSync(ENV_FILE_PATH)) {
    return false;
  }

  const content = readFileSync(ENV_FILE_PATH, 'utf-8');
  const lines = content.split('\n');
  const keyPattern = new RegExp(`^${key}=`);
  let found = false;

  const filteredLines = lines.filter((line) => {
    if (keyPattern.test(line)) {
      found = true;
      return false;
    }
    return true;
  });

  if (found) {
    // Remove trailing empty lines, then add final newline
    while (filteredLines.length > 0 && filteredLines[filteredLines.length - 1] === '') {
      filteredLines.pop();
    }
    const newContent = filteredLines.length > 0 ? filteredLines.join('\n') + '\n' : '';
    writeFileSync(ENV_FILE_PATH, newContent);

    // Remove from process.env as well
    delete process.env[key];
  }

  return found;
}

/**
 * List all environment variables from ~/.fhevm-wallet/.env
 */
export function listEnvVars(): Record<string, string> {
  if (!existsSync(ENV_FILE_PATH)) {
    return {};
  }

  const content = readFileSync(ENV_FILE_PATH, 'utf-8');
  const lines = content.split('\n');
  const result: Record<string, string> = {};

  for (const line of lines) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      result[match[1]] = match[2];
    }
  }

  return result;
}
