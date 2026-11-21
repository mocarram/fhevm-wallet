/**
 * `fhew send [to] [amount] [token]`: one confidential transfer from the command line.
 *
 * Accepts what the TUI's "Next time: fhew send …" hint prints: a contact name or an
 * address, a friendly amount (25, 1,250.50, 1k, half, max) and a token symbol or
 * address, all resolved by the same helpers the TUI uses (src/core/send). `-t`, `-c`
 * and `-w` keep working. Network calls go through the Backend, so FHEW_BACKEND=mock
 * runs the whole command offline.
 *
 * Safety rules (AGENTS.md): checks and simulation run before anything is signed; a
 * pasted address that looks like a contact stops the send; after the broadcast every
 * failure keeps its hash and is never presented as "try again".
 */

import { Command } from 'commander';
import { formatEther } from 'ethers';
import ora from 'ora';
import { PASSWORD_STDIN_HELP, walletPassword } from '../utils/passwordInput.js';
import { prompts } from '../utils/prompts.js';
import { describeBalanceCheck } from '../utils/transferReport.js';
import { describeError } from '../utils/userError.js';
import { createBackend } from '../../core/backend/select.js';
import type { Backend, UnlockedSigner } from '../../core/backend/types.js';
import {
  findLookAlike,
  formatExactAmount,
  hasAmbiguousComma,
  parseFriendlyAmount,
  resolveRecipient,
  resolveToken,
  shortAddress,
} from '../../core/send/index.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { listTokens, TokenEntry } from '../../core/token/TokenRegistry.js';
import { recordTransferTransaction } from '../../core/token/TokenService.js';
import { formatTxError, translateTxError } from '../../core/token/txErrors.js';
import { hasWallet, listWallets, loadWallet } from '../../core/wallet/index.js';
import { listAddresses } from '../../storage/AddressBook.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import { listTransactions } from '../../storage/TransactionStore.js';
import {
  bold,
  error,
  formatAddress,
  formatNetworkName,
  formatTokenAmount,
  success,
  warning,
} from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork } from '../../utils/validation.js';

/** Options of `fhew send`. */
interface SendOptions {
  token?: string;
  wallet?: string;
  network?: string;
  contact?: string;
  passwordStdin?: boolean;
  yes?: boolean;
  mainnet?: boolean;
}

/**
 * Mainnet guard for `fhew send`. When nobody will be asked to confirm (`--yes`, or no
 * terminal), a Mainnet send needs two explicit signs of intent on the command line:
 * `-n mainnet` (so a configured default network can never pick Mainnet silently) and
 * `--mainnet`. Returns the refusal to show, or null when the send may go on.
 */
export function mainnetGuardProblem(opts: {
  network: NetworkName;
  networkOption?: string;
  mainnetFlag?: boolean;
  willAsk: boolean;
}): string | null {
  if (opts.network !== 'mainnet' || opts.willAsk) return null;
  if (opts.networkOption === 'mainnet' && opts.mainnetFlag) return null;
  return 'Nothing was sent: this would move real funds on Mainnet without asking you. To allow it, pass both -n mainnet and --mainnet, or run the command in a terminal without --yes.';
}

function fail(message: string): void {
  process.exitCode = 1;
  console.log(error(message));
}

/** Register `fhew send`. */
export function registerTransferCommand(program: Command): void {
  program
    .command('send')
    .description('Send tokens confidentially, e.g. `fhew send bob 25 cusdc`')
    .argument('[to]', 'Recipient: a contact name or an address')
    .argument('[amount]', 'Amount: 25, 1,250.50, 1k, half or max')
    .argument('[token]', 'Token symbol or address (default: the only tracked token)')
    .option('-t, --token <token>', 'Token symbol or contract address')
    .option('-w, --wallet <name>', 'Wallet to use')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-c, --contact <name>', 'Use address book contact as recipient')
    .option('--password-stdin', PASSWORD_STDIN_HELP)
    .option('-y, --yes', 'Send without asking for confirmation (the checks still run)')
    .option(
      '--mainnet',
      'Allow a Mainnet send without confirmation (with --yes or no terminal); needs -n mainnet too',
    )
    .action(async (to?: string, amount?: string, tokenArg?: string, options: SendOptions = {}) => {
      try {
        await send(to, amount, tokenArg, options);
      } catch (err) {
        fail(describeError(err, 'Failed to send transaction'));
      }
    });
}

async function send(
  to: string | undefined,
  amount: string | undefined,
  tokenArg: string | undefined,
  options: SendOptions,
): Promise<void> {
  let network: NetworkName = getDefaultNetwork();
  if (options.network) {
    if (!isValidNetwork(options.network)) {
      return fail('Invalid network. Use "sepolia" or "mainnet"');
    }
    network = options.network;
  }

  // Refuse an unconfirmed Mainnet send before anything else (no password is read).
  const willAsk = !options.yes && Boolean(process.stdin.isTTY);
  const guard = mainnetGuardProblem({
    network,
    networkOption: options.network,
    mainnetFlag: options.mainnet,
    willAsk,
  });
  if (guard) return fail(guard);

  const backend: Backend = createBackend();
  const notReady = backend.readinessProblem(network);
  if (notReady) return fail(notReady);

  // -c picks the recipient, so the positionals mean [amount] [token].
  const contacts = listAddresses();
  let contact: { name: string; address: string } | undefined;
  if (options.contact) {
    const wanted = options.contact.toLowerCase();
    contact = contacts.find((c) => c.name.toLowerCase() === wanted);
    if (!contact) return fail(`Contact "${options.contact}" not found`);
    const shifted = shiftForContact(contact, to, amount, tokenArg);
    if (!shifted.ok) return fail(shifted.error);
    amount = shifted.amount;
    tokenArg = shifted.token;
  }

  const tokens = listTokens(network);
  if (tokens.length === 0) {
    return fail(`No tokens tracked on ${network}. Add one with: fhevm-wallet token add <address>`);
  }

  // Token: positional, -t (symbol or address), the only one, or a choice.
  let token: TokenEntry;
  const tokenText = tokenArg ?? options.token;
  if (tokenText) {
    if (tokenText.toLowerCase().startsWith('0x') && !isValidAddress(tokenText)) {
      return fail('Invalid token address');
    }
    const r = resolveToken(tokenText, tokens);
    if (!r.ok) {
      return fail(
        isValidAddress(tokenText)
          ? `Token ${tokenText} not tracked. Add it with: fhevm-wallet token add ${tokenText}`
          : r.error,
      );
    }
    token = r.token;
  } else if (tokens.length === 1) {
    token = tokens[0];
  } else {
    const picked = await prompts.select({
      message: 'Select token:',
      choices: [
        ...tokens.map((t) => ({
          name: `${t.symbol} - ${t.name} (${formatAddress(t.address)})`,
          value: t.address,
        })),
        { name: '← Cancel', value: '__cancel__' },
      ],
    });
    if (picked === '__cancel__') return;
    token = tokens.find((t) => t.address === picked)!;
  }

  // Recipient: -c, a contact name or an address, or a choice.
  let recipientText = to;
  if (contact) {
    recipientText = contact.address;
    console.log(`Using contact: ${contact.name} (${formatAddress(contact.address)})`);
  } else if (!recipientText) {
    recipientText = await askRecipient(contacts);
    if (!recipientText) return;
  }
  const rr = resolveRecipient(recipientText, contacts);
  if (!rr.ok) {
    return fail(
      recipientText.toLowerCase().startsWith('0x') ? 'Invalid recipient address' : rr.error,
    );
  }
  const recipient = rr.address;
  const contactName = rr.contact?.name;

  // Address poisoning: a pasted address sharing its start and end with a contact.
  if (!rr.contact) {
    const lookalike = findLookAlike(recipient, contacts);
    if (lookalike) {
      console.log(
        warning(
          `Careful: ${recipient} looks like your contact ${lookalike.name} (${lookalike.address}), but it is a different address.`,
        ),
      );
      if (options.yes || !process.stdin.isTTY) {
        return fail(
          `Send stopped. To send to ${lookalike.name}, use: fhew send ${lookalike.name} …`,
        );
      }
      const goOn = await prompts.confirm({
        message: 'I checked every character. Send to the pasted address anyway?',
        default: false,
      });
      if (!goOn) return fail('Send stopped. Nothing was signed or sent.');
    }
  }

  if (!amount) {
    amount = await prompts.input({
      message: `Amount of ${token.symbol} (25, 1k, half, max; empty to cancel):`,
    });
    if (!amount) return;
  }

  // Wallet and password.
  let walletName = options.wallet || getDefaultWallet();
  if (!walletName) {
    const wallets = listWallets();
    if (wallets.length === 0) {
      return fail('No wallets found. Create one with: fhevm-wallet wallet create');
    }
    const name = await prompts.select({
      message: 'Select wallet:',
      choices: [
        ...wallets.map((w) => ({ name: `${w.name} (${formatAddress(w.address)})`, value: w.name })),
        { name: '← Cancel', value: '__cancel__' },
      ],
    });
    if (name === '__cancel__') return;
    walletName = name;
  }
  if (!hasWallet(walletName)) return fail(`Wallet "${walletName}" not found`);

  const password = await walletPassword(options.passwordStdin);
  const loadSpinner = ora('Decrypting wallet...').start();
  let wallet: UnlockedSigner;
  try {
    wallet = await loadWallet(walletName, password, network);
    loadSpinner.succeed('Wallet loaded');
  } catch (err) {
    loadSpinner.fail('Failed to decrypt wallet');
    return fail(describeError(err, 'Invalid password'));
  }

  // Friendly amount; half and max need the decrypted balance.
  let balance: bigint | undefined;
  if (/^(half|max|all)$/i.test(amount.trim())) {
    const s = ora(`Decrypting your ${token.symbol} balance...`).start();
    try {
      balance = await backend.decryptBalance(token.address, wallet, network);
      s.succeed(`Balance: ${formatExactAmount(balance, token.decimals)} ${token.symbol}`);
    } catch (err) {
      s.fail('Could not decrypt the balance');
      return fail(describeError(err, 'Could not decrypt the balance'));
    }
  }
  const parsed = parseFriendlyAmount(amount, { decimals: token.decimals, balance });
  if (!parsed.ok) return fail(`${parsed.error} ${parsed.hint}`);
  const value = parsed.value;

  // Encrypt and simulate before asking for confirmation, so a doomed send is caught
  // before anything is signed.
  const checkSpinner = ora('Encrypting amount and simulating the transfer...').start();
  let prepared;
  try {
    prepared = await backend.prepareTransfer(wallet, token.address, recipient, value, network);
    checkSpinner.succeed('Simulation passed');
  } catch (err) {
    checkSpinner.fail('Send stopped. Nothing was signed or sent.');
    return fail(formatTxError(translateTxError(err)));
  }

  const exact = formatTokenAmount(value, token.decimals, token.decimals);
  console.log();
  console.log(bold('Transaction Summary'));
  if (backend.kind === 'mock') console.log(warning('  MOCK: simulated, no real funds'));
  console.log(`  From:    ${wallet.address}`);
  console.log(`  To:      ${contactName ? `${contactName} ` : ''}${recipient}`);
  console.log(
    `  Amount:  ${formatExactAmount(value, token.decimals)} ${token.symbol} (= ${exact}, ${value} base units; encrypted on-chain)`,
  );
  console.log(`  Token:   ${token.name}`);
  console.log(`  Network: ${formatNetworkName(network)}`);
  console.log(
    `  Fee:     up to ${formatEther(prepared.feeWei)} ETH (you have ${formatEther(prepared.ethBalanceWei)} ETH)`,
  );
  if (hasAmbiguousComma(amount)) {
    console.log(
      warning(
        `  You typed "${amount.trim()}": commas group thousands. For a decimal, use a point.`,
      ),
    );
  }
  if (!rr.contact && isFirstTime(wallet.address, recipient, network)) {
    console.log(warning('  First time sending to this address. Check it with the recipient.'));
  }
  console.log();

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      return fail('Nothing was sent: confirm in a terminal, or pass --yes to send without asking.');
    }
    const confirm = await prompts.confirm({ message: 'Confirm transaction?', default: false });
    if (!confirm) {
      console.log('Transaction cancelled');
      return;
    }
    // Mainnet: retype the amount, as in the terminal UI, so a slip of the Enter key
    // cannot move real funds.
    if (network === 'mainnet') {
      const shown = formatExactAmount(value, token.decimals);
      const retyped = await prompts.input({
        message: `Mainnet, real funds. Type the amount again to confirm (${shown}):`,
      });
      if (!retypeMatches(retyped, value, token.decimals)) {
        return fail(`Nothing was sent: that doesn't match ${shown} ${token.symbol}.`);
      }
    }
  }

  console.log();
  const sendSpinner = ora('Sending transaction and waiting for confirmation...').start();
  let result;
  try {
    result = await prepared.send();
    sendSpinner.succeed('Transaction confirmed');
  } catch (err) {
    const txErr = translateTxError(err);
    // After broadcast the transfer may still confirm: never present that as a failure.
    if (txErr.code === 'SENT_UNCONFIRMED') sendSpinner.warn('Sent, not confirmed yet');
    else if (txErr.code === 'TX_REPLACED') sendSpinner.warn('Transaction replaced');
    else {
      sendSpinner.fail(
        txErr.code === 'TX_REVERTED' ? 'Transaction reverted' : 'Transaction failed',
      );
    }
    return fail(formatTxError(txErr));
  }

  // Local history is a convenience; failing to save it must not hide a confirmed transfer.
  try {
    recordTransferTransaction({
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      from: wallet.address,
      to: recipient,
      amount: exact,
      txHash: result.txHash,
      network,
      blockNumber: result.blockNumber,
    });
  } catch {
    console.log(warning("Couldn't save this transfer to local history."));
  }

  const where = backend.kind === 'mock' ? ' (mock)' : ' on-chain';
  console.log();
  console.log(
    success(
      `Sent ${formatExactAmount(value, token.decimals)} ${token.symbol} to ${contactName ?? shortAddress(recipient)}. Transfer confirmed${where}.`,
    ),
  );
  console.log(`  Transaction: ${result.txHash}`);
  console.log(`  Explorer:    ${backend.explorerTxUrl(result.txHash, network)}`);
  for (const line of describeBalanceCheck(result, token.symbol, token.decimals)) console.log(line);
}

/**
 * With `-c <contact>` the recipient is already chosen, so the positionals shift left:
 * `fhew send -c bob 3 cusdc` means amount 3, token cusdc. A positional recipient is
 * still accepted when it names the same contact (by name or address); any other one
 * conflicts with -c and is refused rather than silently overridden.
 */
export function shiftForContact(
  contact: { name: string; address: string },
  to: string | undefined,
  amount: string | undefined,
  token: string | undefined,
): { ok: true; amount?: string; token?: string } | { ok: false; error: string } {
  if (to === undefined) return { ok: true, amount, token };
  const t = to.trim();
  const same =
    t.toLowerCase() === contact.address.toLowerCase() ||
    t.toLowerCase() === contact.name.toLowerCase();
  if (same) return { ok: true, amount, token };
  if (t.toLowerCase().startsWith('0x') || token !== undefined) {
    return {
      ok: false,
      error: `Two recipients: -c ${contact.name} and ${to}. Use one of them.`,
    };
  }
  return { ok: true, amount: to, token: amount };
}

/** True when `typed` is exactly the reviewed amount `value` (friendly forms allowed). */
export function retypeMatches(typed: string, value: bigint, decimals: number): boolean {
  const r = parseFriendlyAmount(typed, { decimals });
  return r.ok && r.value === value;
}

/** Pick a contact or type an address; '' when cancelled. */
async function askRecipient(contacts: Array<{ name: string; address: string }>): Promise<string> {
  const ask = () =>
    prompts.input({ message: 'Recipient address or contact name (empty to cancel):' });
  if (contacts.length === 0) return ask();
  const picked = await prompts.select({
    message: 'Select recipient:',
    choices: [
      ...contacts.map((c) => ({
        name: `${c.name} (${formatAddress(c.address)})`,
        value: c.address,
      })),
      { name: 'Enter new address...', value: '__new__' },
      { name: '← Cancel', value: '__cancel__' },
    ],
  });
  if (picked === '__cancel__') return '';
  return picked === '__new__' ? ask() : picked;
}

/** True when this wallet has no recorded send to `to` on `network`. */
function isFirstTime(from: string, to: string, network: NetworkName): boolean {
  try {
    return !listTransactions({ walletAddress: from, network, limit: 10_000 }).some(
      (t) => t.from.toLowerCase() === from.toLowerCase() && t.to.toLowerCase() === to.toLowerCase(),
    );
  } catch {
    return false;
  }
}
