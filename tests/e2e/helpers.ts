/**
 * Helpers for running the built CLI in an isolated home directory.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

export const CLI = resolve(__dirname, '../../dist/index.js');

/** Create an isolated HOME for one test; returns it and a cleanup function. */
export function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'fhew-e2e-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Run the CLI synchronously and capture its output. */
export function runCli(args: string[], home: string, env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, NO_COLOR: '1', ...env },
    encoding: 'utf-8',
    timeout: 30000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
