/**
 * `fhew disclose <txHash|handle>`: publish one transfer amount on-chain (OpenZeppelin
 * ERC7984 disclosure).
 *
 * Step 1 `requestDiscloseEncryptedAmount(handle)` makes the amount publicly decryptable
 * (only a party allowed on the ACL, normally the sender or recipient, may do it). Step 2
 * asks the Zama relayer for the public decryption and its KMS proof, then sends
 * `discloseEncryptedAmount(handle, value, proof)`. Each step is its own transaction with
 * the send-safety flow. If the gateway is not ready after step 1, the command says
 * "pending public decryption" and running it again later continues with step 2.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createBackend } from '../../core/backend/select.js';
import type { AmountRequest, PreparedDisclose } from '../../core/backend/types.js';
import { normaliseHandle } from '../../core/fhe/DecryptSession.js';
import { formatExactAmount } from '../../core/send/amount.js';
import { listTokens } from '../../core/token/TokenRegistry.js';
import { formatTxError, translateTxError } from '../../core/token/txErrors.js';
import { setCachedAmounts } from '../../storage/AmountCache.js';
import { getTransactionByHash, listTransactions } from '../../storage/TransactionStore.js';
import { bold } from '../../utils/formatting.js';
import { MAINNET_OPTION_HELP } from '../utils/mainnetGuard.js';
import { PASSWORD_STDIN_HELP } from '../utils/passwordInput.js';
import { describeError } from '../utils/userError.js';
import {
  confirmAndSend,
  fail,
  mainnetAllowed,
  pickNetwork,
  pickToken,
  pickWallet,
  prepareWithSpinner,
  unlockWallet,
} from '../utils/txFlow.js';

interface DiscloseOptions {
  token?: string;
  wallet?: string;
  network?: string;
  passwordStdin?: boolean;
  yes?: boolean;
  mainnet?: boolean;
}

/** How often, and how long apart, step 2 is tried after step 1 confirms. */
const PUBLIC_DECRYPT_TRIES = 6;
const PUBLIC_DECRYPT_WAIT_MS = 10_000;

const WARNING = [
  'Disclosing publishes this amount on-chain. Anyone can read it afterwards,',
  'and it cannot be made private again.',
];

/** Register `fhew disclose`. */
export function registerDiscloseCommand(program: Command): void {
  program
    .command('disclose')
    .description('Make one transfer amount public on-chain (two transactions)')
    .argument('<ref>', 'Transaction hash of the transfer, or the amount handle')
    .option('-t, --token <token>', 'Token (needed when <ref> is a handle not in history)')
    .option('-w, --wallet <name>', 'Wallet to use (the sender or the recipient)')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('--password-stdin', PASSWORD_STDIN_HELP)
    .option('-y, --yes', 'Do not ask for confirmation (the simulations still run)')
    .option('--mainnet', MAINNET_OPTION_HELP)
    .action(async (ref: string, options: DiscloseOptions) => {
      try {
        await disclose(ref, options);
      } catch (err) {
        fail(describeError(err, 'Could not disclose the amount'));
      }
    });
}

async function disclose(ref: string, options: DiscloseOptions): Promise<void> {
  const network = pickNetwork(options.network);
  if (!network) return;
  if (!mainnetAllowed(network, options, 'publish a Mainnet transfer amount')) return;
  const walletRef = pickWallet(options.wallet);
  if (!walletRef) return;
  if (!/^0x[0-9a-fA-F]{64}$/.test(ref)) {
    return fail('Pass the transfer transaction hash or the amount handle (0x and 64 hex digits).');
  }
  const backend = createBackend();
  const notReady = backend.readinessProblem(network);
  if (notReady) return fail(notReady);

  const target = await findTarget(ref, walletRef.address, network, options, backend);
  if (!target) return;
  const token = listTokens(network).find(
    (t) => t.address.toLowerCase() === target.token.toLowerCase(),
  );
  if (!token) return fail(`Token ${target.token} is not tracked on ${network}.`);
  const handle = normaliseHandle(target.handle);

  let stage = await backend.discloseStage(token.address, handle, network);
  if (stage === 'disclosed') {
    console.log(chalk.green('This amount is already public: you disclosed it earlier.'));
    return;
  }
  const wallet = await unlockWallet(walletRef.name, network, options.passwordStdin);
  if (!wallet) return;

  if (stage === 'private') {
    const req = await prepareWithSpinner('Simulating step 1 (disclosure request)...', () =>
      backend.prepareDiscloseRequest(wallet, token.address, handle, network),
    );
    if (!req) return;
    const hash = await confirmAndSend({
      backend,
      network,
      prepared: req,
      title: bold('Disclose an amount: step 1 of 2 (request)'),
      lines: [`Token:   ${token.symbol} (${token.address})`, `Amount:  handle ${handle}`],
      warnings: WARNING,
      yes: options.yes,
      question: 'Request disclosure of this amount?',
    });
    if (!hash) return;
    stage = 'requested';
  }

  // Step 2: the gateway needs a moment after step 1 before it will decrypt publicly.
  let prepared: PreparedDisclose | null = null;
  for (let i = 0; i < PUBLIC_DECRYPT_TRIES && !prepared; i++) {
    try {
      prepared = await backend.prepareDisclose(wallet, token.address, handle, network);
    } catch (err) {
      const e = translateTxError(err);
      if (e.code !== 'PUBLIC_DECRYPT_PENDING') {
        return fail(`Step 2 stopped. Nothing was signed or sent.\n${formatTxError(e)}`);
      }
      if (i === PUBLIC_DECRYPT_TRIES - 1 || backend.kind === 'mock') break;
      console.log(chalk.dim('  Pending public decryption; trying again in 10 seconds...'));
      await new Promise((r) => setTimeout(r, PUBLIC_DECRYPT_WAIT_MS));
    }
  }
  if (!prepared) {
    console.log(
      chalk.yellow(
        `Step 1 is done; the amount is pending public decryption. Run \`fhew disclose ${ref}\` again in a few minutes to publish it.`,
      ),
    );
    return;
  }
  const value = prepared.value;
  const hash = await confirmAndSend({
    backend,
    network,
    prepared,
    title: bold('Disclose an amount: step 2 of 2 (publish)'),
    lines: [
      `Token:   ${token.symbol} (${token.address})`,
      `Amount:  ${formatExactAmount(value, token.decimals)} ${token.symbol} (from the public decryption)`,
    ],
    warnings: WARNING,
    yes: options.yes,
    question: 'Publish this amount on-chain?',
  });
  if (!hash) return;
  try {
    setCachedAmounts(network, [{ handle, value, disclosed: true }]);
  } catch {
    // the on-chain disclosure is what counts
  }
  console.log(
    chalk.green(`Disclosed ${formatExactAmount(value, token.decimals)} ${token.symbol} publicly.`),
  );
}

/** Resolve a tx hash or handle to (token, handle): local history first, then the receipt. */
async function findTarget(
  ref: string,
  wallet: string,
  network: 'mainnet' | 'sepolia',
  options: DiscloseOptions,
  backend: ReturnType<typeof createBackend>,
): Promise<AmountRequest | null> {
  const byHash = getTransactionByHash(ref);
  if (byHash?.amountHandle) return { token: byHash.tokenAddress, handle: byHash.amountHandle };
  const byHandle = listTransactions({ walletAddress: wallet, network, limit: 10_000 }).find(
    (t) => t.amountHandle?.toLowerCase() === ref.toLowerCase(),
  );
  if (byHandle) return { token: byHandle.tokenAddress, handle: byHandle.amountHandle! };
  const tokens = listTokens(network).map((t) => t.address);
  const found = await backend.findTransferHandle(ref, wallet, tokens, network).catch(() => null);
  if (found) return found;
  if (options.token) {
    const t = pickToken(network, options.token);
    return t ? { token: t.address, handle: ref } : null;
  }
  fail(
    'No confidential transfer of this wallet found for that hash. Run `fhew history` first, or pass the amount handle with --token.',
  );
  return null;
}
