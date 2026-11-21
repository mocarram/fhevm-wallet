/**
 * fhEVM Wallet CLI: commands and the interactive UI, loaded by `index.ts` after the
 * start-up checks in `startup.ts` passed.
 *
 * A CLI wallet for managing encrypted ERC-7984 tokens using Zama's FHE technology.
 */

import { createProgram, runInteractiveMode } from './cli/index.js';
import { describeError } from './cli/utils/userError.js';
import { clearProviderCache } from './core/network/ProviderFactory.js';
import { withDefaultCommand } from './cli/utils/networkOption.js';

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
    .parseAsync([...process.argv.slice(0, 2), ...withDefaultCommand(process.argv.slice(2))])
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
