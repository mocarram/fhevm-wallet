/**
 * Centralized path configuration and the user's private `.env` file.
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { config as dotenvConfig } from 'dotenv';
import { ensureSecureDir, tightenPermissions, writeSecureFile } from './secureFs.js';

/**
 * Root data directory.
 *
 * Defaults to `~/.fhevm-wallet`. `FHEVM_WALLET_HOME` overrides it, which Docker uses to
 * point at a mounted volume (and tests use for isolation). Resolved once at import time;
 * set the variable before the process starts.
 */
export const DATA_DIR = process.env.FHEVM_WALLET_HOME
  ? resolve(process.env.FHEVM_WALLET_HOME)
  : join(homedir(), '.fhevm-wallet');

/** Path to the private `.env` file in the data directory. */
export const ENV_FILE_PATH = join(DATA_DIR, '.env');

/** Ensure the data directory exists and is owner-only (0700). */
export function ensureDataDir(): void {
  ensureSecureDir(DATA_DIR);
}

/**
 * Tighten permissions on data written by older versions (which used the default umask).
 * Returns how many paths were fixed so the UI can mention it once.
 */
export function secureExistingData(): number {
  return tightenPermissions(DATA_DIR).length;
}

/**
 * Load environment variables from .env files.
 * Priority: ~/.fhevm-wallet/.env overrides ./.env in the current directory.
 * `quiet: true` stops dotenv 17+ printing a promotional line to stdout, which would
 * corrupt machine-readable output.
 */
export function loadEnv(): void {
  dotenvConfig({ quiet: true });

  ensureDataDir();
  if (existsSync(ENV_FILE_PATH)) {
    dotenvConfig({ path: ENV_FILE_PATH, override: true, quiet: true });
  }
}

/** Variable names we accept: upper-case, digits and underscores. */
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
/**
 * Values are written unquoted, so we only accept characters dotenv reads back verbatim.
 * This rules out newlines (which could inject extra variables), quotes, backslashes,
 * `#` (comment start) and whitespace. URLs and API keys fit comfortably.
 */
const ENV_VALUE_RE = /^[^\s"'`\\#]*$/;

/** Throw a clear error if `key`/`value` cannot be stored safely. */
export function assertSafeEnvEntry(key: string, value: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(`Invalid setting name "${key}"`);
  }
  if (!ENV_VALUE_RE.test(value)) {
    throw new Error('Value contains spaces, quotes, # or line breaks, which are not allowed');
  }
}

/** Read the .env file as lines (empty array if missing). */
function readEnvLines(): string[] {
  if (!existsSync(ENV_FILE_PATH)) return [];
  return readFileSync(ENV_FILE_PATH, 'utf-8').split('\n');
}

/** Write lines back with exactly one trailing newline (or an empty file). */
function writeEnvLines(lines: string[]): void {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  writeSecureFile(ENV_FILE_PATH, trimmed.length > 0 ? trimmed.join('\n') + '\n' : '');
}

/**
 * Save or update a variable in ~/.fhevm-wallet/.env (created 0600 if missing)
 * and apply it to process.env immediately.
 */
export function saveEnvVar(key: string, value: string): void {
  assertSafeEnvEntry(key, value);
  ensureDataDir();

  const prefix = `${key}=`;
  let found = false;
  const lines = readEnvLines().map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${key}=${value}`);
  }

  writeEnvLines(lines);
  process.env[key] = value;
}

/** Strip one layer of matching quotes, for files edited by hand. */
function unquote(value: string): string {
  const m = value.match(/^(["'])(.*)\1$/);
  return m ? m[2] : value;
}

/**
 * Get a variable from ~/.fhevm-wallet/.env directly
 * (not from process.env, which may include values from other sources).
 */
export function getEnvVar(key: string): string | undefined {
  const prefix = `${key}=`;
  const line = readEnvLines().find((l) => l.startsWith(prefix));
  return line === undefined ? undefined : unquote(line.slice(prefix.length));
}

/** Remove a variable from ~/.fhevm-wallet/.env and from process.env. */
export function removeEnvVar(key: string): boolean {
  const prefix = `${key}=`;
  const lines = readEnvLines();
  const kept = lines.filter((l) => !l.startsWith(prefix));
  if (kept.length === lines.length) return false;

  writeEnvLines(kept);
  delete process.env[key];
  return true;
}

/** List all variables in ~/.fhevm-wallet/.env. */
export function listEnvVars(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readEnvLines()) {
    const match = line.match(/^([^=#\s][^=]*)=(.*)$/);
    if (match) result[match[1]] = unquote(match[2]);
  }
  return result;
}
