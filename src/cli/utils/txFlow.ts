/**
 * Shared pieces of the one-shot CLI commands that sign something other than a transfer
 * (`fhew operator set|revoke`, `fhew disclose`): pick the wallet and token, unlock, and
 * the send-safety tail (summary with fee → explicit confirm or --yes → sign and
 * broadcast → SENT_UNCONFIRMED keeps the hash, never "try again").
 *
 * With `--json` (`startJsonOutput`) human output moves to stderr, `fail` prints
 * `{"error": {code, message}}` on stdout, and an error after the broadcast carries
 * `txHash` and `explorerUrl` (check those before trying again).
 */

import { formatEther } from 'ethers';
import ora from 'ora';
import type { Backend, PreparedTx, UnlockedSigner } from '../../core/backend/types.js';
import type { NetworkName } from '../../core/network/NetworkConfig.js';
import { resolveToken } from '../../core/send/resolve.js';
import { listTokens, type TokenEntry } from '../../core/token/TokenRegistry.js';
import { formatTxError, translateTxError } from '../../core/token/txErrors.js';
import { getWalletAddress, hasWallet, loadWallet } from '../../core/wallet/index.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import { error, formatNetworkName, warning } from '../../utils/formatting.js';
import { isValidNetwork } from '../../utils/validation.js';
import { MAINNET_GUARD_CODE, mainnetGuardProblem } from './mainnetGuard.js';
import { jsonErrorOf, printJson } from './json.js';
import {
  isWrongPassword,
  passwordStdinNeeded,
  walletPassword,
  wrongPasswordMessage,
} from './passwordInput.js';
import { prompts } from './prompts.js';
import { describeError } from './userError.js';

/** Set by `startJsonOutput`: errors go out as JSON on stdout. */
let jsonMode = false;

/**
 * Switch this command to `--json` output: console.log goes to stderr (summaries, notes),
 * so stdout carries only the JSON document. Returns the function that switches back.
 */
export function startJsonOutput(): () => void {
  jsonMode = true;
  const original = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  return () => {
    console.log = original;
    jsonMode = false;
  };
}

/** True while `--json` output is on (see `startJsonOutput`). */
export function isJsonOutput(): boolean {
  return jsonMode;
}

/**
 * Print an error and mark the command as failed. With --json: `{"error": {code, message,
 * ...extra}}` (extra holds `txHash`/`explorerUrl` once something was broadcast).
 */
export function fail(message: string, code = 'ERROR', extra: Record<string, string> = {}): void {
  process.exitCode = 1;
  if (jsonMode) printJson({ error: { code, message, ...extra } });
  else console.log(error(message));
}

/** `fail` for a caught error: the wallet's own code with --json, a translated message. */
export function failWith(err: unknown, fallback: string): void {
  if (jsonMode) {
    const e = jsonErrorOf(err, fallback);
    return fail(e.message, e.code);
  }
  fail(describeError(err, fallback));
}

/**
 * With --json nobody can answer a prompt: require `--yes` and `--password-stdin` up
 * front. False (and PROMPT_NOT_ALLOWED printed) when one is missing.
 */
export function jsonPromptsCovered(options: { yes?: boolean; passwordStdin?: boolean }): boolean {
  if (!jsonMode || (options.yes && options.passwordStdin)) return true;
  fail(
    'With --json, pass --yes and --password-stdin: there is nobody to answer prompts.',
    'PROMPT_NOT_ALLOWED',
  );
  return false;
}

/** The network from `-n`, or the default. Null (and an error printed) when invalid. */
export function pickNetwork(option?: string): NetworkName | null {
  if (!option) return getDefaultNetwork();
  if (!isValidNetwork(option)) {
    fail('Invalid network. Use "sepolia" or "mainnet"', 'INVALID_NETWORK');
    return null;
  }
  return option;
}

/**
 * The Mainnet rule of `fhew send` for any command that signs: without a confirmation
 * prompt (`--yes`, or no terminal), Mainnet needs `-n mainnet` and `--mainnet` on the
 * command line. False (and the refusal printed) when the command must stop. Call it
 * before reading the password, so a refused run never touches the key.
 */
export function mainnetAllowed(
  network: NetworkName,
  options: { network?: string; mainnet?: boolean; yes?: boolean },
  what: string,
): boolean {
  const problem = mainnetGuardProblem({
    network,
    networkOption: options.network,
    mainnetFlag: options.mainnet,
    willAsk: !options.yes && Boolean(process.stdin.isTTY),
    what,
  });
  if (!problem) return true;
  fail(problem, MAINNET_GUARD_CODE);
  return false;
}

/** A tracked token by symbol or address, the only one, or null (error printed). */
export function pickToken(network: NetworkName, text?: string): TokenEntry | null {
  const tokens = listTokens(network);
  if (!tokens.length) {
    fail(
      `No tokens tracked on ${network}. Add one with: fhevm-wallet token add <address>`,
      'NO_TOKENS',
    );
    return null;
  }
  if (!text) {
    if (tokens.length === 1) return tokens[0];
    fail(
      `Several tokens are tracked. Pick one with --token (${tokens.map((t) => t.symbol).join(', ')}).`,
      'TOKEN_AMBIGUOUS',
    );
    return null;
  }
  const r = resolveToken(text, tokens);
  if (!r.ok) {
    fail(r.error, 'TOKEN_NOT_TRACKED');
    return null;
  }
  return r.token;
}

/** Wallet name and address from `-w` or the default (no password needed). */
export function pickWallet(name?: string): { name: string; address: string } | null {
  const walletName = name || getDefaultWallet();
  if (!walletName || !hasWallet(walletName)) {
    fail(
      walletName
        ? `Wallet "${walletName}" not found`
        : 'No default wallet. Pass -w <name> or create one with: fhevm-wallet wallet create',
      walletName ? 'WALLET_NOT_FOUND' : 'NO_WALLET',
    );
    return null;
  }
  return { name: walletName, address: getWalletAddress(walletName)! };
}

/** Ask for the password (or read it from stdin) and decrypt the wallet. Null on failure. */
export async function unlockWallet(
  name: string,
  network: NetworkName,
  passwordStdin?: boolean,
): Promise<UnlockedSigner | null> {
  const noPassword = passwordStdinNeeded(passwordStdin);
  if (noPassword) {
    fail(noPassword, 'PASSWORD_STDIN_REQUIRED');
    return null;
  }
  const password = await walletPassword(passwordStdin);
  const spin = ora('Decrypting wallet...').start();
  try {
    const w = await loadWallet(name, password, network);
    spin.succeed('Wallet loaded');
    return w;
  } catch (err) {
    spin.fail('Failed to decrypt wallet');
    if (isWrongPassword(err)) fail(wrongPasswordMessage(name), 'WRONG_PASSWORD');
    else if (jsonMode)
      fail(jsonErrorOf(err, 'Could not decrypt the wallet').message, 'WALLET_UNLOCK_FAILED');
    else fail(describeError(err, 'Could not decrypt the wallet'));
    return null;
  }
}

/** Run a prepare step with a spinner; null (error printed) when it fails. */
export async function prepareWithSpinner<T>(
  text: string,
  run: () => Promise<T>,
): Promise<T | null> {
  const spin = ora(text).start();
  try {
    const r = await run();
    spin.succeed('Simulation passed');
    return r;
  } catch (err) {
    spin.fail('Stopped. Nothing was signed or sent.');
    const e = translateTxError(err);
    fail(formatTxError(e), e.code);
    return null;
  }
}

/** A transaction `confirmAndSend` saw confirmed. */
export interface SentTx {
  txHash: string;
  blockNumber: number;
  explorerUrl: string;
}

/**
 * Show the summary and fee, ask for an explicit confirmation (or take --yes; without a
 * terminal --yes is required), then sign, broadcast and wait. Returns the confirmed
 * transaction, or null when cancelled or failed (the error, with the hash once
 * broadcast, is printed). `extra` is added to a JSON error (e.g. an earlier step's hash).
 */
export async function confirmAndSend(opts: {
  backend: Backend;
  network: NetworkName;
  prepared: PreparedTx;
  title: string;
  lines: string[];
  warnings?: string[];
  yes?: boolean;
  question: string;
  extra?: Record<string, string>;
}): Promise<SentTx | null> {
  const { backend, network, prepared } = opts;
  console.log();
  console.log(opts.title);
  if (backend.kind === 'mock') console.log(warning('  MOCK: simulated, no real funds'));
  for (const l of opts.lines) console.log(`  ${l}`);
  console.log(`  Network: ${formatNetworkName(network)}`);
  console.log(
    `  Fee:     up to ${formatEther(prepared.feeWei)} ETH (you have ${formatEther(prepared.ethBalanceWei)} ETH)`,
  );
  for (const w of opts.warnings ?? []) console.log(warning(`  ${w}`));
  console.log();
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      fail(
        'Nothing was sent: confirm in a terminal, or pass --yes to go ahead without asking.',
        'PROMPT_NOT_ALLOWED',
      );
      return null;
    }
    const ok = await prompts.confirm({ message: opts.question, default: false });
    if (!ok) {
      console.log('Cancelled. Nothing was sent.');
      return null;
    }
  }
  const spin = ora('Sending transaction and waiting for confirmation...').start();
  try {
    const r = await prepared.send();
    spin.succeed('Transaction confirmed');
    const explorerUrl = backend.explorerTxUrl(r.txHash, network);
    console.log(`  Transaction: ${r.txHash}`);
    console.log(`  Explorer:    ${explorerUrl}`);
    return { txHash: r.txHash, blockNumber: r.blockNumber, explorerUrl };
  } catch (err) {
    const e = translateTxError(err);
    if (e.code === 'SENT_UNCONFIRMED') spin.warn('Sent, not confirmed yet');
    else if (e.code === 'TX_REPLACED') spin.warn('Transaction replaced');
    else spin.fail(e.code === 'TX_REVERTED' ? 'Transaction reverted' : 'Transaction failed');
    const extra: Record<string, string> = { ...opts.extra };
    if (e.txHash) {
      extra.txHash = e.txHash;
      extra.explorerUrl = backend.explorerTxUrl(e.txHash, network);
    }
    fail(formatTxError(e), e.code, extra);
    return null;
  }
}
