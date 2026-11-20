import { existsSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join, resolve } from 'path';

export function getTestDataDir(): string {
  return join(homedir(), '.fhevm-wallet');
}

/**
 * Delete the test data dir. Refuses unless HOME was redirected to a temp directory by
 * tests/helpers/setup.ts, so a test run without that setup can never wipe real keystores.
 */
export function wipeTestDataDir(): void {
  const home = resolve(homedir());
  const safe =
    home.startsWith(resolve(tmpdir())) && basename(home).startsWith('fhevm-wallet-tests-');
  if (!safe) {
    throw new Error(`Refusing to wipe ${getTestDataDir()}: HOME is not a test temp directory`);
  }
  const dir = getTestDataDir();
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
