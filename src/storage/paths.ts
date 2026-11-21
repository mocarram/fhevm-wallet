/**
 * Centralized path configuration and the user's private `.env` file.
 */

import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir, userInfo } from 'os';
import { parse as dotenvParse } from 'dotenv';
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

/** A store file moved aside because it could not be read (`src/storage/jsonStore.ts`). */
const CORRUPT_FILE_RE = /^[a-z-]+\.json\.corrupt-\d{8}T\d{6}Z$/;

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
      (e) =>
        !(WALLET_DATA_ENTRIES as readonly string[]).includes(e) &&
        !TEMP_FILE_RE.test(e) &&
        !CORRUPT_FILE_RE.test(e),
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

/** Group and other write bits: someone else could change the file or folder. */
const OTHERS_WRITE = 0o022;
const GROUP_WRITE = 0o020;
const WORLD_WRITE = 0o002;
const STICKY = 0o1000;

/**
 * The first folder above `path` (up to /) that someone other than this user (or root)
 * could change, or null. Like sshd's StrictModes: whoever can write to a parent can
 * rename the data dir away and put their own in its place, keystores and RPC settings
 * included. A folder is untrusted when:
 *
 * - another (non-root) user owns it: the owner can always rename what is inside;
 * - anyone can write to it, unless it is sticky like /tmp (others cannot rename what
 *   they do not own);
 * - its group can write to it (not sticky), unless that group is the user's own private
 *   group (`isPrivateGroup`), which nobody else is in.
 */
export function untrustedAncestor(
  path: string,
  stat: (p: string) => { mode: number; uid?: number; gid?: number } = statSync,
  privateGroup: (gid: number, uid: number) => boolean = (gid, uid) => isPrivateGroup(gid, uid),
): string | null {
  const me = typeof process.getuid === 'function' ? process.getuid() : undefined;
  let dir: string;
  try {
    dir = realpathSync(path);
  } catch {
    dir = resolve(path); // not created yet: its parents are what matters
  }
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    let st: { mode: number; uid?: number; gid?: number };
    try {
      st = stat(dir);
    } catch {
      continue; // a parent that does not exist yet is created by the wallet, owner-only
    }
    const sticky = (st.mode & STICKY) !== 0;
    if (me !== undefined && st.uid !== undefined && st.uid !== 0 && st.uid !== me) return dir;
    if (sticky) continue;
    if ((st.mode & WORLD_WRITE) !== 0) return dir;
    if (
      (st.mode & GROUP_WRITE) !== 0 &&
      !(me !== undefined && st.gid !== undefined && privateGroup(st.gid, me))
    ) {
      return dir;
    }
  }
}

/** Where `isPrivateGroup` reads the account databases (tests pass their own text). */
export interface AccountFiles {
  group?: string;
  passwd?: string;
  username?: string;
}

function readOr(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * True when `gid` is the user's private group: named like the user, with no listed
 * members other than the user, and no other account using it as its primary group.
 * Many systems give each user such a group with a umask of 002, so older wallet files
 * could be group-writable without anyone else being able to write them. Unknown
 * (no /etc/group entry, say) is false: the wallet then keeps refusing.
 */
export function isPrivateGroup(gid: number, uid: number, files: AccountFiles = {}): boolean {
  let username = files.username;
  if (username === undefined) {
    try {
      username = userInfo().username;
    } catch {
      return false;
    }
  }
  const group = files.group ?? readOr('/etc/group');
  const passwd = files.passwd ?? readOr('/etc/passwd');
  const entry = group
    .split('\n')
    .map((l) => l.split(':'))
    .find((f) => f.length >= 4 && Number(f[2]) === gid && f[2] !== '');
  if (!entry || entry[0] !== username) return false;
  const members = entry[3].split(',').filter(Boolean);
  if (members.some((m) => m !== username)) return false;
  const others = passwd
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 4 && Number(f[3]) === gid && Number(f[2]) !== uid);
  return others.length === 0;
}

/**
 * Throw UntrustedDataDirError unless the data dir, `wallets/`, the keystores in it and
 * the wallet's own files (`WALLET_DATA_ENTRIES`) are all owned by the current user and
 * not writable by group or others, none of them is a symbolic link, and no folder above
 * the data dir is writable by everyone without the sticky bit.
 *
 * Checked before anything is tightened or read: a folder that *was* writable by others
 * may already hold a planted keystore or a `.env` pointing at an attacker's RPC, and
 * fixing the mode afterwards would hide that. The user checks and fixes it once.
 * The one exception: a group-writable item (not world-writable) owned by the user whose
 * group is the user's private group (see `isPrivateGroup`). Nobody else could have
 * written it, so its group write bit is removed and the path is returned.
 * Windows has no POSIX owners or modes, so there is nothing to check there.
 */
export function assertTrustedDataDir(files: AccountFiles = {}): string[] {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return [];
  const me = process.getuid();
  const fixMode = `chmod -R go-w ${DATA_DIR}`;
  const fixOwner = `sudo chown -R ${me} ${DATA_DIR}`;
  const ancestor = untrustedAncestor(DATA_DIR);
  if (ancestor) {
    throw new UntrustedDataDirError(
      `Other users can rename or replace folders inside ${ancestor}, which holds the wallet data folder ${DATA_DIR}, so the wallet will not load keys or settings from it. Move the data folder somewhere private (set FHEVM_WALLET_HOME), or make ${ancestor} yours or root's and writable only by its owner (chmod go-w ${ancestor}).`,
    );
  }
  const tightened: string[] = [];
  const privateGroups = new Map<number, boolean>();
  const check = (path: string, isDataDir: boolean) => {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return; // not there yet: the wallet creates it owner-only
    }
    // The data dir itself may be a link to another disk; everything inside may not.
    if (st.isSymbolicLink()) {
      if (!isDataDir) {
        throw new UntrustedDataDirError(
          `${path} is a symbolic link, so the wallet will not load keys or settings from ${DATA_DIR}. Replace the link with the real file or folder.`,
        );
      }
      st = statSync(path);
    }
    if (st.uid !== me) {
      throw new UntrustedDataDirError(
        `${path} belongs to another user, so the wallet will not load keys or settings from ${DATA_DIR}. If it is yours, check its contents, then take it back with: ${fixOwner}`,
      );
    }
    if ((st.mode & OTHERS_WRITE) !== 0) {
      const onlyGroup = (st.mode & WORLD_WRITE) === 0 && (st.mode & GROUP_WRITE) !== 0;
      if (onlyGroup) {
        if (!privateGroups.has(st.gid))
          privateGroups.set(st.gid, isPrivateGroup(st.gid, me, files));
        if (privateGroups.get(st.gid)) {
          chmodSync(path, st.mode & 0o7777 & ~GROUP_WRITE);
          tightened.push(path);
          return;
        }
      }
      throw new UntrustedDataDirError(
        `Other users can change ${path}, so the wallet will not load keys or settings from ${DATA_DIR}. Check that nothing in it was added or changed by someone else, then remove that access with: ${fixMode}`,
      );
    }
  };
  check(DATA_DIR, true);
  for (const entry of WALLET_DATA_ENTRIES) check(join(DATA_DIR, entry), false);
  const walletsDir = join(DATA_DIR, 'wallets');
  let children: string[] = [];
  try {
    children = readdirSync(walletsDir);
  } catch {
    /* no wallets yet */
  }
  for (const child of children) check(join(walletsDir, child), false);
  return tightened;
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
  'amount-cache.json',
  'ui-prefs.json',
  'token-lists.json',
  'scan-state.json',
  '.fhew-mock',
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
 * UntrustedDataDirError (before changing anything) when the data is not the user's alone.
 */
export function secureExistingData(): DataDirSecurity {
  const policy = getDataDirPolicy();
  // Refuse first, before ensureDataDir's chmod: never tighten (and so hide) what other
  // users could have changed.
  let fixedGroupWrite: string[];
  try {
    fixedGroupWrite = assertTrustedDataDir();
  } catch (err) {
    // Say first why the wallet would not have changed the folder itself.
    if (err instanceof UntrustedDataDirError && policy.reason) {
      throw new UntrustedDataDirError(`${policy.reason}\n${err.message}`);
    }
    throw err;
  }
  ensureDataDir();
  // Only read bits are left to fix here (0644 files and 0755 folders from older versions).
  const tightened =
    fixedGroupWrite.length +
    (policy.ours || policy.sharedWithOtherFiles
      ? tightenPermissions(DATA_DIR, WALLET_DATA_ENTRIES, { includeRoot: policy.ours }).length
      : 0);
  return { tightened, warning: policy.reason };
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

/**
 * The only settings the data dir's own `.env` may provide: what the wallet itself saves
 * there (`fhew config`, the Settings screens). A stale or planted line such as
 * FHEW_BACKEND, FHEW_DEBUG, FHEVM_WALLET_HOME or NODE_OPTIONS is ignored with a notice:
 * those only ever come from the real process environment.
 */
export const SAVED_ENV_KEYS = CWD_ENV_ALLOWED_KEYS;

/** What `loadEnv` took from ./.env, so startup can say so (RPC URLs change behaviour). */
export interface LoadEnvResult {
  /** Keys taken from ./.env and in effect. */
  fromCwd: string[];
  /** Keys in ./.env that are not on the allow-list. */
  ignoredFromCwd: string[];
  /** Allow-listed RPC URLs in ./.env that failed validation, with the reason. */
  rejectedFromCwd: { key: string; reason: string }[];
  /** Keys in the data dir's .env that are not settings the wallet saves. */
  ignoredFromSettings: string[];
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
 * Load settings from the data dir's private `.env` (only `SAVED_ENV_KEYS`; they override
 * everything) and the allow-listed keys from a `.env` in the current directory (never
 * overriding the environment).
 */
export function loadEnv(cwdEnvPath = resolve('.env')): LoadEnvResult {
  const result: LoadEnvResult = {
    fromCwd: [],
    ignoredFromCwd: [],
    rejectedFromCwd: [],
    ignoredFromSettings: [],
  };
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
    let parsed: Record<string, string> = {};
    try {
      parsed = dotenvParse(readFileSync(ENV_FILE_PATH));
    } catch {
      /* unreadable: like a missing one */
    }
    // Saved settings override everything, but only the ones the wallet saves.
    const saved: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (!(SAVED_ENV_KEYS as readonly string[]).includes(key)) {
        result.ignoredFromSettings.push(key);
        continue;
      }
      process.env[key] = value;
      saved.push(key);
    }
    // The saved settings win over ./.env: don't claim ./.env is in use for those keys.
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
