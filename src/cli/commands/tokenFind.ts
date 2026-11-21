/**
 * `fhew token find`: list tokens this wallet may hold (known lists + its own transfer
 * history), each checked for ERC-7984, and optionally add some (`--add`, `--all-verified`).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { createBackend } from '../../core/backend/select.js';
import type { NetworkName } from '../../core/network/NetworkConfig.js';
import {
  findTokens,
  sourceLabel,
  type CandidateStatus,
  type FindResult,
  type TokenCandidate,
} from '../../core/token/findTokens.js';
import { addTokenWithInfo } from '../../core/token/TokenRegistry.js';
import { listWallets } from '../../core/wallet/index.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import { error, formatAddress, success, warning } from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork } from '../../utils/validation.js';
import { describeError } from '../utils/userError.js';
import { failJson, printJson, printJsonError } from '../utils/json.js';

interface FindCliOptions {
  network?: string;
  wallet?: string;
  address?: string;
  add?: string[];
  allVerified?: boolean;
  force?: boolean;
  scan?: boolean;
  fromBlock?: string;
  refreshList?: boolean;
  json?: boolean;
}

const STATUS_TEXT: Record<CandidateStatus, string> = {
  verified: chalk.green('verified'),
  unverified: chalk.yellow('unverified'),
  'not-erc7984': chalk.red('not ERC-7984'),
  unchecked: chalk.yellow("couldn't check"),
  tracked: chalk.dim('already tracked'),
};

/** Outcome of the add step. */
interface AddOutcome {
  added: Array<{ address: string; symbol: string }>;
  skipped: Array<{ address: string; reason: string }>;
}

/** Add the chosen candidates, following the same rules as the TUI. */
export function addCandidates(
  result: FindResult,
  network: NetworkName,
  wanted: string[],
  opts: { allVerified?: boolean; force?: boolean },
): AddOutcome {
  const out: AddOutcome = { added: [], skipped: [] };
  const picks = new Map<string, TokenCandidate | null>();
  if (opts.allVerified) {
    for (const c of result.candidates) if (c.status === 'verified') picks.set(c.address, c);
  }
  for (const w of wanted) {
    const c = result.candidates.find((x) => x.address.toLowerCase() === w.toLowerCase());
    picks.set(c?.address ?? w, c ?? null);
  }
  for (const [address, c] of picks) {
    if (!c) {
      out.skipped.push({
        address,
        reason: 'Not among the candidates. Add it by address with: fhew token add',
      });
      continue;
    }
    if (c.status === 'tracked') {
      out.skipped.push({ address, reason: 'Already tracked.' });
      continue;
    }
    if (c.status === 'unchecked') {
      out.skipped.push({ address, reason: `Could not be checked: ${c.problems.join(' ')}` });
      continue;
    }
    if (c.status === 'not-erc7984' && (!opts.force || !c.check?.info)) {
      out.skipped.push({
        address,
        reason: c.check?.info
          ? 'It failed the ERC-7984 check. Add it anyway with --force if you trust it.'
          : 'It is not a token contract.',
      });
      continue;
    }
    try {
      const entry = addTokenWithInfo(c.check!.info!, network);
      out.added.push({ address: entry.address, symbol: entry.symbol });
    } catch (err) {
      out.skipped.push({ address, reason: describeError(err, 'Could not add it.') });
    }
  }
  return out;
}

function candidateJson(c: TokenCandidate) {
  return {
    address: c.address,
    name: c.name,
    symbol: c.symbol,
    decimals: c.decimals,
    sources: c.sources,
    status: c.status,
    problems: c.problems,
    warnings: c.warnings,
  };
}

/** Register `fhew token find` under `token`. */
export function registerTokenFind(token: Command): void {
  token
    .command('find')
    .description('Find tokens you may hold: known lists plus transfers sent to your wallet')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-w, --wallet <name>', 'Wallet to look for (default: the default wallet)')
    .option('-a, --address <address>', 'Look for this address instead of a wallet')
    .option('--add <address...>', 'Add these candidates')
    .option('--all-verified', 'Add every verified candidate (known list + ERC-7984 check)')
    .option('-f, --force', 'With --add: also add candidates that fail the ERC-7984 check')
    .option('--no-scan', 'Only use the known lists; do not scan the history')
    .option('--from-block <n>', 'Scan from this block (default: where the last scan stopped)')
    .option('--refresh-list', 'Download your configured token list again now')
    .option('--json', 'Print machine-readable JSON')
    .action(async (options: FindCliOptions) => {
      const json = Boolean(options.json);
      const fail = (code: string, message: string) => {
        if (json) return printJsonError(code, message);
        process.exitCode = 1;
        console.log(error(message));
      };
      try {
        let network: NetworkName = getDefaultNetwork();
        if (options.network) {
          if (!isValidNetwork(options.network)) {
            return fail('INVALID_NETWORK', 'Invalid network. Use "sepolia" or "mainnet"');
          }
          network = options.network;
        }
        let address = options.address;
        if (address && !isValidAddress(address)) {
          return fail('INVALID_ADDRESS', 'Invalid address');
        }
        if (!address) {
          const wallets = listWallets();
          const name = options.wallet ?? getDefaultWallet() ?? wallets[0]?.name;
          const w = wallets.find((x) => x.name === name);
          if (!w) {
            return fail(
              'NO_WALLET',
              options.wallet
                ? `Wallet "${options.wallet}" not found`
                : 'No wallet yet. Create one, or pass --address.',
            );
          }
          address = w.address;
        }
        for (const a of options.add ?? []) {
          if (!isValidAddress(a)) return fail('INVALID_ADDRESS', `Invalid address: ${a}`);
        }
        let fromBlock: number | undefined;
        if (options.fromBlock !== undefined) {
          fromBlock = Number(options.fromBlock);
          if (!Number.isInteger(fromBlock) || fromBlock < 0) {
            return fail('INVALID_BLOCK', '--from-block must be a block number');
          }
        }

        const backend = createBackend();
        // Ctrl+C stops the scan between chunks; progress so far is saved.
        const ac = new AbortController();
        const onSigint = () => ac.abort();
        process.once('SIGINT', onSigint);
        const spinner = json ? null : ora('Reading the known token lists...').start();
        let result: FindResult;
        try {
          result = await findTokens(backend, address, network, {
            noScan: options.scan === false,
            fromBlock,
            refreshList: options.refreshList,
            signal: ac.signal,
            onProgress: (p) => {
              if (!spinner) return;
              const total = Math.max(1, p.toBlock - p.fromBlock + 1);
              const pct = Math.floor(((p.current - p.fromBlock + 1) / total) * 100);
              spinner.text = `Scanning your history: block ${p.current} of ${p.toBlock} (${pct}%), ${p.found} found. Ctrl+C stops and saves progress.`;
            },
            onChecking: (n) => {
              if (spinner) spinner.text = `Checking ${n} candidate(s) for ERC-7984...`;
            },
          });
        } finally {
          process.removeListener('SIGINT', onSigint);
        }
        spinner?.stop();

        const outcome =
          options.add?.length || options.allVerified
            ? addCandidates(result, network, options.add ?? [], options)
            : null;
        if (outcome && outcome.skipped.length && !outcome.added.length) process.exitCode = 1;

        if (json) {
          printJson({
            network,
            address,
            mock: backend.kind === 'mock',
            scan: result.scan,
            listError: result.listError ?? null,
            candidates: result.candidates.map(candidateJson),
            ...(outcome ? outcome : {}),
          });
          return;
        }

        if (backend.kind === 'mock') console.log(warning('MOCK: simulated, no real funds'));
        const s = result.scan;
        if (s?.cancelled)
          console.log(
            warning(
              `Scan stopped at block ${s.scannedTo}. Progress is saved; run again to continue.`,
            ),
          );
        else if (s?.error)
          console.log(
            warning(
              `Scan stopped early: ${s.error.message} Progress is saved; run again to continue.`,
            ),
          );
        else if (s && !s.upToDate)
          console.log(chalk.dim(`Scanned blocks ${s.fromBlock} to ${s.toBlock}.`));
        else if (s) console.log(chalk.dim(`History already scanned up to block ${s.toBlock}.`));
        if (result.listError) console.log(warning(`Your token list: ${result.listError}`));

        if (!result.candidates.length) {
          console.log(
            'No tokens found. The known lists are empty for this network and your history shows no confidential transfers.',
          );
        } else {
          const table = new Table({
            head: ['Symbol', 'Name', 'Address', 'Source', 'Status'],
            style: { head: ['cyan'] },
          });
          for (const c of result.candidates) {
            table.push([
              c.symbol,
              c.name,
              formatAddress(c.address),
              sourceLabel(c),
              STATUS_TEXT[c.status],
            ]);
          }
          console.log(table.toString());
          if (result.candidates.some((c) => c.status === 'unverified')) {
            console.log(
              chalk.dim(
                'Unverified: found in your history but on no known list. Anyone can send you a token; only add ones you recognise.',
              ),
            );
          }
        }
        if (outcome) {
          for (const a of outcome.added) console.log(success(`Added ${a.symbol} (${a.address})`));
          for (const k of outcome.skipped)
            console.log(warning(`Not added ${k.address}: ${k.reason}`));
        } else if (
          result.candidates.some((c) => c.status === 'verified' || c.status === 'unverified')
        ) {
          console.log(chalk.dim('Add with: fhew token find --all-verified, or --add <address> …'));
        }
      } catch (err) {
        if (json) return failJson(err, 'Could not look for tokens');
        process.exitCode = 1;
        console.log(error(describeError(err, 'Could not look for tokens')));
      }
    });
}
