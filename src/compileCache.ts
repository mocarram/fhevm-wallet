/**
 * Node's on-disk compile cache (V8 code cache for our modules and dependencies), in a
 * folder only this user can use. A code cache is compiled code: anyone who could write
 * to it could make the wallet run their code, so it is enabled only when the folder is a
 * real directory (not a symlink) owned by this user with no group or other access, and
 * its parent is not writable by others. Anything unexpected and the cache stays off: it
 * is only an optimisation.
 *
 * The folder is outside the wallet data folder on purpose: that folder's contents are
 * checked strictly (and the mock backend runs only in an empty one).
 * `$XDG_CACHE_HOME/fhevm-wallet/compile-cache`, else `~/.cache/fhevm-wallet/compile-cache`.
 * `FHEW_NO_COMPILE_CACHE=1` turns it off.
 */

import { lstatSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { enableCompileCache } from 'module';

/** True when `dir` is a directory owned by us, not a symlink, with no group/other bits. */
function isPrivateDir(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    const uid = process.getuid?.();
    return (
      st.isDirectory() &&
      !st.isSymbolicLink() &&
      (uid === undefined || st.uid === uid) &&
      (st.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

/** True when nobody but us (or root) can write to `dir`. */
function notWritableByOthers(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    const uid = process.getuid?.();
    return (
      st.isDirectory() &&
      (st.mode & 0o022) === 0 &&
      (uid === undefined || st.uid === uid || st.uid === 0)
    );
  } catch {
    return false;
  }
}

/** The cache folder, or null when no suitable base folder is known. */
export function compileCacheDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.cache');
  return isAbsolute(base) ? join(base, 'fhevm-wallet', 'compile-cache') : null;
}

/**
 * Make `dir` (0700) if needed and say whether it is safe for a code cache: it and its
 * parent are private to us, and the folder above cannot be written by others.
 */
export function preparePrivateCacheDir(dir: string): boolean {
  try {
    const app = dirname(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return isPrivateDir(app) && isPrivateDir(dir) && notWritableByOthers(dirname(app));
  } catch {
    return false; // read-only home, odd permissions: start without the cache
  }
}

/** Turn the compile cache on when a private folder for it exists or can be made. */
export function enablePrivateCompileCache(): void {
  if (process.env.FHEW_NO_COMPILE_CACHE === '1' || process.platform === 'win32') return;
  const dir = compileCacheDir();
  if (!dir || !preparePrivateCacheDir(dir)) return;
  try {
    enableCompileCache(dir);
  } catch {
    /* an optimisation only */
  }
}
