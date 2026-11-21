#!/usr/bin/env node

/**
 * fhEVM Wallet CLI - Entry Point
 *
 * A CLI wallet for managing encrypted ERC-7984 tokens using Zama's FHE technology.
 */

// Must be imported before loadEnv() runs: it captures FHEW_BACKEND and FHEVM_WALLET_HOME
// from the launch environment, so a .env file can never switch to (or away from) the mock.
import {
  assertCommandSupportsMock,
  assertNotMockDataDir,
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
    assertCommandSupportsMock(process.argv);
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

import { createProgram, runInteractiveMode } from './cli/index.js';
import { describeError, safeText } from './cli/utils/userError.js';
import { clearProviderCache } from './core/network/ProviderFactory.js';

// Last line of defence: an error no command caught must not print its raw message or
// stack, which for ethers errors includes the RPC URL and its API key.
// Providers are left alone here: a stray rejection (a background poll, say) can arrive
// while a command is still using them. The post-command exit timer ends the process.
const failSafely = (err: unknown): void => {
  process.stderr.write(`Error: ${describeError(err)}\n`);
  process.exitCode = 1;
};
process.on('unhandledRejection', failSafely);
process.on('uncaughtException', (err) => {
  failSafely(err);
  clearProviderCache();
  process.exit(1); // state is unknown after an uncaught exception: stop
});

/** How long a finished one-shot command may linger on open sockets before we exit. */
const EXIT_GRACE_MS = 1_000;

/**
 * Resolve once everything written to stdout and stderr has been handed to the OS. An
 * empty write's callback runs after the writes queued before it.
 */
function flushOutput(): Promise<void> {
  const flush = (stream: NodeJS.WriteStream) =>
    new Promise<void>((done) => {
      if (stream.destroyed || !stream.writable) return done();
      stream.write('', () => done());
    });
  return Promise.all([flush(process.stdout), flush(process.stderr)]).then(() => undefined);
}

const program = createProgram();

// No arguments: launch the interactive terminal UI.
if (process.argv.length <= 2) {
  runInteractiveMode().catch(failSafely);
} else {
  program
    .parseAsync(process.argv)
    .catch(failSafely)
    .finally(() => {
      // The command has printed its result. Relayer SDK requests take no AbortSignal, so
      // one that timed out (see withTimeout) can keep a socket open for minutes. After a
      // short grace, wait for stdout and stderr to drain (a pipe into `less` on macOS
      // is asynchronous and would be cut off), then exit with the code the command set.
      // unref: a process that is already done exits at once, without waiting for this.
      setTimeout(() => {
        void flushOutput().then(() => process.exit());
      }, EXIT_GRACE_MS).unref();
    });
}
