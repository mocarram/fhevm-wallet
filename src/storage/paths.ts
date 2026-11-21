/**
 * Centralized path configuration and the user's private `.env` file.
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { config as dotenvConfig, parse as dotenvParse } from 'dotenv';
import {
  ensureSecureDir,
  isSharedLocation,
  tightenPermissions,
  writeSecureFile,
} from './secureFs.js';
import { validateRpcUrl } from '../utils/validation.js';

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
 * Everything the wallet creates inside the data dir, relative to it. Startup tightening
 * touches only these (plus the dir itself), never anything else the user keeps there.
 * Keep in sync with the stores: a new store file belongs in this list.
 */
export const WALLET_DATA_ENTRIES = [
  'wallets',
  '.env',
  'audit.log',
  'config.json',
  'tokens.json',
  'addressbook.json',
  'transactions.json',
  'balance-cache.json',
] as const;

/** Outcome of the startup permission check, for one short stderr notice. */
export interface DataDirSecurity {
  /** Paths (folders and files) whose group/other access was removed. */
  tightened: number;
  /** A sentence to show the user when something could not be secured, else null. */
  warning: string | null;
}

/**
 * Tighten permissions on data written by older versions (which used the default umask),
 * and explain once when the data dir cannot be made private.
 */
export function secureExistingData(): DataDirSecurity {
  if (isSharedLocation(DATA_DIR)) {
    return {
      tightened: 0,
      warning: `FHEVM_WALLET_HOME points at ${DATA_DIR}, a shared folder (home, current folder or root). The wallet will not change its permissions. Point it at a dedicated folder.`,
    };
  }
  const tightened = tightenPermissions(DATA_DIR, WALLET_DATA_ENTRIES).length;
  let warning: string | null = null;
  try {
    const st = statSync(DATA_DIR);
    // Writable but not ours (a Docker volume created by root, say): chmod is refused,
    // so other users may still be able to list it.
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      warning = `The wallet data folder ${DATA_DIR} belongs to another user, so its permissions cannot be restricted. Give it to your user (chown) to keep it private.`;
    }
  } catch {
    /* missing dir: nothing to warn about */
  }
  return { tightened, warning };
}

/**
 * The only settings a `.env` in the *current directory* may provide: the ones the
 * development guide documents. A folder you merely `cd` into (a cloned repository, say)
 * must not be able to switch on debug output, swap the backend for a mock (FHEW_BACKEND,
 * Phase 3), move the data dir or set Node options. Anything else in ./.env is ignored.
 * Values already in the environment always win.
 */
export const CWD_ENV_ALLOWED_KEYS = [
  'SEPOLIA_RPC_URL',
  'MAINNET_RPC_URL',
  'ETHERSCAN_API_KEY',
  'ZAMA_MAINNET_API_KEY',
] as const;

/** What `loadEnv` took from ./.env, so startup can say so (RPC URLs change behaviour). */
export interface LoadEnvResult {
  /** Keys taken from ./.env and in effect. */
  fromCwd: string[];
  /** Keys in ./.env that are not on the allow-list. */
  ignoredFromCwd: string[];
  /** Allow-listed RPC URLs in ./.env that failed validation, with the reason. */
  rejectedFromCwd: { key: string; reason: string }[];
}

/** Keys whose value in process.env came from ./.env (set by `loadEnv`). */
const keysFromCwd = new Set<string>();

/** Where a setting's value in effect comes from, for `fhew config --show`. */
export type SettingSource = 'settings' | 'cwd' | 'environment';

/**
 * Where the value of `key` in process.env comes from: the data dir's .env ("settings",
 * which overrides everything), ./.env, or the process environment. Null when unset.
 */
export function settingSource(key: string): SettingSource | null {
  if (getEnvVar(key) !== undefined) return 'settings';
  if (!process.env[key]) return null;
  return keysFromCwd.has(key) ? 'cwd' : 'environment';
}

/**
 * Load settings from the data dir's private `.env` (any key: it is the user's own
 * owner-only file, and it overrides everything) and the allow-listed keys from a `.env`
 * in the current directory (never overriding the environment).
 */
export function loadEnv(cwdEnvPath = resolve('.env')): LoadEnvResult {
  const result: LoadEnvResult = { fromCwd: [], ignoredFromCwd: [], rejectedFromCwd: [] };
  if (existsSync(cwdEnvPath) && resolve(cwdEnvPath) !== ENV_FILE_PATH) {
    let parsed: Record<string, string> = {};
    try {
      parsed = dotenvParse(readFileSync(cwdEnvPath));
    } catch {
      /* unreadable ./.env: ignore it, like a missing one */
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!(CWD_ENV_ALLOWED_KEYS as readonly string[]).includes(key)) {
        result.ignoredFromCwd.push(key);
        continue;
      }
      if (process.env[key] !== undefined || value === '') continue;
      // A folder's .env must not point the wallet at, say, a plain-http remote RPC.
      const problem = key.endsWith('_RPC_URL') ? validateRpcUrl(value) : null;
      if (problem) {
        result.rejectedFromCwd.push({ key, reason: problem });
        continue;
      }
      process.env[key] = value;
      keysFromCwd.add(key);
      result.fromCwd.push(key);
    }
  }

  ensureDataDir();
  // An existing folder we may not write to (another user's, or read-only) would only
  // fail later, mid-command, with a raw EACCES. Fail now, so startup can say it plainly.
  accessSync(DATA_DIR, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  if (existsSync(ENV_FILE_PATH)) {
    // quiet: dotenv 17+ otherwise prints a promotional line to stdout.
    const loaded = dotenvConfig({ path: ENV_FILE_PATH, override: true, quiet: true });
    // The saved settings win over ./.env: don't claim ./.env is in use for those keys.
    const saved = Object.keys(loaded.parsed ?? {});
    result.fromCwd = result.fromCwd.filter((k) => !saved.includes(k));
    saved.forEach((k) => keysFromCwd.delete(k));
  }
  return result;
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
