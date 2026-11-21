/**
 * The checks behind `fhew doctor` and the TUI Doctor screen. One list of rows, each
 * `ok`, `warn` (worth fixing, nothing is broken), `fail` (something will not work) or
 * `info`. `fhew doctor` exits 1 when any row is `fail`.
 *
 * Network access goes through the Backend, so the same checks run against the offline
 * mock. Nothing here signs, decrypts or needs the wallet password.
 */

import { statSync } from 'fs';
import type { Backend } from './backend/types.js';
import type { NetworkName } from './network/NetworkConfig.js';
import type { TokenEntry } from './token/TokenRegistry.js';
import { LOW_GAS_SENDS, sendsLeft } from './send/gas.js';
import { formatBalance } from './send/amount.js';
import { assertTrustedDataDir } from '../storage/paths.js';
import { translateTxError } from './token/txErrors.js';

/** One line of doctor output. `id` is stable, for `--json` consumers. */
export interface DoctorRow {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  text: string;
  detail?: string;
}

/** What the checks look at. */
export interface DoctorInput {
  backend: Backend;
  network: NetworkName;
  /** Wallet whose ETH is checked; omitted when there is no wallet yet. */
  address?: string;
  tokens: TokenEntry[];
  dataDir: string;
  etherscanKey: boolean;
  nodeVersion?: string;
}

/** Node version check: the wallet needs Node 24.11 or later. */
export function nodeVersionOk(version = process.versions.node): boolean {
  const [maj, min] = version.split('.').map(Number);
  return maj > 24 || (maj === 24 && min >= 11);
}

/** True when any row is a hard failure. */
export function doctorFailed(rows: DoctorRow[]): boolean {
  return rows.some((r) => r.status === 'fail');
}

function nodeRow(version: string): DoctorRow {
  return nodeVersionOk(version)
    ? { id: 'node', status: 'ok', text: `Node.js v${version}`, detail: '(needs 24.11 or later)' }
    : {
        id: 'node',
        status: 'fail',
        text: `Node.js v${version} is too old`,
        detail: 'Install Node.js 24.11 or later.',
      };
}

function dataDirRows(dataDir: string): DoctorRow[] {
  try {
    assertTrustedDataDir();
  } catch (err) {
    return [
      {
        id: 'data-dir',
        status: 'fail',
        text: 'The wallet data folder is not safe to use',
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
  }
  try {
    const mode = statSync(dataDir).mode & 0o777;
    return [
      (mode & 0o077) === 0
        ? {
            id: 'data-dir',
            status: 'ok',
            text: `Data folder is owner-only (${mode.toString(8).padStart(4, '0')})`,
          }
        : {
            id: 'data-dir',
            status: 'warn',
            text: `Data folder is readable by others (${mode.toString(8).padStart(4, '0')})`,
            detail: `Make it private with: chmod 700 ${dataDir}`,
          },
    ];
  } catch {
    return [{ id: 'data-dir', status: 'warn', text: "Couldn't check the data folder permissions" }];
  }
}

async function rpcRows(backend: Backend, network: NetworkName): Promise<DoctorRow[]> {
  const checks = await backend.checkRpcEndpoints(network);
  const anyOk = checks.some((c) => c.ok);
  const rows: DoctorRow[] = checks.map((c, i) =>
    c.ok
      ? {
          id: `rpc.${i}`,
          status: 'ok',
          text: `RPC ${c.url} · chain ${c.chainId} (${network})`,
          detail: `· block ${c.blockNumber ?? '?'} · ${c.latencyMs} ms`,
        }
      : {
          id: `rpc.${i}`,
          // A dead fallback is only a warning while another endpoint works.
          status: anyOk ? 'warn' : 'fail',
          text: `RPC ${c.url} is not usable`,
          detail: c.error,
        },
  );
  if (!anyOk) {
    rows.push({
      id: 'rpc',
      status: 'fail',
      text: 'No RPC endpoint works for this network',
      detail: `Check your connection, or set another URL: fhew config --rpc-${network} - (or Settings › RPC endpoint).`,
    });
  }
  return rows;
}

async function relayerRows(backend: Backend, network: NetworkName): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const ready = backend.readinessProblem(network);
  if (ready) rows.push({ id: 'relayer.settings', status: 'fail', text: ready });
  const r = await backend.checkRelayer(network);
  rows.push(
    r.ok
      ? {
          id: 'relayer',
          status: 'ok',
          text: `Zama relayer ${r.url} answers`,
          detail: `· ${r.latencyMs} ms`,
        }
      : {
          id: 'relayer',
          status: 'fail',
          text: `Zama relayer ${r.url} is not reachable`,
          detail: `${r.error ?? ''} Balances and sends need it.`.trim(),
        },
  );
  return rows;
}

async function ethRow(backend: Backend, network: NetworkName, address: string): Promise<DoctorRow> {
  try {
    const wei = await backend.getEthBalance(address, network);
    const left = sendsLeft(wei);
    const eth = formatBalance(wei, 18, 4);
    if (wei === 0n) {
      return {
        id: 'eth',
        status: 'fail',
        text: 'No ETH for gas',
        detail:
          network === 'sepolia'
            ? 'Every send needs a little ETH. Get test ETH from a Sepolia faucet (see Receive).'
            : 'Every send needs a little ETH. Send some to this wallet.',
      };
    }
    return left < LOW_GAS_SENDS
      ? { id: 'eth', status: 'warn', text: `ETH for gas · ${eth} ETH covers about ${left} sends` }
      : { id: 'eth', status: 'ok', text: `ETH for gas · ${eth} ETH` };
  } catch {
    return { id: 'eth', status: 'warn', text: "Couldn't read the ETH balance" };
  }
}

async function tokenRows(
  backend: Backend,
  network: NetworkName,
  tokens: TokenEntry[],
): Promise<DoctorRow[]> {
  if (!tokens.length) {
    return [
      {
        id: 'tokens',
        status: 'warn',
        text: `No tokens tracked on ${network}`,
        detail: 'Add one with: fhew token add <address>, or fhew token find.',
      },
    ];
  }
  return Promise.all(
    tokens.map(async (t): Promise<DoctorRow> => {
      const id = `token.${t.address}`;
      try {
        const c = await backend.checkToken(t.address, network);
        if (!c.compliant) {
          return {
            id,
            status: 'fail',
            text: `${t.symbol} is not an ERC-7984 token`,
            detail: `${c.problems.join(' ')} Remove it with: fhew token remove ${t.address}`,
          };
        }
        return c.warnings.length
          ? { id, status: 'warn', text: `${t.symbol} · ERC-7984`, detail: c.warnings.join(' ') }
          : {
              id,
              status: 'ok',
              text: `${t.symbol} · ERC-7984`,
              detail: c.erc165 === 'yes' ? '(reports the interface id)' : '(behaves like one)',
            };
      } catch (err) {
        return {
          id,
          status: 'warn',
          text: `${t.symbol}: couldn't check it`,
          detail: translateTxError(err, { action: 'token check' }).message,
        };
      }
    }),
  );
}

/** Run every check. Never throws: a failing check is a `fail` row. */
export async function runDoctorChecks(input: DoctorInput): Promise<DoctorRow[]> {
  const { backend, network } = input;
  const [rpc, relayer, eth, tokens] = await Promise.all([
    rpcRows(backend, network).catch((): DoctorRow[] => [
      { id: 'rpc', status: 'fail', text: 'RPC check failed' },
    ]),
    relayerRows(backend, network),
    input.address ? ethRow(backend, network, input.address) : Promise.resolve(null),
    tokenRows(backend, network, input.tokens),
  ]);
  return [
    nodeRow(input.nodeVersion ?? process.versions.node),
    ...dataDirRows(input.dataDir),
    ...rpc,
    ...relayer,
    ...(eth ? [eth] : []),
    ...tokens,
    input.etherscanKey
      ? { id: 'etherscan', status: 'ok', text: 'Etherscan key set (fast history)' }
      : {
          id: 'etherscan',
          status: 'info',
          text: 'No Etherscan key. History uses a slower RPC scan.',
          detail: 'Optional: fhew config --etherscan-key -',
        },
  ];
}
