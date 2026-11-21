/**
 * `fhew operator list|set|revoke`: ERC-7984 operators (there is no `approve`).
 *
 * An operator can move ALL of the holder's tokens until its expiry, so `set` takes an
 * explicit duration (1h, 1d, 7d, a date) and "forever" only after typing the word in a
 * terminal. Changes go through the send-safety flow (cli/utils/txFlow.ts).
 *
 * `--json` prints one document (see cli/utils/json.ts); `set` and `revoke` then need
 * `--yes` and `--password-stdin`, and "forever" is refused (it needs a typed word).
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
import { MAINNET_OPTION_HELP } from '../utils/mainnetGuard.js';
import { PASSWORD_STDIN_HELP } from '../utils/passwordInput.js';
import { prompts } from '../utils/prompts.js';
import { printJson } from '../utils/json.js';
import {
  confirmAndSend,
  fail,
  failWith,
  jsonPromptsCovered,
  mainnetAllowed,
  pickNetwork,
  pickToken,
  pickWallet,
  prepareWithSpinner,
  startJsonOutput,
  unlockWallet,
} from '../utils/txFlow.js';

interface OperatorOptions {
  token?: string;
  wallet?: string;
  network?: string;
  for?: string;
  passwordStdin?: boolean;
  yes?: boolean;
  mainnet?: boolean;
  json?: boolean;
}

/**
 * Run an operator subcommand with `--json` handled: human output to stderr, the document
 * (or `{"error": ...}`) on stdout.
 */
async function run(
  options: OperatorOptions,
  fallback: string,
  body: () => Promise<void>,
): Promise<void> {
  const restore = options.json ? startJsonOutput() : () => {};
  try {
    await body();
  } catch (err) {
    failWith(err, fallback);
  } finally {
    restore();
  }
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
      .option('-n, --network <network>', 'Network (sepolia or mainnet)')
      .option('--json', 'Print machine-readable JSON (set/revoke need --yes and --password-stdin)');

  common(
    op
      .command('list')
      .description('Show which contacts, recent addresses or given addresses are operators')
      .argument('[addresses...]', 'Addresses or contact names to check'),
  ).action((addresses: string[], options: OperatorOptions) =>
    run(options, 'Could not check operators', () => list(addresses, options)),
  );

  common(
    op
      .command('set')
      .description('Let an address move your tokens until an expiry')
      .argument('<operator>', 'Operator address or contact name')
      .requiredOption('--for <expiry>', 'How long: 1h, 1d, 7d, 2w, a date (2026-12-01) or forever')
      .option('--password-stdin', PASSWORD_STDIN_HELP)
      .option('-y, --yes', 'Do not ask for confirmation (the simulation still runs)')
      .option('--mainnet', MAINNET_OPTION_HELP),
  ).action((operator: string, options: OperatorOptions) =>
    run(options, 'Could not change the operator', () => change(operator, options, 'set')),
  );

  common(
    op
      .command('revoke')
      .description('Stop an operator from moving your tokens (expiry set to 0)')
      .argument('<operator>', 'Operator address or contact name')
      .option('--password-stdin', PASSWORD_STDIN_HELP)
      .option('-y, --yes', 'Do not ask for confirmation (the simulation still runs)')
      .option('--mainnet', MAINNET_OPTION_HELP),
  ).action((operator: string, options: OperatorOptions) =>
    run(options, 'Could not revoke the operator', () => change(operator, options, 'revoke')),
  );
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
    if (!r.ok) return fail(`${a}: ${r.error}`, 'INVALID_ADDRESS');
    targets.push(r.address);
  }
  const check = targets.length ? targets : defaultCandidates(wallet.address, network);
  const backend = createBackend();
  const status = check.length
    ? await backend.operatorStatus(token.address, wallet.address, check, network)
    : {};
  if (options.json) {
    printJson({
      mock: backend.kind === 'mock',
      network,
      wallet: { name: wallet.name, address: wallet.address },
      token: { address: token.address, symbol: token.symbol },
      operators: check.map((a) => ({
        address: a,
        contact: contacts.find((c) => c.address.toLowerCase() === a.toLowerCase())?.name ?? null,
        isOperator: Boolean(status[a.toLowerCase()]),
      })),
    });
    return;
  }
  if (!check.length) {
    console.log('No contacts or recent addresses to check. Pass addresses to check them.');
    return;
  }
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
  const what =
    mode === 'set'
      ? 'let another address move your Mainnet tokens'
      : 'change an operator of your Mainnet tokens';
  if (!mainnetAllowed(network, options, what)) return;
  if (!jsonPromptsCovered(options)) return;
  const token = pickToken(network, options.token);
  const walletRef = pickWallet(options.wallet);
  if (!token || !walletRef) return;
  const contacts = listAddresses();
  const r = resolveRecipient(operatorText, contacts);
  if (!r.ok) return fail(r.error, 'INVALID_ADDRESS');
  if (r.address.toLowerCase() === walletRef.address.toLowerCase()) {
    return fail('That is this wallet. An operator is another address.', 'OPERATOR_IS_SELF');
  }
  const who = r.contact ? `${r.contact.name} (${r.address})` : r.address;

  let until = 0;
  if (mode === 'set') {
    const e = parseOperatorExpiry(options.for ?? '', Date.now());
    if (!e.ok) return fail(`${e.error} ${e.hint}`, 'INVALID_EXPIRY');
    if (e.forever) {
      // Never "forever" without the word typed out by a person at a terminal.
      if (!process.stdin.isTTY || options.passwordStdin || options.json) {
        return fail(
          'An operator without expiry can only be granted from a terminal, typing "forever" to confirm.',
          'FOREVER_NEEDS_TERMINAL',
        );
      }
      const typed = await prompts.input({
        message: `No expiry: ${who} could move ALL your ${token.symbol} for good. Type ${FOREVER_CONFIRMATION} to continue:`,
      });
      if (typed.trim().toLowerCase() !== FOREVER_CONFIRMATION) {
        return fail('Stopped. Nothing was signed or sent.', 'CANCELLED');
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
  const sent = await confirmAndSend({
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
  if (sent && options.json) {
    printJson({
      status: 'confirmed',
      mock: backend.kind === 'mock',
      network,
      action: mode,
      wallet: { name: walletRef.name, address: walletRef.address },
      token: { address: token.address, symbol: token.symbol },
      operator: { address: r.address, contact: r.contact?.name ?? null },
      // Unix seconds the operator may act until; 0 after a revoke.
      until,
      txHash: sent.txHash,
      blockNumber: sent.blockNumber,
      explorerUrl: sent.explorerUrl,
    });
  } else if (sent) {
    console.log(
      mode === 'set'
        ? chalk.green(`${who} is now an operator for ${token.symbol} ${describeExpiry(until)}.`)
        : chalk.green(`${who} can no longer move your ${token.symbol}.`),
    );
  }
}
