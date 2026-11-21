/**
 * Centralized path configuration and the user's private `.env` file.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { config as dotenvConfig, parse as dotenvParse } from 'dotenv';
import {
  ensureSecureDir,
  markNoChmod,
  markOwnDir,
  sharedLocationReason,
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

/** Whether the wallet may chmod the data dir itself; computed on first use. */
let dataDirPolicy: DataDirPolicy | null = null;

/** What the wallet may do with the data dir, and why not when it may not chmod it. */
export interface DataDirPolicy {
  /** The folder is the wallet's own: it may make it 0700. */
  ours: boolean;
  /** Why it is not, for the startup warning; null when it is. */
  reason: string | null;
  /** Only wallet files in it are tightened, never the folder itself or anything else. */
  sharedWithOtherFiles: boolean;
}

/** Temp files `writeSecureFile` leaves for a moment during an atomic write. */
const TEMP_FILE_RE = /^\.[0-9a-f]{12}\.tmp$/;

/**
 * Decide, once, whether the data dir is the wallet's to chmod. The default
 * `~/.fhevm-wallet` and a folder the wallet creates are. An existing folder named by
 * FHEVM_WALLET_HOME is only if it is not a shared location (home or above, temp, cwd,
 * root, a sticky folder) and holds nothing but files the wallet creates.
 */
export function getDataDirPolicy(): DataDirPolicy {
  if (dataDirPolicy) return dataDirPolicy;
  const own: DataDirPolicy = { ours: true, reason: null, sharedWithOtherFiles: false };
  if (!existsSync(DATA_DIR) || !process.env.FHEVM_WALLET_HOME) {
    markOwnDir(DATA_DIR); // ours even when it happens to be the current folder
    return (dataDirPolicy = own);
  }
  const shared = sharedLocationReason(DATA_DIR);
  if (shared) {
    markNoChmod(DATA_DIR);
    return (dataDirPolicy = {
      ours: false,
      reason: `FHEVM_WALLET_HOME points at ${DATA_DIR}, which is ${shared}. The wallet will not change its permissions. Point it at a dedicated folder.`,
      sharedWithOtherFiles: false,
    });
  }
  let foreign: string[] = [];
  try {
    foreign = readdirSync(DATA_DIR).filter(
      (e) => !(WALLET_DATA_ENTRIES as readonly string[]).includes(e) && !TEMP_FILE_RE.test(e),
    );
  } catch {
    /* unreadable: the access check reports it */
  }
  if (foreign.length > 0) {
    markNoChmod(DATA_DIR);
    return (dataDirPolicy = {
      ours: false,
      reason: `FHEVM_WALLET_HOME points at ${DATA_DIR}, which also holds files the wallet did not create, so the wallet only restricts its own files there. Point it at a dedicated folder to keep the folder itself private.`,
      sharedWithOtherFiles: true,
    });
  }
  return (dataDirPolicy = own);
}

/** Ensure the data directory exists and, when it is the wallet's own, is owner-only. */
export function ensureDataDir(): void {
  getDataDirPolicy(); // before the first chmod: decides whether there may be one
  ensureSecureDir(DATA_DIR);
}

/**
 * Thrown when the data dir (or wallets/) can be changed by other users. Anyone who can
 * write there can plant a keystore or a `.env` with their own RPC URL, so the wallet must
 * not load either.
 */
export class UntrustedDataDirError extends Error {
  readonly code = 'UNTRUSTED_DATA_DIR';
}

/** Throw UntrustedDataDirError if other users can write to the data dir or wallets/. */
export function assertTrustedDataDir(): void {
  if (process.platform === 'win32') return; // no POSIX modes to check
  for (const dir of [DATA_DIR, join(DATA_DIR, 'wallets')]) {
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue; // not there yet: the wallet creates it 0700
    }
    if ((st.mode & 0o022) !== 0) {
      const mine = typeof process.getuid !== 'function' || st.uid === process.getuid();
      throw new UntrustedDataDirError(
        `Other users can change the wallet data folder ${dir}${mine ? '' : ' (it belongs to another user)'}, so the wallet will not load keys or settings from it. Remove write access for group and others (chmod go-w), or set FHEVM_WALLET_HOME to a private folder.`,
      );
    }
  }
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
 * and explain once when the data dir cannot be made private. Throws
 * UntrustedDataDirError when other users can still write to it afterwards.
 */
export function secureExistingData(): DataDirSecurity {
  ensureDataDir();
  const policy = getDataDirPolicy();
  const tightened =
    policy.ours || policy.sharedWithOtherFiles
      ? tightenPermissions(DATA_DIR, WALLET_DATA_ENTRIES, { includeRoot: policy.ours }).length
      : 0;
  let warning = policy.reason;
  try {
    const st = statSync(DATA_DIR);
    // Ours to use but not ours to chmod (a Docker volume created by root, say).
    if (!warning && typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      warning = `The wallet data folder ${DATA_DIR} belongs to another user, so its permissions cannot be restricted. Give it to your user (chown) to keep it private.`;
    }
  } catch {
    /* missing dir: nothing to warn about */
  }
  try {
    assertTrustedDataDir();
  } catch (err) {
    // Say first why the wallet did not just fix the permissions itself.
    if (err instanceof UntrustedDataDirError && policy.reason) {
      throw new UntrustedDataDirError(`${policy.reason}\n${err.message}`);
    }
    throw err;
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
  // A .env others could have written would let them pick the RPC (and see the API keys).
  assertTrustedDataDir();
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
