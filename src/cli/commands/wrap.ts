/**
 * `fhew wrap <amount> [token]` and `fhew unwrap <amount> [token]`: move value between a
 * public ERC-20 and its confidential ERC-7984 wrapper (OpenZeppelin ERC7984ERC20Wrapper).
 *
 * Wrap amounts are in the ERC-20's units (`fhew wrap 25 czama` wraps 25 ZAMA), unwrap
 * amounts in the confidential token's (`fhew unwrap 10 czama` unwraps 10 cZAMA). The
 * exact result and any dust are shown before anything is signed, and a wrap that would
 * mint 0 is refused (wrapMath.ts).
 *
 * Wrap sends up to two transactions after one confirmation: an approval of exactly the
 * amount (only when the allowance is short) and the wrap. Unwrap sends the request, waits
 * for the public decryption and sends the finish; when the decryption is not ready yet it
 * stops with "pending" and `fhew unwrap --resume` finishes it later. Every unwrap is
 * recorded from the moment it is signed (UnwrapStore.ts) and checked against the chain
 * before any step is sent again (unwrapPending.ts).
 *
 * Both run through the Backend, so FHEW_BACKEND=mock runs them offline.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { formatEther } from 'ethers';
import { createBackend } from '../../core/backend/select.js';
import type { Backend, UnlockedSigner } from '../../core/backend/types.js';
import type { PreparedFinalize, WrapStep } from '../../core/backend/wrapTypes.js';
import type { NetworkName } from '../../core/network/NetworkConfig.js';
import { formatExactAmount } from '../../core/send/amount.js';
import { listTokens, type TokenEntry } from '../../core/token/TokenRegistry.js';
import { formatTxError, translateTxError, type WalletTxError } from '../../core/token/txErrors.js';
import {
  describeUnwrapState,
  entryInfo,
  prepareFinish,
  reconcileUnwrap,
  sendFinish,
  sendUnwrapRequest,
  unconfirmedRequest,
  unconfirmedRequestError,
} from '../../core/token/unwrapPending.js';
import {
  describeRate,
  describeWrapPlan,
  planUnwrap,
  planWrap,
  type AmountProblem,
} from '../../core/token/wrapMath.js';
import { sendWrapRecorded } from '../../core/token/wrapHistory.js';
import { loadWrappers, resolveWrapToken } from '../../core/token/wrapTokens.js';
import type { WrapperInfo } from '../../core/token/wrapper.js';
import {
  assertUnwrapStoreWritable,
  findUnwrap,
  listUnwraps,
  removeUnwrap,
  type UnwrapEntry,
} from '../../storage/UnwrapStore.js';
import { bold, formatNetworkName, success, warning } from '../../utils/formatting.js';
import { MAINNET_OPTION_HELP } from '../utils/mainnetGuard.js';
import { PASSWORD_STDIN_HELP } from '../utils/passwordInput.js';
import { mockJson, printJson, walletJson } from '../utils/json.js';
import { spinner as ora } from '../utils/spinner.js';
import { prompts } from '../utils/prompts.js';
import {
  fail,
  failWith,
  jsonPromptsCovered,
  mainnetAllowed,
  pickNetwork,
  pickWallet,
  prepareWithSpinner,
  startJsonOutput,
  unlockWallet,
} from '../utils/txFlow.js';

interface WrapOptions {
  wallet?: string;
  token?: string;
  network?: string;
  passwordStdin?: boolean;
  yes?: boolean;
  mainnet?: boolean;
  json?: boolean;
}

interface UnwrapOptions extends WrapOptions {
  list?: boolean;
  all?: boolean;
  resume?: string | boolean;
  forget?: string;
}

/** How often, and how long apart, step 2 is tried after the request confirms. */
const PUBLIC_DECRYPT_TRIES = 6;
const PUBLIC_DECRYPT_WAIT_MS = 10_000;

const WRAP_PRIVACY =
  'The wrapped amount is public on-chain; later balances and transfers are private.';
const UNWRAP_PRIVACY = 'The unwrapped amount becomes public on-chain.';

/** Register `fhew wrap` and `fhew unwrap`. */
export function registerWrapCommands(program: Command): void {
  const common = (c: Command) =>
    c
      .option('-w, --wallet <name>', 'Wallet to use')
      .option('-t, --token <token>', 'The confidential token (same as the [token] argument)')
      .option('-n, --network <network>', 'Network (sepolia or mainnet)')
      .option('--password-stdin', PASSWORD_STDIN_HELP)
      .option('-y, --yes', 'Do not ask for confirmation (the checks still run)')
      .option('--mainnet', MAINNET_OPTION_HELP)
      .option('--json', 'Print machine-readable JSON (needs --yes and --password-stdin)');

  common(
    program
      .command('wrap')
      .description('Wrap a public ERC-20 into its confidential token, e.g. `fhew wrap 25 czama`')
      .argument('<amount>', 'Amount of the PUBLIC token: 25, 1,250.50, 1k, half or max')
      .argument('[token]', 'The confidential token (symbol or address), or its ERC-20 symbol'),
  ).action(async (amount: string, token: string | undefined, options: WrapOptions) => {
    const restore = options.json ? startJsonOutput() : () => {};
    try {
      await wrapCommand(amount, token, options);
    } catch (err) {
      failWith(err, 'Could not wrap');
    } finally {
      restore();
    }
  });

  common(
    program
      .command('unwrap')
      .description('Unwrap a confidential token back into its ERC-20, e.g. `fhew unwrap 10 czama`')
      .argument('[amount]', 'Amount of the CONFIDENTIAL token: 10, 1k, half or max')
      .argument('[token]', 'The confidential token (symbol or address), or its ERC-20 symbol')
      .option('--list', 'List unwraps that are not finished (no password needed)')
      .option('--all', 'With --list: also finished and failed ones')
      .option('--resume [id]', 'Finish pending unwraps (all, or the one with this hash or id)')
      .option('--forget <id>', 'Remove a failed, finished or dropped unwrap from the list'),
  ).action(
    async (amount: string | undefined, token: string | undefined, options: UnwrapOptions) => {
      const restore = options.json ? startJsonOutput() : () => {};
      try {
        if (options.list) await listCommand(options);
        else if (options.forget) await forgetCommand(options.forget, options);
        else if (options.resume !== undefined) {
          await resumeCommand(
            typeof options.resume === 'string' ? options.resume : undefined,
            options,
          );
        } else if (!amount) {
          fail(
            'Give an amount, e.g. `fhew unwrap 10 czama`, or use --list / --resume.',
            'INVALID_AMOUNT',
          );
        } else await unwrapCommand(amount, token, options);
      } catch (err) {
        failWith(err, 'Could not unwrap');
      } finally {
        restore();
      }
    },
  );
}

/** Network, wallet and the wrapper token for a wrap or unwrap; null (error printed) to stop. */
async function pickWrapTarget(
  tokenText: string | undefined,
  options: WrapOptions,
  what: string,
): Promise<{
  network: NetworkName;
  walletRef: { name: string; address: string };
  backend: Backend;
  token: TokenEntry;
  info: WrapperInfo;
} | null> {
  const network = pickNetwork(options.network);
  if (!network) return null;
  if (!mainnetAllowed(network, options, what)) return null;
  if (!jsonPromptsCovered(options)) return null;
  const walletRef = pickWallet(options.wallet);
  if (!walletRef) return null;
  const backend = createBackend();
  const tokens = listTokens(network);
  if (!tokens.length) {
    fail(
      `No tokens tracked on ${network}. Add the wrapper with: fhew token add <address>`,
      'NO_TOKENS',
    );
    return null;
  }
  const wrappers = await loadWrappers(backend, network, tokens);
  const picked = resolveWrapToken(tokenText ?? options.token, tokens, wrappers);
  if (!picked.ok) {
    fail(picked.error, picked.code);
    return null;
  }
  // Both a token argument and -t: they must name the same token (like `fhew send`).
  if (tokenText && options.token) {
    const other = resolveWrapToken(options.token, tokens, wrappers);
    if (!other.ok) {
      fail(other.error, other.code);
      return null;
    }
    if (other.token.address.toLowerCase() !== picked.token.address.toLowerCase()) {
      fail(
        `Two tokens given: ${picked.token.symbol} (argument) and ${other.token.symbol} (-t). Give only one.`,
        'CONFLICTING_TOKENS',
      );
      return null;
    }
  }
  // Read the wrapper again right before signing: a cached rate must never decide amounts.
  const info = await backend.wrapperInfo(picked.token.address, network);
  if (!info) {
    fail(
      `${picked.token.symbol} is not an ERC-20 wrapper, so it cannot be wrapped or unwrapped.`,
      'NOT_A_WRAPPER',
    );
    return null;
  }
  return { network, walletRef, backend, token: picked.token, info };
}

/** Fail with an amount problem's message and code (INVALID_AMOUNT unless it says more). */
function failAmount(plan: AmountProblem): void {
  fail(`${plan.error}\n${plan.hint}`, plan.code ?? 'INVALID_AMOUNT');
}

/** True for the amounts that are a share of the balance (`max`, `all`, `half`). */
function needsBalance(text: string): boolean {
  return /^(max|all|half)$/i.test(text.trim());
}

/** Format base units with a symbol. */
function amt(value: bigint, decimals: number, symbol: string): string {
  return `${formatExactAmount(value, decimals)} ${symbol}`;
}

/** Common JSON fields. */
function docBase(
  backend: Backend,
  network: NetworkName,
  walletRef: { name: string; address: string },
  info: WrapperInfo,
) {
  return {
    mock: backend.kind === 'mock',
    network,
    wallet: walletJson(walletRef.address, walletRef.name),
    token: { address: info.address, symbol: info.symbol, decimals: info.decimals },
    underlying: {
      address: info.underlying.address,
      symbol: info.underlying.symbol,
      decimals: info.underlying.decimals,
    },
    rate: info.rate,
  };
}

/** Print a summary and ask; true to go ahead. */
async function confirmSummary(opts: {
  backend: Backend;
  network: NetworkName;
  title: string;
  lines: string[];
  feeLine: string;
  warnings: string[];
  yes?: boolean;
  question: string;
}): Promise<boolean> {
  console.log();
  console.log(bold(opts.title));
  if (opts.backend.kind === 'mock') console.log(warning('  MOCK: simulated, no real funds'));
  for (const l of opts.lines) console.log(`  ${l}`);
  console.log(`  Network:   ${formatNetworkName(opts.network)}`);
  console.log(`  Fee:       ${opts.feeLine}`);
  for (const w of opts.warnings) console.log(warning(`  ${w}`));
  console.log();
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    fail(
      'Nothing was sent: confirm in a terminal, or pass --yes to go ahead without asking.',
      'PROMPT_NOT_ALLOWED',
    );
    return false;
  }
  const ok = await prompts.confirm({ message: opts.question, default: false });
  if (!ok) console.log('Cancelled. Nothing was sent.');
  return ok;
}

/** Report a failure while sending: keeps the hash (and the explorer link) once broadcast. */
function failSend(
  backend: Backend,
  network: NetworkName,
  err: unknown,
  extra: Record<string, string> = {},
): void {
  const e = translateTxError(err);
  const more: Record<string, string> = { ...extra };
  if (e.txHash) {
    more.txHash = e.txHash;
    more.explorerUrl = backend.explorerTxUrl(e.txHash, network);
  }
  fail(formatTxError(e), e.code, more);
}

const STEP_TEXT: Record<WrapStep, string> = {
  reset: 'Resetting the old approval to 0',
  approve: 'Approving exactly the amount',
  wrap: 'Wrapping',
};

async function wrapCommand(
  amountText: string,
  tokenText: string | undefined,
  options: WrapOptions,
) {
  const t = await pickWrapTarget(tokenText, options, 'wrap tokens on Mainnet');
  if (!t) return;
  const { network, walletRef, backend, info } = t;
  const u = info.underlying;
  const state = await backend.wrapState(info, walletRef.address, network);
  const plan = planWrap(amountText, info, { balance: state.balance, supplyRoom: state.supplyRoom });
  if (!plan.ok) return failAmount(plan);

  const wallet = await unlockWallet(walletRef.name, network, options.passwordStdin);
  if (!wallet) return;
  const session = backend.newDecryptSession(wallet, network);
  try {
    const prepared = await prepareWithSpinner('Checking the wrap...', () =>
      backend.prepareWrap(wallet, info, plan.pull, network, { session }),
    );
    if (!prepared) return;
    const { stays } = describeWrapPlan(plan, info);
    const approving = prepared.steps.includes('approve');
    const lines = [
      `You give:  ${amt(plan.pull, u.decimals, u.symbol)} (public; you have ${amt(state.balance, u.decimals, u.symbol)})`,
      `You get:   ${amt(plan.wrapped, info.decimals, info.symbol)} (confidential)`,
      ...(plan.dust > 0n
        ? [
            `Stays:     ${amt(plan.dust, u.decimals, u.symbol)} in your wallet (below 1 ${info.symbol} unit)`,
          ]
        : []),
      `Rate:      ${describeRate(info)}`,
      approving
        ? `Steps:     ${prepared.steps.includes('reset') ? '1. reset the old approval to 0  2.' : '1.'} approve exactly ${amt(plan.pull, u.decimals, u.symbol)} for ${info.symbol} (not unlimited)  ${prepared.steps.length}. wrap`
        : 'Steps:     wrap (the existing approval covers it)',
    ];
    const feeLine = `up to ${formatEther(prepared.feeWei)} ETH (you have ${formatEther(prepared.ethBalanceWei)} ETH)${
      prepared.feeEstimated
        ? '; the wrap is simulated after the approval, its part is an estimate'
        : ''
    }`;
    const ok = await confirmSummary({
      backend,
      network,
      title: `Wrap ${u.symbol} into ${info.symbol}`,
      lines,
      feeLine,
      warnings: [WRAP_PRIVACY],
      yes: options.yes,
      question: `Wrap ${amt(plan.pull, u.decimals, u.symbol)} into ${info.symbol}?`,
    });
    if (!ok) return;

    const wrapCtx = { network, wallet: wallet.address, info, amount: plan.wrapped };
    const spin = ora('Sending...').start();
    const hashes: Partial<Record<WrapStep, string>> = {};
    let result;
    try {
      result = await sendWrapRecorded(prepared, wrapCtx, {
        onStep: (step) => {
          spin.text = `${STEP_TEXT[step]} and waiting for confirmation...`;
        },
        onStepConfirmed: (step, txHash) => {
          hashes[step] = txHash;
          if (step !== 'wrap') {
            spin.succeed(`${step === 'reset' ? 'Old approval reset' : 'Approved'}: ${txHash}`);
            spin.start('Wrapping and waiting for confirmation...');
          }
        },
      });
      spin.succeed('Wrap confirmed');
    } catch (err) {
      const e = translateTxError(err);
      if (e.code === 'SENT_UNCONFIRMED') spin.warn('Sent, not confirmed yet');
      else spin.fail(e.code === 'WRAP_APPROVED_ONLY' ? 'Approved, not wrapped' : 'Wrap failed');
      return failSend(backend, network, e, {
        ...(hashes.reset ? { resetTxHash: hashes.reset } : {}),
        ...(hashes.approve ? { approveTxHash: hashes.approve } : {}),
      });
    }
    const explorerUrl = backend.explorerTxUrl(result.txHash, network);
    if (options.json) {
      return printJson({
        status: 'wrapped',
        ...docBase(backend, network, walletRef, info),
        amount: { baseUnits: plan.pull, formatted: formatExactAmount(plan.pull, u.decimals) },
        wrapped: {
          baseUnits: plan.wrapped,
          formatted: formatExactAmount(plan.wrapped, info.decimals),
        },
        dust: { baseUnits: plan.dust, formatted: formatExactAmount(plan.dust, u.decimals) },
        resetTxHash: result.resetTxHash ?? null,
        approveTxHash: result.approveTxHash ?? null,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        explorerUrl,
        balanceCheck: result.balanceCheck,
        balanceBefore: result.balanceBefore ?? null,
        balanceAfter: result.balanceAfter ?? null,
      });
    }
    console.log(`  Transaction: ${result.txHash}`);
    console.log(`  Explorer:    ${explorerUrl}`);
    console.log(
      success(
        `Wrapped ${amt(plan.pull, u.decimals, u.symbol)} into ${amt(plan.wrapped, info.decimals, info.symbol)}.`,
      ),
    );
    if (stays) console.log(chalk.dim(`  ${stays}`));
    console.log(
      describeWrapCheck(result.balanceCheck, info, result.balanceBefore, result.balanceAfter),
    );
  } finally {
    session.clear();
  }
}

/** The confidential balance before → after a wrap, or why it is not known. */
function describeWrapCheck(
  check: string,
  info: WrapperInfo,
  before?: bigint,
  after?: bigint,
): string {
  const fmt = (v: bigint) => amt(v, info.decimals, info.symbol);
  if (check === 'moved' && before !== undefined && after !== undefined) {
    return success(`${info.symbol} balance: ${fmt(before)} → ${fmt(after)}`);
  }
  if (check === 'unchanged') {
    return warning(
      `The wrap confirmed, but your ${info.symbol} balance did not change. Check the explorer.`,
    );
  }
  if (check === 'changed' && after !== undefined) {
    return warning(
      `Your ${info.symbol} balance is now ${fmt(after)}: another transfer may have arrived too.`,
    );
  }
  return chalk.dim(
    `Couldn't re-check the ${info.symbol} balance just now. Run \`fhew balance\` later.`,
  );
}

async function unwrapCommand(
  amountText: string,
  tokenText: string | undefined,
  options: UnwrapOptions,
) {
  const t = await pickWrapTarget(tokenText, options, 'unwrap tokens on Mainnet');
  if (!t) return;
  const { network, walletRef, backend, info } = t;
  const u = info.underlying;
  const notReady = backend.readinessProblem(network);
  if (notReady) return fail(notReady, 'FHE_NOT_READY');
  const earlier = unconfirmedRequest(network, walletRef.address, info.address);
  if (earlier) {
    const e = unconfirmedRequestError(earlier);
    return fail(formatTxError(e), e.code, { requestTxHash: earlier.requestTxHash });
  }
  // Before anything is signed: the request must be recordable.
  assertUnwrapStoreWritable();
  // A typo is reported before the password is asked for (max and half need the balance).
  if (!needsBalance(amountText)) {
    const early = planUnwrap(amountText, info);
    if (!early.ok) return failAmount(early);
  }

  const wallet = await unlockWallet(walletRef.name, network, options.passwordStdin);
  if (!wallet) return;
  const session = backend.newDecryptSession(wallet, network);
  try {
    const spin = ora(`Decrypting your ${info.symbol} balance...`).start();
    const batch = await backend.decryptBalances(
      session,
      listTokens(network).map((x) => x.address),
    );
    const balance = batch.values[info.address.toLowerCase()];
    if (balance === undefined) {
      spin.fail('Could not decrypt the balance');
      const e = translateTxError(batch.errors[info.address.toLowerCase()]);
      return fail(`Nothing was signed or sent.\n${formatTxError(e)}`, 'BALANCE_CHECK_FAILED');
    }
    spin.succeed(`${info.symbol} balance: ${amt(balance, info.decimals, info.symbol)}`);
    const plan = planUnwrap(amountText, info, { balance });
    if (!plan.ok) return failAmount(plan);

    const prepared = await prepareWithSpinner('Encrypting and checking the unwrap...', () =>
      backend.prepareUnwrap(wallet, info, plan.amount, network, { session }),
    );
    if (!prepared) return;
    const ok = await confirmSummary({
      backend,
      network,
      title: `Unwrap ${info.symbol} into ${u.symbol}`,
      lines: [
        `You burn:  ${amt(plan.amount, info.decimals, info.symbol)} (you have ${amt(balance, info.decimals, info.symbol)})`,
        `You get:   ${amt(plan.receive, u.decimals, u.symbol)} (public)`,
        'Steps:     1. request: burns the amount and asks Zama to decrypt it',
        '           2. finish: publishes the decrypted amount with its proof; sent as soon as it is ready',
      ],
      feeLine: `up to ${formatEther(prepared.feeWei)} ETH now + about ${formatEther(prepared.finalizeFeeWei)} ETH for step 2 (you have ${formatEther(prepared.ethBalanceWei)} ETH)`,
      warnings: [UNWRAP_PRIVACY, 'This one confirmation covers both steps.'],
      yes: options.yes,
      question: `Unwrap ${amt(plan.amount, info.decimals, info.symbol)}?`,
    });
    if (!ok) return;

    const send = ora('Sending step 1 (request) and waiting for confirmation...').start();
    let entry: UnwrapEntry;
    try {
      const r = await sendUnwrapRequest(prepared, {
        network,
        wallet: wallet.address,
        info,
        amount: plan.amount,
      });
      entry = r.entry;
      send.succeed(`Step 1 confirmed: ${r.result.txHash}`);
    } catch (err) {
      const e = translateTxError(err);
      if (e.code === 'SENT_UNCONFIRMED') send.warn('Step 1 sent, not confirmed yet');
      else send.fail('Step 1 failed');
      failSend(backend, network, e);
      if (e.txHash && !options.json) {
        console.log(
          chalk.yellow('It is saved: run `fhew unwrap --resume` to check it and finish.'),
        );
      }
      return;
    }
    const outcome = await finishOne(backend, wallet, entry, options, {
      tries: PUBLIC_DECRYPT_TRIES,
      confirmed: true,
    });
    await reportOutcomes(backend, walletRef, [outcome], options, info);
  } finally {
    session.clear();
  }
}

/** What happened to one unwrap in this run. */
interface FinishOutcome {
  entry: UnwrapEntry;
  status: 'finished' | 'alreadyFinished' | 'pending' | 'waiting' | 'failed' | 'cancelled' | 'error';
  message: string;
  finalizeTxHash?: string;
  error?: WalletTxError;
  receivedBaseUnits?: bigint;
}

/**
 * Reconcile one unwrap with the chain and, when ready, send step 2. `confirmed`: the
 * user already confirmed both steps in this run (no second prompt). Never throws for a
 * per-unwrap problem: the outcome says what happened.
 */
async function finishOne(
  backend: Backend,
  wallet: UnlockedSigner | null,
  start: UnwrapEntry,
  options: UnwrapOptions,
  opts: { tries: number; confirmed: boolean },
  unlock?: () => Promise<UnlockedSigner | null>,
): Promise<FinishOutcome> {
  let entry = start;
  const u = entry.underlying;
  const label = `${amt(BigInt(entry.amount), entry.decimals, entry.symbol)} → ${u.symbol}`;
  for (let i = 0; i < opts.tries; i++) {
    let next;
    try {
      ({ entry, next } = await reconcileUnwrap(backend, entry));
    } catch (err) {
      const e = translateTxError(err);
      return {
        entry,
        status: 'error',
        message: `Could not check ${label}: ${e.message}`,
        error: e,
      };
    }
    switch (next.kind) {
      case 'done':
        return {
          entry,
          status: entry.finishedBy === 'other' ? 'alreadyFinished' : 'finished',
          message:
            entry.finishedBy === 'other'
              ? `✔ Already finished (by another account): ${label}`
              : `✔ Finished: ${label}`,
          finalizeTxHash: entry.finalizeTxHash,
        };
      case 'failed':
        return { entry, status: 'failed', message: `✗ ${label}: ${next.reason}` };
      case 'wait-request':
        return {
          entry,
          status: 'waiting',
          message: next.missing
            ? `! ${label}: the network does not know the request ${entry.requestTxHash} yet. Not sent again. If it never appears it was dropped and nothing was burnt (then \`fhew unwrap --forget ${entry.id.slice(0, 12)}\`).`
            : `! ${label}: the request ${entry.requestTxHash} is not mined yet. Not sent again; try later.`,
        };
      case 'wait-finalize':
        return {
          entry,
          status: 'waiting',
          message: `! ${label}: step 2 (${entry.finalizeTxHash}) was sent and is not confirmed yet. Not sent again; check it on the explorer.`,
        };
      case 'finalize':
        break;
    }
    if (!wallet && unlock) wallet = await unlock();
    if (!wallet) return { entry, status: 'cancelled', message: 'Stopped. Nothing was sent.' };
    let prepared: PreparedFinalize;
    try {
      prepared = await prepareFinish(backend, wallet, entry);
    } catch (err) {
      const e = translateTxError(err);
      if (e.code === 'UNWRAP_ALREADY_FINISHED') {
        return {
          entry: { ...entry, state: 'finished' },
          status: 'alreadyFinished',
          message: `✔ Already finished: ${label}`,
        };
      }
      if (e.code === 'PUBLIC_DECRYPT_PENDING') {
        if (i < opts.tries - 1 && backend.kind !== 'mock') {
          console.log(
            chalk.dim('  Waiting for the public decryption; trying again in 10 seconds...'),
          );
          await new Promise((r) => setTimeout(r, PUBLIC_DECRYPT_WAIT_MS));
          continue;
        }
        return {
          entry,
          status: 'pending',
          message: `Step 1 is done; the amount is not decryptable yet. Run \`fhew unwrap --resume\` in a minute to finish ${label}.`,
        };
      }
      return {
        entry,
        status: 'error',
        message: `Step 2 stopped. Nothing was signed or sent.\n${formatTxError(e)}`,
        error: e,
      };
    }
    if (!opts.confirmed) {
      const ok = await confirmSummary({
        backend,
        network: entry.network,
        title: `Finish unwrap: ${label}`,
        lines: [
          `You get:   ${amt(prepared.receive, u.decimals, u.symbol)} (public; ${amt(prepared.value, entry.decimals, entry.symbol)} were burnt)`,
          `Request:   ${entry.requestTxHash}`,
        ],
        feeLine: `up to ${formatEther(prepared.feeWei)} ETH (you have ${formatEther(prepared.ethBalanceWei)} ETH)`,
        warnings: [UNWRAP_PRIVACY],
        yes: options.yes,
        question: 'Send step 2 (finish)?',
      });
      if (!ok) return { entry, status: 'cancelled', message: 'Cancelled. Nothing was sent.' };
    }
    if (prepared.value === 0n) {
      const r = await sendFinish(prepared, entry);
      return {
        entry: r.entry,
        status: 'finished',
        message: `! ${label}: the request burnt 0 (the balance was short), so nothing arrives.`,
        receivedBaseUnits: 0n,
      };
    }
    const spin = ora('Sending step 2 (finish) and waiting for confirmation...').start();
    try {
      const r = await sendFinish(prepared, entry);
      spin.succeed(`Step 2 confirmed: ${r.txHash}`);
      return {
        entry: r.entry,
        status: 'finished',
        message: `✔ Unwrapped ${amt(prepared.value, entry.decimals, entry.symbol)}: ${amt(prepared.receive, u.decimals, u.symbol)} arrived.`,
        finalizeTxHash: r.txHash,
        receivedBaseUnits: prepared.receive,
      };
    } catch (err) {
      const e = translateTxError(err);
      if (e.code === 'SENT_UNCONFIRMED') spin.warn('Step 2 sent, not confirmed yet');
      else spin.fail('Step 2 failed');
      return {
        entry,
        status: 'error',
        message: formatTxError(e),
        error: e,
        finalizeTxHash: e.txHash,
      };
    }
  }
  return {
    entry,
    status: 'pending',
    message: 'Not finished yet. Run `fhew unwrap --resume` later.',
  };
}

/** JSON for one entry. */
function entryJson(e: UnwrapEntry) {
  return {
    id: e.id,
    state: e.state,
    stage: describeUnwrapState(e),
    token: { address: e.token, symbol: e.symbol, decimals: e.decimals },
    underlying: e.underlying,
    amount: { baseUnits: e.amount, formatted: formatExactAmount(BigInt(e.amount), e.decimals) },
    requestTxHash: e.requestTxHash,
    requestId: e.requestId ?? null,
    finalizeTxHash: e.finalizeTxHash ?? null,
    finishedBy: e.finishedBy ?? null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** Print the outcomes (text) or one JSON document; exit 1 when one failed. */
async function reportOutcomes(
  backend: Backend,
  walletRef: { name: string; address: string },
  outcomes: FinishOutcome[],
  options: UnwrapOptions,
  info?: WrapperInfo,
): Promise<void> {
  const bad = outcomes.some((o) => o.status === 'error' || o.status === 'failed');
  if (bad) process.exitCode = 1;
  if (options.json) {
    const results = outcomes.map((o) => ({
      ...entryJson(o.entry),
      status: o.status,
      message: o.message,
      finalizeExplorerUrl: o.finalizeTxHash
        ? backend.explorerTxUrl(o.finalizeTxHash, o.entry.network)
        : null,
      ...(o.error
        ? {
            error: { code: o.error.code, message: o.error.message, txHash: o.error.txHash ?? null },
          }
        : {}),
    }));
    if (info && results.length === 1) {
      return printJson({
        ...docBase(backend, outcomes[0].entry.network, walletRef, info),
        ...results[0],
      });
    }
    return printJson({
      mock: mockJson(),
      wallet: walletJson(walletRef.address, walletRef.name),
      results,
    });
  }
  for (const o of outcomes) {
    const color =
      o.status === 'finished' || o.status === 'alreadyFinished'
        ? chalk.green
        : o.status === 'error' || o.status === 'failed'
          ? chalk.red
          : chalk.yellow;
    console.log(color(o.message));
  }
  // The public balance after, for the unwrapped tokens that arrived.
  for (const o of outcomes.filter((x) => x.receivedBaseUnits)) {
    try {
      const bal = await backend.underlyingBalance(
        entryInfo(o.entry),
        o.entry.wallet,
        o.entry.network,
      );
      console.log(
        chalk.dim(
          `  ${o.entry.underlying.symbol} balance (public): ${amt(bal, o.entry.underlying.decimals, o.entry.underlying.symbol)}`,
        ),
      );
    } catch {
      // the finish is confirmed; the balance line is a convenience
    }
  }
}

async function listCommand(options: UnwrapOptions): Promise<void> {
  const network = pickNetwork(options.network);
  if (!network) return;
  const walletRef = pickWallet(options.wallet);
  if (!walletRef) return;
  const entries = listUnwraps({ network, wallet: walletRef.address, open: !options.all });
  if (options.json) {
    return printJson({
      mock: mockJson(),
      network,
      wallet: walletJson(walletRef.address, walletRef.name),
      unwraps: entries.map(entryJson),
    });
  }
  if (!entries.length) {
    console.log(
      chalk.dim(
        options.all ? 'No unwraps recorded for this wallet.' : 'No unwraps waiting to finish.',
      ),
    );
    return;
  }
  for (const e of entries) {
    console.log(
      `${bold(amt(BigInt(e.amount), e.decimals, e.symbol))} → ${e.underlying.symbol}  ${describeUnwrapState(e)}  ${chalk.dim(`id ${e.id.slice(0, 12)}… · ${e.createdAt.slice(0, 16).replace('T', ' ')}`)}`,
    );
  }
  if (entries.some((e) => e.state !== 'finished' && e.state !== 'failed')) {
    console.log(chalk.dim('Finish them with: fhew unwrap --resume'));
  }
}

/** Pick the open entries a --resume / --forget reference means (all open ones without one). */
function pickEntries(
  ref: string | undefined,
  network: NetworkName,
  wallet: string,
  open: boolean,
): UnwrapEntry[] | null {
  if (!ref) return listUnwraps({ network, wallet, open });
  const found = findUnwrap(ref, { network, wallet });
  if (found.length === 1) return found;
  fail(
    found.length
      ? 'That matches more than one unwrap. Give more of the hash.'
      : 'No unwrap of this wallet matches that hash or id. See `fhew unwrap --list --all`.',
    'UNWRAP_NOT_FOUND',
  );
  return null;
}

async function resumeCommand(ref: string | undefined, options: UnwrapOptions): Promise<void> {
  const network = pickNetwork(options.network);
  if (!network) return;
  if (!mainnetAllowed(network, options, 'finish an unwrap on Mainnet')) return;
  if (!jsonPromptsCovered(options)) return;
  const walletRef = pickWallet(options.wallet);
  if (!walletRef) return;
  const entries = pickEntries(ref, network, walletRef.address, true);
  if (!entries) return;
  if (!entries.length) {
    if (options.json) {
      return printJson({
        mock: mockJson(),
        wallet: walletJson(walletRef.address, walletRef.name),
        results: [],
      });
    }
    console.log(chalk.dim('No unwraps waiting to finish.'));
    return;
  }
  const backend = createBackend();
  const notReady = backend.readinessProblem(network);
  if (notReady) return fail(notReady, 'FHE_NOT_READY');
  // Unlock only when a step 2 is actually due (checking needs no key).
  let wallet: UnlockedSigner | null = null;
  let asked = false;
  const unlock = async () => {
    if (!asked) {
      asked = true;
      wallet = await unlockWallet(walletRef.name, network, options.passwordStdin);
    }
    return wallet;
  };
  const outcomes: FinishOutcome[] = [];
  for (const e of entries) {
    outcomes.push(
      await finishOne(
        backend,
        wallet,
        e,
        options,
        { tries: ref ? PUBLIC_DECRYPT_TRIES : 1, confirmed: false },
        unlock,
      ),
    );
  }
  await reportOutcomes(backend, walletRef, outcomes, options);
}

async function forgetCommand(ref: string, options: UnwrapOptions): Promise<void> {
  const network = pickNetwork(options.network);
  if (!network) return;
  if (!jsonPromptsCovered({ yes: options.yes, passwordStdin: true })) return;
  const walletRef = pickWallet(options.wallet);
  if (!walletRef) return;
  const found = pickEntries(ref, network, walletRef.address, false);
  if (!found) return;
  let e = found[0];
  if (e.state === 'requested' || e.state === 'finalizing') {
    return fail(
      'This unwrap is waiting for step 2: its tokens are burnt and the ERC-20 has not been sent yet. Finish it with `fhew unwrap --resume` instead.',
      'UNWRAP_STILL_OPEN',
    );
  }
  if (e.state === 'signed') {
    // Only a request the chain does not know (dropped) may be forgotten.
    const backend = createBackend();
    const r = await reconcileUnwrap(backend, e);
    e = r.entry;
    if (
      !(r.next.kind === 'wait-request' && r.next.missing) &&
      r.next.kind !== 'failed' &&
      r.next.kind !== 'done'
    ) {
      return fail(
        'The network knows this request, so it may still be mined or is already waiting for step 2. Run `fhew unwrap --resume` instead.',
        'UNWRAP_STILL_OPEN',
      );
    }
  }
  if (!options.yes) {
    if (!process.stdin.isTTY)
      return fail('Pass --yes to remove it without asking.', 'PROMPT_NOT_ALLOWED');
    const ok = await prompts.confirm({
      message: `Remove the unwrap ${e.id.slice(0, 12)}… from the list?`,
      default: false,
    });
    if (!ok) return void console.log('Kept.');
  }
  removeUnwrap(e.id);
  if (options.json) {
    return printJson({
      mock: mockJson(),
      network,
      wallet: walletJson(walletRef.address, walletRef.name),
      removed: entryJson(e),
    });
  }
  console.log(success(`Removed ${e.id.slice(0, 12)}… from the list.`));
}
