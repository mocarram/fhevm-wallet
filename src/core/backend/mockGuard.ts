/**
 * Keep the offline mock's simulated data and real wallet data apart.
 *
 * MockBackend writes simulated transfers, balances and tokens through the real storage.
 * Mixed into a real data folder they would read as real history (and feed "repeat last
 * send" or hide the first-time-recipient warning). So:
 *
 * - The backend choice and FHEVM_WALLET_HOME are read from the environment the process
 *   was started with (`LAUNCH_ENV`, captured when this module loads, before any `.env`
 *   file is applied), never from a settings file.
 * - The mock runs only in a folder marked as a mock folder by a `.fhew-mock` file. It
 *   creates the marker itself only in a folder that is missing or empty, and never in
 *   the default ~/.fhevm-wallet. Any folder that already holds data without the marker
 *   (a real wallet, a Docker /data volume) is refused, whatever its name or case.
 * - The marker tags everything in the folder as simulated: the real backend and every
 *   command refuse a marked folder, so mock records can never be mistaken for real ones.
 */

import { existsSync, mkdirSync, readdirSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { DATA_DIR, ensureDataDir } from '../../storage/paths.js';
import { writeNewPrivateFile } from '../../storage/secureFs.js';

/** The marker file that makes a data folder a mock folder. */
export const MOCK_MARKER = '.fhew-mock';

/** The settings that pick the backend, as the process was launched. */
export interface LaunchEnv {
  FHEW_BACKEND?: string;
  FHEVM_WALLET_HOME?: string;
}

/**
 * Captured at module load, which happens before `loadEnv()` runs in src/index.ts (ES
 * module imports are evaluated before the importing module's body). A `.env` file can
 * therefore never switch the backend or redirect the mock.
 */
export const LAUNCH_ENV: Readonly<LaunchEnv> = Object.freeze({
  FHEW_BACKEND: process.env.FHEW_BACKEND,
  FHEVM_WALLET_HOME: process.env.FHEVM_WALLET_HOME,
});

/** True when the process was launched with FHEW_BACKEND=mock. */
export function wantsMock(env: LaunchEnv = LAUNCH_ENV): boolean {
  return (env.FHEW_BACKEND ?? '').trim().toLowerCase() === 'mock';
}

/**
 * The refusal for an FHEW_BACKEND value other than unset, "real" or "mock", or null.
 * Checked at startup for every command, so a typo such as `mocks` can never fall back
 * to the real network while the user believes they are on the simulation.
 */
export function unknownBackendProblem(env: LaunchEnv = LAUNCH_ENV): string | null {
  const wanted = (env.FHEW_BACKEND ?? '').trim().toLowerCase();
  if (wanted === '' || wanted === 'real' || wanted === 'mock') return null;
  return `Unknown FHEW_BACKEND "${env.FHEW_BACKEND}". Use "real" or "mock", or unset it.`;
}

/** Thrown when the mock and a data folder must not be used together. */
export class MockDataDirError extends Error {
  readonly code = 'MOCK_DATA_DIR';
}

const ADVICE =
  'Use a separate, throwaway folder, for example: FHEW_BACKEND=mock FHEVM_WALLET_HOME=$(mktemp -d) fhew';

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Where things are, for tests. */
export interface GuardPaths {
  dataDir?: string;
  home?: string;
}

/**
 * Make sure the mock may run in the data folder, creating the marker in a new or empty
 * folder. Throws MockDataDirError otherwise.
 */
export function prepareMockDataDir(env: LaunchEnv = LAUNCH_ENV, paths: GuardPaths = {}): void {
  const dataDir = paths.dataDir ?? DATA_DIR;
  const home = paths.home ?? homedir();
  if (!env.FHEVM_WALLET_HOME?.trim()) {
    throw new MockDataDirError(
      `FHEW_BACKEND=mock needs FHEVM_WALLET_HOME: the offline mock writes simulated tokens, balances and history to the data folder. ${ADVICE}`,
    );
  }
  if (real(dataDir) === real(join(home, '.fhevm-wallet'))) {
    throw new MockDataDirError(
      `FHEVM_WALLET_HOME points at your real wallet folder, and the offline mock would mix simulated data into it. ${ADVICE}`,
    );
  }
  const marker = join(dataDir, MOCK_MARKER);
  if (existsSync(marker)) return;
  const entries = existsSync(dataDir) ? readdirSync(dataDir) : [];
  if (entries.length > 0) {
    throw new MockDataDirError(
      `${dataDir} already holds files and is not a mock folder, so the offline mock will not write simulated data into it. ${ADVICE}`,
    );
  }
  if (paths.dataDir === undefined) ensureDataDir();
  else mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeNewPrivateFile(
    marker,
    'This folder holds simulated data written by FHEW_BACKEND=mock (fhEVM Wallet).\nNothing in it is real. The wallet refuses to use it without FHEW_BACKEND=mock.\n',
  );
}

/** Refuse to use a mock folder for real funds (any command without FHEW_BACKEND=mock). */
export function assertNotMockDataDir(dataDir: string = DATA_DIR): void {
  if (existsSync(join(dataDir, MOCK_MARKER))) {
    throw new MockDataDirError(
      `${dataDir} holds simulated data from FHEW_BACKEND=mock, so the wallet will not use it for real funds. Set FHEW_BACKEND=mock to keep using it, or point FHEVM_WALLET_HOME at your real wallet folder.`,
    );
  }
}

/** Commands that honour FHEW_BACKEND=mock, or never touch the network. */
const MOCK_COMMANDS = new Set([
  '',
  'interactive',
  'i',
  'send',
  'wallet',
  'help',
  // These go through the Backend for every network call (Phase 4).
  'token',
  'doctor',
  'receive',
  'history',
  'operator',
  'disclose',
]);

/** The subcommand in `argv` (after the global `-n/--network` option), or '' for none. */
export function commandName(argv: string[]): string {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n' || a === '--network') {
      i++;
      continue;
    }
    if (a.startsWith('--network=')) continue;
    if (['-h', '--help', '-V', '--version'].includes(a)) return 'help';
    return a;
  }
  return '';
}

/**
 * With FHEW_BACKEND=mock, refuse commands that would silently use the real network
 * (`balance`, `config`): the user asked for a simulation. `MOCK_COMMANDS` lists the
 * ones that route every chain and relayer call through the Backend.
 */
export function assertCommandSupportsMock(argv: string[]): void {
  const cmd = commandName(argv);
  if (!MOCK_COMMANDS.has(cmd)) {
    throw new MockDataDirError(
      `FHEW_BACKEND=mock works with the interactive UI (fhew) and the send, token, doctor, receive, history, operator, disclose and wallet commands only; \`fhew ${cmd}\` would use the real network. Unset FHEW_BACKEND to run it.`,
    );
  }
}
