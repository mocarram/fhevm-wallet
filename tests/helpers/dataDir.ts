import { existsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function getTestDataDir(): string {
  return join(homedir(), '.fhevm-wallet');
}

export function wipeTestDataDir(): void {
  const dir = getTestDataDir();
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
