/**
 * Start-up checks every command runs first, `--version` included: an unknown
 * FHEW_BACKEND, the data folder's trust and permissions, the mock/real separation and
 * the settings files. Runs on import (from `index.ts`). Only light modules here: the
 * commands and their dependencies (ethers, the relayer SDK) load afterwards, in
 * `main.ts`, so a failing check or `--version` costs little.
 */

// Must be imported before loadEnv() runs: it captures FHEW_BACKEND and FHEVM_WALLET_HOME
// from the launch environment, so a .env file can never switch to (or away from) the mock.
import {
  assertCommandSupportsMock,
  assertNotMockDataDir,
  commandName,
  MockDataDirError,
  prepareMockDataDir,
  unknownBackendProblem,
  wantsMock,
} from './core/backend/mockGuard.js';
import {
  DATA_DIR,
  ENV_FILE_PATH,
  loadEnv,
  secureExistingData,
  UntrustedDataDirError,
} from './storage/paths.js';
import { takeInvalidRpcSettings } from './core/network/NetworkConfig.js';
import { applyNoColor } from './utils/formatting.js';
import { safeText } from './cli/utils/userError.js';

/** True for '' (no command), help, or a command or alias the program defines. */
async function isKnownCommand(name: string): Promise<boolean> {
  if (name === '' || name === 'help') return true;
  const { createProgram } = await import('./cli/index.js');
  return createProgram().commands.some((c) => c.name() === name || c.aliases().includes(name));
}

// Tables and messages honour NO_COLOR (chalk itself does not read it).
applyNoColor();

// A mistyped FHEW_BACKEND (say `mocks`) must stop every command before it starts:
// otherwise it would quietly run against the real network.
const backendProblem = unknownBackendProblem();
if (backendProblem) {
  process.stderr.write(`${backendProblem}\n`);
  process.exit(1);
}

// Load settings: the data dir's private .env, plus allow-listed keys from ./.env.
// Failing here (data dir not writable) gets one clear sentence, not a stack trace.
try {
  // Check and tighten the data dir before reading anything from it (its .env included).
  const { tightened, warning } = secureExistingData();
  // The mock and real wallet data never share a folder (see core/backend/mockGuard.ts).
  // Decided from the launch environment, after the trust check and before any .env file
  // is read.
  if (wantsMock()) {
    // An unknown command is left to commander ("unknown command"); it would not reach
    // the network either way, and "would use the real network" misled. The command list
    // is loaded only here, so the real backend's start-up stays light.
    const name = commandName(process.argv);
    if (await isKnownCommand(name)) assertCommandSupportsMock(process.argv);
    prepareMockDataDir();
  } else {
    assertNotMockDataDir();
  }
  const env = loadEnv();
  // A ./.env can point the wallet at another RPC: say where settings came from.
  if (env.fromCwd.length > 0) {
    process.stderr.write(`Using ${env.fromCwd.join(', ')} from ./.env in this folder.\n`);
  }
  if (env.ignoredFromSettings.length > 0) {
    process.stderr.write(
      `Ignored ${env.ignoredFromSettings.join(', ')} in ${ENV_FILE_PATH}: only RPC URLs and API keys are read from there. Set other options in your shell instead.\n`,
    );
  }
  // The same check for URLs from the environment or a hand-edited settings file.
  for (const { key, reason } of takeInvalidRpcSettings()) {
    process.stderr.write(`Ignored ${key}: ${reason} Using the default endpoints.\n`);
  }
  for (const { key, reason } of env.rejectedFromCwd) {
    process.stderr.write(`Ignored ${key} in ./.env: ${reason}\n`);
  }
  if (env.ignoredFromCwd.length > 0) {
    process.stderr.write(
      `Ignored ${env.ignoredFromCwd.join(', ')} in ./.env: only RPC URLs and API keys are read from there.\n`,
    );
  }

  // Older versions wrote wallet data with default (often world-readable) permissions.
  // They are fixed on every start; mention it on stderr so stdout stays scriptable.
  if (tightened > 0) {
    process.stderr.write(
      `Restricted ${tightened} wallet data item(s) (files or folders) to your user only.\n`,
    );
  }
  if (warning) process.stderr.write(`Warning: ${warning}\n`);
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  process.stderr.write(
    err instanceof UntrustedDataDirError || err instanceof MockDataDirError
      ? `${err.message}\n`
      : code === 'EACCES' || code === 'EPERM'
        ? `Cannot use the wallet data folder ${DATA_DIR}: permission denied. Make it writable by your user, or set FHEVM_WALLET_HOME to another folder.\n`
        : `Cannot open the wallet data folder ${DATA_DIR}: ${safeText(err instanceof Error ? err.message : String(err))}\n`,
  );
  process.exit(1);
}
