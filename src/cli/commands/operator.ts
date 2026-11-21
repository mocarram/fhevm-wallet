/**
 * `fhew operator list|set|revoke`: ERC-7984 operators (there is no `approve`).
 *
 * An operator can move ALL of the holder's tokens until its expiry, so `set` takes an
 * explicit duration (1h, 1d, 7d, a date) and "forever" only after typing the word in a
 * terminal. Changes go through the send-safety flow (cli/utils/txFlow.ts).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createBackend } from '../../core/backend/select.js';
import {
  describeExpiry,
  FOREVER_CONFIRMATION,
  operatorWarning,
  parseOperatorExpiry,
} from '../../core/send/operatorExpiry.js';
import { resolveRecipient } from '../../core/send/resolve.js';
import { listAddresses } from '../../storage/AddressBook.js';
import { listTransactions } from '../../storage/TransactionStore.js';
import { bold, formatAddress } from '../../utils/formatting.js';
import { PASSWORD_STDIN_HELP } from '../utils/passwordInput.js';
import { prompts } from '../utils/prompts.js';
import { describeError } from '../utils/userError.js';
import {
  confirmAndSend,
  fail,
  pickNetwork,
  pickToken,
  pickWallet,
  prepareWithSpinner,
  unlockWallet,
} from '../utils/txFlow.js';

interface OperatorOptions {
  token?: string;
  wallet?: string;
  network?: string;
  for?: string;
  passwordStdin?: boolean;
  yes?: boolean;
}

/** Register `fhew operator`. */
export function registerOperatorCommands(program: Command): void {
  const op = program
    .command('operator')
    .description('View, grant or revoke ERC-7984 operators (who may move your tokens)');

  const common = (c: Command) =>
    c
      .option('-t, --token <token>', 'Token symbol or address (default: the only tracked token)')
      .option('-w, --wallet <name>', 'Wallet to use')
      .option('-n, --network <network>', 'Network (sepolia or mainnet)');

  common(
    op
      .command('list')
      .description('Show which contacts, recent addresses or given addresses are operators')
      .argument('[addresses...]', 'Addresses or contact names to check'),
  ).action(async (addresses: string[], options: OperatorOptions) => {
    try {
      await list(addresses, options);
    } catch (err) {
      fail(describeError(err, 'Could not check operators'));
    }
  });

  common(
    op
      .command('set')
      .description('Let an address move your tokens until an expiry')
      .argument('<operator>', 'Operator address or contact name')
      .requiredOption('--for <expiry>', 'How long: 1h, 1d, 7d, 2w, a date (2026-12-01) or forever')
      .option('--password-stdin', PASSWORD_STDIN_HELP)
      .option('-y, --yes', 'Do not ask for confirmation (the simulation still runs)'),
  ).action(async (operator: string, options: OperatorOptions) => {
    try {
      await change(operator, options, 'set');
    } catch (err) {
      fail(describeError(err, 'Could not change the operator'));
    }
  });

  common(
    op
      .command('revoke')
      .description('Stop an operator from moving your tokens (expiry set to 0)')
      .argument('<operator>', 'Operator address or contact name')
      .option('--password-stdin', PASSWORD_STDIN_HELP)
      .option('-y, --yes', 'Do not ask for confirmation (the simulation still runs)'),
  ).action(async (operator: string, options: OperatorOptions) => {
    try {
      await change(operator, options, 'revoke');
    } catch (err) {
      fail(describeError(err, 'Could not revoke the operator'));
    }
  });
}

/** Addresses to check by default: contacts, then recent counterparties. */
function defaultCandidates(wallet: string, network: 'mainnet' | 'sepolia'): string[] {
  const out = new Map<string, string>();
  for (const c of listAddresses()) out.set(c.address.toLowerCase(), c.address);
  for (const t of listTransactions({ walletAddress: wallet, network, limit: 30 })) {
    const other = t.from.toLowerCase() === wallet.toLowerCase() ? t.to : t.from;
    if (!/^0x0{40}$/i.test(other)) out.set(other.toLowerCase(), other);
  }
  out.delete(wallet.toLowerCase());
  return [...out.values()].slice(0, 20);
}

async function list(addresses: string[], options: OperatorOptions): Promise<void> {
  const network = pickNetwork(options.network);
  if (!network) return;
  const token = pickToken(network, options.token);
  const wallet = pickWallet(options.wallet);
  if (!token || !wallet) return;
  const contacts = listAddresses();
  const targets: string[] = [];
  for (const a of addresses) {
    const r = resolveRecipient(a, contacts);
    if (!r.ok) return fail(`${a}: ${r.error}`);
    targets.push(r.address);
  }
  const check = targets.length ? targets : defaultCandidates(wallet.address, network);
  if (!check.length) {
    console.log('No contacts or recent addresses to check. Pass addresses to check them.');
    return;
  }
  const backend = createBackend();
  const status = await backend.operatorStatus(token.address, wallet.address, check, network);
  console.log(
    bold(`Operators for ${token.symbol} of ${wallet.name} (${formatAddress(wallet.address)})`),
  );
  for (const a of check) {
    const name = contacts.find((c) => c.address.toLowerCase() === a.toLowerCase())?.name ?? '';
    const yes = status[a.toLowerCase()];
    console.log(
      `  ${name.padEnd(14)} ${a}  ${yes ? chalk.yellow('operator') : chalk.dim('not an operator')}`,
    );
  }
}

async function change(operatorText: string, options: OperatorOptions, mode: 'set' | 'revoke') {
  const network = pickNetwork(options.network);
  if (!network) return;
  const token = pickToken(network, options.token);
  const walletRef = pickWallet(options.wallet);
  if (!token || !walletRef) return;
  const contacts = listAddresses();
  const r = resolveRecipient(operatorText, contacts);
  if (!r.ok) return fail(r.error);
  if (r.address.toLowerCase() === walletRef.address.toLowerCase()) {
    return fail('That is this wallet. An operator is another address.');
  }
  const who = r.contact ? `${r.contact.name} (${r.address})` : r.address;

  let until = 0;
  if (mode === 'set') {
    const e = parseOperatorExpiry(options.for ?? '', Date.now());
    if (!e.ok) return fail(`${e.error} ${e.hint}`);
    if (e.forever) {
      // Never "forever" without the word typed out by a person at a terminal.
      if (!process.stdin.isTTY || options.passwordStdin) {
        return fail(
          'An operator without expiry can only be granted from a terminal, typing "forever" to confirm.',
        );
      }
      const typed = await prompts.input({
        message: `No expiry: ${who} could move ALL your ${token.symbol} for good. Type ${FOREVER_CONFIRMATION} to continue:`,
      });
      if (typed.trim().toLowerCase() !== FOREVER_CONFIRMATION) {
        return fail('Stopped. Nothing was signed or sent.');
      }
    }
    until = e.until;
  }

  // Operator changes are plain contract calls: no relayer (and no mainnet API key) needed.
  const backend = createBackend();
  const wallet = await unlockWallet(walletRef.name, network, options.passwordStdin);
  if (!wallet) return;
  const prepared = await prepareWithSpinner('Simulating the operator change...', () =>
    backend.prepareSetOperator(wallet, token.address, r.address, until, network),
  );
  if (!prepared) return;
  const hash = await confirmAndSend({
    backend,
    network,
    prepared,
    title: bold(mode === 'set' ? 'Grant operator' : 'Revoke operator'),
    lines: [
      `Token:    ${token.symbol} (${token.address})`,
      `Operator: ${who}`,
      `Expiry:   ${mode === 'set' ? describeExpiry(until) : 'now (revoked)'}`,
    ],
    warnings: mode === 'set' ? operatorWarning(token.symbol, until) : [],
    yes: options.yes,
    question: mode === 'set' ? 'Grant this operator?' : 'Revoke this operator?',
  });
  if (hash) {
    console.log(
      mode === 'set'
        ? chalk.green(`${who} is now an operator for ${token.symbol} ${describeExpiry(until)}.`)
        : chalk.green(`${who} can no longer move your ${token.symbol}.`),
    );
  }
}
