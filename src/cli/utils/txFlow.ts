/**
 * Shared pieces of the one-shot CLI commands that sign something other than a transfer
 * (`fhew operator set|revoke`, `fhew disclose`): pick the wallet and token, unlock, and
 * the send-safety tail (summary with fee → explicit confirm or --yes → sign and
 * broadcast → SENT_UNCONFIRMED keeps the hash, never "try again").
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
import { walletPassword } from './passwordInput.js';
import { prompts } from './prompts.js';
import { describeError } from './userError.js';

/** Print an error and mark the command as failed. */
export function fail(message: string): void {
  process.exitCode = 1;
  console.log(error(message));
}

/** The network from `-n`, or the default. Null (and an error printed) when invalid. */
export function pickNetwork(option?: string): NetworkName | null {
  if (!option) return getDefaultNetwork();
  if (!isValidNetwork(option)) {
    fail('Invalid network. Use "sepolia" or "mainnet"');
    return null;
  }
  return option;
}

/** A tracked token by symbol or address, the only one, or null (error printed). */
export function pickToken(network: NetworkName, text?: string): TokenEntry | null {
  const tokens = listTokens(network);
  if (!tokens.length) {
    fail(`No tokens tracked on ${network}. Add one with: fhevm-wallet token add <address>`);
    return null;
  }
  if (!text) {
    if (tokens.length === 1) return tokens[0];
    fail(
      `Several tokens are tracked. Pick one with --token (${tokens.map((t) => t.symbol).join(', ')}).`,
    );
    return null;
  }
  const r = resolveToken(text, tokens);
  if (!r.ok) {
    fail(r.error);
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
  const password = await walletPassword(passwordStdin);
  const spin = ora('Decrypting wallet...').start();
  try {
    const w = await loadWallet(name, password, network);
    spin.succeed('Wallet loaded');
    return w;
  } catch (err) {
    spin.fail('Failed to decrypt wallet');
    fail(describeError(err, 'Invalid password'));
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
    fail(formatTxError(translateTxError(err)));
    return null;
  }
}

/**
 * Show the summary and fee, ask for an explicit confirmation (or take --yes; without a
 * terminal --yes is required), then sign, broadcast and wait. Returns the hash, or null
 * when cancelled or failed (the error, with the hash once broadcast, is printed).
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
}): Promise<string | null> {
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
      fail('Nothing was sent: confirm in a terminal, or pass --yes to go ahead without asking.');
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
    console.log(`  Transaction: ${r.txHash}`);
    console.log(`  Explorer:    ${backend.explorerTxUrl(r.txHash, network)}`);
    return r.txHash;
  } catch (err) {
    const e = translateTxError(err);
    if (e.code === 'SENT_UNCONFIRMED') spin.warn('Sent, not confirmed yet');
    else if (e.code === 'TX_REPLACED') spin.warn('Transaction replaced');
    else spin.fail(e.code === 'TX_REVERTED' ? 'Transaction reverted' : 'Transaction failed');
    fail(formatTxError(e));
    return null;
  }
}
