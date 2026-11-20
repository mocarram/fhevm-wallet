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
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  lstatSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Create `dir` (and parents) if missing and make sure it is owner-only. */
export function ensureSecureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  chmodSync(dir, DIR_MODE);
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
 */
export function appendSecureFile(path: string, data: string): void {
  ensureSecureDir(dirname(path));
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing to write through a symbolic link: ${path}`);
  }
  appendFileSync(path, data, { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
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
 * Walk `root` and remove group/other access: directories become 0700, files 0600.
 * Returns the paths that were changed so the caller can tell the user once.
 * Used at startup to fix data written by older versions.
 *
 * `root` itself is followed if it is a symlink (the user may keep the data dir on another
 * disk), but links *inside* it are skipped: chmod would change the link target, possibly
 * a file outside the data dir. Errors on single entries (a file owned by another user,
 * say) are skipped too, so a stray file can never stop the wallet from starting.
 */
export function tightenPermissions(root: string): string[] {
  if (!existsSync(root) || process.platform === 'win32') return [];
  const changed: string[] = [];

  const visit = (path: string, isRoot: boolean): void => {
    let st;
    try {
      st = isRoot ? statSync(path) : lstatSync(path);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (!st.isDirectory() && !st.isFile()) return; // sockets, fifos: leave alone
    if ((st.mode & 0o077) !== 0) {
      try {
        chmodSync(path, st.isDirectory() ? DIR_MODE : FILE_MODE);
        changed.push(path);
      } catch {
        // Not ours to change; carry on with the rest.
      }
    }
    if (st.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = readdirSync(path);
      } catch {
        return;
      }
      for (const entry of entries) visit(join(path, entry), false);
    }
  };

  visit(root, true);
  return changed;
}
