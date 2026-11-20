/**
 * Owner-only file storage for wallet data.
 *
 * Keystores, API keys and the address book used to be written with the process umask
 * (typically 0644 / 0755: readable by every local user). Everything under the data
 * directory now goes through these helpers:
 *
 * - directories are 0700, files 0600;
 * - writes are atomic (temp file in the same directory, then rename), so a crash
 *   mid-write never leaves a truncated keystore or config behind.
 *
 * On Windows `chmod` only toggles the read-only bit; the calls are harmless there.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  lstatSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { dirname, join, parse, resolve } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Group and other permission bits: what tightening removes. Owner bits are kept. */
const GROUP_OTHER_BITS = 0o077;

/** Resolve symlinks where possible, so `~/link-to-home` is recognised as home. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True for folders the wallet must never chmod even if FHEVM_WALLET_HOME points there:
 * the user's home, the current directory and the filesystem root. Making those 0700
 * would break other programs (a web server's home, a shared project folder).
 */
export function isSharedLocation(dir: string): boolean {
  const target = canonical(dir);
  const shared = [homedir(), process.cwd(), parse(target).root].map(canonical);
  return shared.includes(target);
}

/** chmod that tolerates "not yours to change" (a volume created by root, say). */
function chmodIfPermitted(path: string, mode: number): boolean {
  try {
    chmodSync(path, mode);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return false;
    throw err;
  }
}

/**
 * Create `dir` (and parents) if missing and make sure it is owner-only.
 *
 * Does not chmod a shared location (see `isSharedLocation`), and does not fail when the
 * folder belongs to another user but is still writable: writes then still work and the
 * files we create are ours (and 0600). Startup warns about that case once.
 */
export function ensureSecureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  if (isSharedLocation(dir)) return;
  chmodIfPermitted(dir, DIR_MODE);
}

/**
 * Atomically write `data` to `path` with mode 0600.
 *
 * The temp file is created with 0600 from the start (never briefly world-readable),
 * flushed to disk, then renamed over the target. rename() is atomic on the same
 * filesystem, so readers see either the old or the new file, never a partial one.
 */
export function writeSecureFile(path: string, data: string): void {
  const dir = dirname(path);
  ensureSecureDir(dir);

  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', FILE_MODE);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmp, path);
  } catch (err) {
    // Don't leave temp files around if the rename fails (e.g. target is a directory).
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
  // rename keeps the temp file's mode, but be explicit in case the target pre-existed.
  chmodSync(path, FILE_MODE);
}

/**
 * Append to an owner-only file (used by the audit log). Refuses a symlink at `path`:
 * appending through one would write wallet events into whatever file it points at.
 *
 * O_NOFOLLOW makes that check part of the open itself, so there is no window between
 * "is it a link?" and the write (and a dangling link is refused too, instead of creating
 * its target). Windows has no O_NOFOLLOW; there the lstat check below is all we have.
 */
export function appendSecureFile(path: string, data: string): void {
  ensureSecureDir(dirname(path));
  if (existsSync(path) || isDanglingLink(path)) {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Refusing to write through a symbolic link: ${path}`);
    }
  }
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    (fsConstants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags, FILE_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Refusing to write through a symbolic link: ${path}`);
    }
    throw err;
  }
  try {
    // An existing file keeps its old mode on open; fix it through the descriptor.
    fchmodSync(fd, FILE_MODE);
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** True if `path` is a symlink whose target does not exist (existsSync says false). */
function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Create a new owner-only file at a path the user chose (an export, say).
 *
 * Unlike `writeSecureFile` this never touches the parent directory's permissions (it is
 * the user's folder, not ours) and never replaces an existing file: the exclusive `wx`
 * open fails if anything, including a symlink, is already there. That check is atomic,
 * so there is no window between "does it exist?" and the write.
 */
export function writeNewPrivateFile(path: string, data: string): void {
  const fd = openSync(path, 'wx', FILE_MODE);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
    throw err;
  }
  closeSync(fd);
}

/**
 * Remove group/other access from the data dir and the paths the wallet itself creates.
 * Returns the paths that were changed so the caller can tell the user once.
 * Used at startup to fix data written by older versions.
 *
 * Deliberately narrow, because FHEVM_WALLET_HOME can point at a folder that also holds
 * other things:
 * - only `root` and the listed `entries` (relative to it) are touched; a listed directory
 *   also gets its direct children (the keystores in wallets/), nothing deeper;
 * - only group/other bits are cleared: owner bits stay as they are, so an executable
 *   keeps its x bit and a read-only file stays read-only;
 * - nothing happens at all when `root` is a shared location (home, cwd, /);
 * - symlinks inside `root` are skipped (chmod would change their target), while `root`
 *   itself is followed (the data dir may live on another disk);
 * - entries that cannot be changed (owned by someone else) are skipped, so a stray file
 *   never stops the wallet from starting.
 */
export function tightenPermissions(root: string, entries: readonly string[]): string[] {
  if (!existsSync(root) || process.platform === 'win32' || isSharedLocation(root)) return [];
  const changed: string[] = [];

  const tighten = (path: string, follow: boolean): ReturnType<typeof statSync> | null => {
    let st;
    try {
      st = follow ? statSync(path) : lstatSync(path);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return null;
    if (!st.isDirectory() && !st.isFile()) return null; // sockets, fifos: leave alone
    if ((st.mode & GROUP_OTHER_BITS) !== 0) {
      if (chmodIfPermitted(path, st.mode & 0o7700 & ~GROUP_OTHER_BITS)) changed.push(path);
    }
    return st;
  };

  tighten(root, true);
  for (const entry of entries) {
    const path = join(root, entry);
    const st = tighten(path, false);
    if (st?.isDirectory()) {
      let children: string[] = [];
      try {
        children = readdirSync(path);
      } catch {
        continue;
      }
      for (const child of children) tighten(join(path, child), false);
    }
  }
  return changed;
}
