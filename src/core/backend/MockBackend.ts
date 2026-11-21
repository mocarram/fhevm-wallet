/**
 * Offline, deterministic stand-in for the chain and the Zama relayer, selected with
 * `FHEW_BACKEND=mock`. Used by e2e tests and demos. Never the default.
 *
 * What is simulated (all in memory, per process):
 * - a small catalogue of ERC-7984 tokens per network, with starting balances
 * - ETH for gas (`FHEW_MOCK_ETH`, default 0.421). With `FHEW_MOCK_ETH=0` the first check
 *   reports 0 and the next one "receives" 0.5 ETH, like a faucet drip during setup
 * - latency on decrypt / prepare (`FHEW_MOCK_LATENCY_MS`, default 300) and a delay between
 *   broadcast and confirmation (`FHEW_MOCK_CONFIRM_MS`, default 2500)
 * - failures (`FHEW_MOCK_FAIL`): `simulate` (contract rejects during simulation),
 *   `unconfirmed` (broadcast, then the confirmation is lost), `reverted` (mined, reverted),
 *   `replaced` (another transaction took the nonce), `rpc` (RPC unreachable)
 *
 * Failures are built as ethers-shaped errors and passed through the real translation
 * (`translateTxError` / `sentButUnconfirmed`), so the UI sees exactly what it would see on
 * a real network. Local storage (keystores, contacts, tokens, balance cache, history) is
 * the real one under the data directory.
 */

import { getAddress, id, parseEther } from 'ethers';
import type { NetworkName } from '../network/NetworkConfig.js';
import { NETWORK_CONFIGS } from '../network/NetworkConfig.js';
import type { RpcProbe } from '../network/ProviderFactory.js';
import { sentButUnconfirmed, translateTxError, WalletTxError } from '../token/txErrors.js';
import { ERC7984_INTERFACE, type TokenInfo } from '../token/TokenService.js';
import { setCachedBalance } from '../token/BalanceCache.js';
import { assertTransferAmount } from '../token/TokenService.js';
import type { TokenEntry } from '../token/TokenRegistry.js';
import type { TokenCheck } from '../token/erc7984Check.js';
import type { KnownToken } from '../token/tokenLists.js';
import type { ScanOptions, ScanResult } from '../token/tokenScan.js';
import { upsertTransactions } from '../../storage/TransactionStore.js';
import type {
  Backend,
  HistorySyncResult,
  PreparedSend,
  RelayerCheck,
  RpcCheck,
  RpcEndpointCheck,
  SendResult,
  UnlockedSigner,
} from './types.js';

/** Failure modes the mock can inject. */
export type MockFailure = 'simulate' | 'unconfirmed' | 'reverted' | 'replaced' | 'rpc';

/** Tunables, normally read from the environment by `mockOptionsFromEnv`. */
export interface MockOptions {
  latencyMs: number;
  confirmMs: number;
  /** Starting ETH balance in wei for every wallet. */
  ethWei: bigint;
  fail?: MockFailure;
  /** Wait function; tests pass one that resolves immediately. */
  sleep?: (ms: number) => Promise<void>;
}

/** Gas a mock confidential transfer uses, and the mock gas price (1 gwei). */
const MOCK_GAS = 300_000n;
const MOCK_GAS_PRICE = 1_000_000_000n;
/** ETH the simulated faucet drips when a wallet starts with 0. */
const FAUCET_WEI = parseEther('0.5');

/** Deterministic, valid-checksum address derived from a label. */
function mockAddress(label: string): string {
  return getAddress('0x' + id(`fhew-mock:${label}`).slice(-40));
}

interface MockToken extends TokenInfo {
  /** Balance every wallet starts with, in base units. */
  start: bigint;
}

/** The mock catalogue. Addresses are stable, so tests and docs can paste them. */
function catalogue(network: NetworkName): MockToken[] {
  return [
    {
      address: mockAddress(`${network}:cUSDC`),
      name: 'Confidential USDC',
      symbol: 'cUSDC',
      decimals: 6,
      start: 1_250_000_000n,
    },
    {
      address: mockAddress(`${network}:cDAI`),
      name: 'Confidential DAI',
      symbol: 'cDAI',
      decimals: 6,
      start: 80_500_000n,
    },
  ];
}

/**
 * A contract the mock treats as a plain ERC-20 (it has a name but no confidential
 * balance), so tests and demos can see a refused token. Stable per network.
 */
export function mockNonConfidentialToken(network: NetworkName): string {
  return mockAddress(`${network}:plain-erc20`);
}

/** A compliant mock token that is on no list: "found in your history", unverified. */
export function mockGiftToken(network: NetworkName): string {
  return mockAddress(`${network}:cGIFT`);
}

/** Where the mock chain's history starts. */
const MOCK_SCAN_START = 6_990_000;

/** Read mock settings from `FHEW_MOCK_*` variables (see the module comment). */
export function mockOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): MockOptions {
  const num = (v: string | undefined, dflt: number) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  let ethWei = parseEther('0.421');
  try {
    if (env.FHEW_MOCK_ETH) ethWei = parseEther(env.FHEW_MOCK_ETH);
  } catch {
    // Keep the default on a malformed value: this is a test knob, not user data.
  }
  const fail = env.FHEW_MOCK_FAIL as MockFailure | undefined;
  const known: MockFailure[] = ['simulate', 'unconfirmed', 'reverted', 'replaced', 'rpc'];
  return {
    latencyMs: num(env.FHEW_MOCK_LATENCY_MS, 300),
    confirmMs: num(env.FHEW_MOCK_CONFIRM_MS, 2500),
    ethWei,
    fail: fail && known.includes(fail) ? fail : undefined,
  };
}

/** In-memory simulation of chain + relayer. */
export class MockBackend implements Backend {
  readonly kind = 'mock' as const;
  private readonly opts: MockOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  /** wei per lowercase address */
  private readonly eth = new Map<string, bigint>();
  /** base units per `${network}:${token}:${wallet}` (lowercase) */
  private readonly balances = new Map<string, bigint>();
  /** wallets that already had their 0-ETH faucet drip */
  private readonly dripped = new Set<string>();
  /** histories already seeded, per `${network}:${wallet}` */
  private readonly seeded = new Set<string>();
  private block = 7_000_000;
  private nonce = 0;

  constructor(opts: Partial<MockOptions> = {}) {
    this.opts = { ...mockOptionsFromEnv({}), ...opts };
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The token catalogue for `network` (exposed for tests and first-run setup). */
  catalogue(network: NetworkName): TokenInfo[] {
    return catalogue(network).map(({ start: _start, ...info }) => info);
  }

  readinessProblem(): string | null {
    return null; // the mock needs no relayer or API key
  }

  private rpcFailure(): void {
    if (this.opts.fail === 'rpc') {
      throw translateTxError(
        Object.assign(new Error('fetch failed (mock)'), { code: 'NETWORK_ERROR' }),
      );
    }
  }

  private ethOf(address: string): bigint {
    const key = address.toLowerCase();
    if (!this.eth.has(key)) this.eth.set(key, this.opts.ethWei);
    return this.eth.get(key)!;
  }

  async getEthBalance(address: string): Promise<bigint> {
    await this.sleep(Math.min(this.opts.latencyMs, 100));
    this.rpcFailure();
    const key = address.toLowerCase();
    const wei = this.ethOf(address);
    if (wei === 0n && !this.dripped.has(key)) {
      // First look at an empty wallet: report 0 now, "receive" faucet ETH by the next look.
      this.dripped.add(key);
      this.eth.set(key, FAUCET_WEI);
      return 0n;
    }
    return wei;
  }

  async getTokenInfo(tokenAddress: string, network: NetworkName): Promise<TokenInfo> {
    await this.sleep(this.opts.latencyMs);
    this.rpcFailure();
    const known = catalogue(network).find(
      (t) => t.address.toLowerCase() === tokenAddress.toLowerCase(),
    );
    if (known) {
      const { start: _start, ...info } = known;
      return info;
    }
    if (getAddress(tokenAddress) === mockGiftToken(network)) {
      return {
        address: getAddress(tokenAddress),
        name: 'Gift Token',
        symbol: 'cGIFT',
        decimals: 6,
      };
    }
    // Any other address is treated as a token too, with a name derived from it.
    const tag = getAddress(tokenAddress).slice(2, 6).toUpperCase();
    return {
      address: getAddress(tokenAddress),
      name: `Mock token ${tag}`,
      symbol: `cM${tag}`,
      decimals: 6,
    };
  }

  async checkToken(tokenAddress: string, network: NetworkName): Promise<TokenCheck> {
    await this.sleep(Math.min(this.opts.latencyMs, 100));
    this.rpcFailure();
    const address = getAddress(tokenAddress);
    if (address === mockNonConfidentialToken(network)) {
      return {
        address,
        info: { address, name: 'Plain Token', symbol: 'PLAIN', decimals: 18 },
        erc165: 'absent',
        balanceHandle: false,
        compliant: false,
        problems: [
          'It did not answer confidentialBalanceOf() with an encrypted balance, so it is not an ERC-7984 confidential token.',
        ],
        warnings: [],
      };
    }
    const info = await this.getTokenInfo(address, network);
    // Catalogue tokens report the ERC-7984 interface id; others behave like older tokens.
    const known = catalogue(network).some((t) => t.address === address);
    return {
      address,
      info,
      erc165: known ? 'yes' : 'absent',
      balanceHandle: true,
      compliant: true,
      problems: [],
      warnings: [],
    };
  }

  private balanceKey(network: NetworkName, token: string, wallet: string): string {
    return `${network}:${token}:${wallet}`.toLowerCase();
  }

  private balanceOf(network: NetworkName, token: string, wallet: string): bigint {
    const key = this.balanceKey(network, token, wallet);
    if (!this.balances.has(key)) {
      const known = catalogue(network).find((t) => t.address.toLowerCase() === token.toLowerCase());
      this.balances.set(key, known ? known.start : 1_000_000_000n);
    }
    return this.balances.get(key)!;
  }

  async decryptBalance(
    tokenAddress: string,
    signer: UnlockedSigner,
    network: NetworkName,
  ): Promise<bigint> {
    await this.sleep(this.opts.latencyMs);
    this.rpcFailure();
    const value = this.balanceOf(network, tokenAddress, signer.address);
    // Keep the real cache in step so Home can show "cached 2m ago" after a restart.
    try {
      setCachedBalance(signer.address, tokenAddress, network, BigInt(id(`h:${value}`)), value);
    } catch {
      // Cache is an optimisation; ignore disk errors like the real path does.
    }
    return value;
  }

  async prepareTransfer(
    signer: UnlockedSigner,
    tokenAddress: string,
    to: string,
    amount: bigint,
    network: NetworkName,
  ): Promise<PreparedSend> {
    assertTransferAmount(amount);
    await this.sleep(this.opts.latencyMs);
    this.rpcFailure();
    const from = signer.address;
    const tokenBalance = this.balanceOf(network, tokenAddress, from);
    if (amount > tokenBalance) {
      throw new WalletTxError(
        'INSUFFICIENT_TOKEN_BALANCE',
        'That is more than this wallet holds.',
        'ERC-7984 would send 0 instead of failing, so the wallet stops the send here.',
        'Enter a smaller amount, or check you picked the right wallet and token.',
      );
    }
    if (this.opts.fail === 'simulate') {
      // The shape ethers gives when estimateGas hits a contract without the function.
      throw translateTxError(
        Object.assign(
          new Error('missing revert data (mock: estimateGas on ' + tokenAddress + ')'),
          {
            code: 'CALL_EXCEPTION',
            action: 'estimateGas',
            data: null,
          },
        ),
        { iface: ERC7984_INTERFACE },
      );
    }
    const feeWei = MOCK_GAS * MOCK_GAS_PRICE;
    const ethBalanceWei = this.ethOf(from);
    if (ethBalanceWei < feeWei) {
      throw new WalletTxError(
        'INSUFFICIENT_GAS_FUNDS',
        'Not enough ETH to pay the network fee.',
        'Every send needs a little ETH for gas, even though the token amount is encrypted.',
        'Add ETH to this wallet (on Sepolia, use a faucet) and try again.',
      );
    }

    let used = false;
    const send: PreparedSend['send'] = async (hooks = {}) => {
      // A prepared transfer is single-use, like a signed transaction with one nonce.
      if (used) throw new Error('This prepared send was already used.');
      used = true;
      const txHash = id(`fhew-mock-tx:${network}:${from}:${to}:${amount}:${this.nonce++}`);
      const explorer = this.explorerTxUrl(txHash, network);
      safe(() => hooks.onSigned?.(txHash));
      safe(() => hooks.onBroadcast?.(txHash));
      await this.sleep(this.opts.confirmMs);
      const blockNumber = ++this.block;

      if (this.opts.fail === 'unconfirmed') {
        throw sentButUnconfirmed(
          Object.assign(new Error('timeout (mock)'), { code: 'TIMEOUT' }),
          txHash,
          explorer,
        );
      }
      if (this.opts.fail === 'reverted') {
        this.eth.set(from.toLowerCase(), this.ethOf(from) - feeWei); // gas is paid anyway
        throw sentButUnconfirmed(
          Object.assign(new Error('transaction execution reverted (mock)'), {
            code: 'CALL_EXCEPTION',
            action: 'sendTransaction',
            receipt: { hash: txHash, status: 0 },
          }),
          txHash,
          explorer,
        );
      }
      if (this.opts.fail === 'replaced') {
        const other = id(`fhew-mock-replacement:${txHash}`);
        throw sentButUnconfirmed(
          Object.assign(new Error('transaction was replaced (mock)'), {
            code: 'TRANSACTION_REPLACED',
            reason: 'replaced',
            hash: other,
            replacement: { hash: other },
            receipt: { hash: other, status: 1 },
          }),
          txHash,
          explorer,
        );
      }

      // Confirmed: move the tokens, pay the fee, credit the recipient.
      const after = this.balanceOf(network, tokenAddress, from) - amount;
      this.balances.set(this.balanceKey(network, tokenAddress, from), after);
      const toKey = this.balanceKey(network, tokenAddress, to);
      this.balances.set(toKey, this.balanceOf(network, tokenAddress, to) + amount);
      this.eth.set(from.toLowerCase(), this.ethOf(from) - feeWei);
      const result: SendResult = {
        txHash,
        blockNumber,
        balanceCheck: 'moved',
        balanceAfter: after,
      };
      return result;
    };

    return { feeWei, ethBalanceWei, tokenBalance, send };
  }

  async syncHistory(
    address: string,
    network: NetworkName,
    tokens: TokenEntry[],
  ): Promise<HistorySyncResult> {
    await this.sleep(this.opts.latencyMs);
    this.rpcFailure();
    const key = `${network}:${address}`.toLowerCase();
    if (this.seeded.has(key) || tokens.length === 0) return { newCount: 0, method: 'mock' };
    this.seeded.add(key);
    // One incoming confidential transfer (amount encrypted, as the chain shows it) and one
    // incoming ETH transfer, at fixed blocks and times so output is stable.
    const faucet = mockAddress('faucet');
    const sender = mockAddress('sender');
    upsertTransactions([
      {
        txHash: id(`fhew-mock-in:${key}:token`),
        type: 'transfer',
        tokenAddress: tokens[0].address,
        tokenSymbol: tokens[0].symbol,
        from: sender,
        to: address,
        amount: null,
        network,
        blockNumber: 6_999_000,
        timestamp: '2026-11-18T09:40:00.000Z',
      },
      {
        txHash: id(`fhew-mock-in:${key}:eth`),
        type: 'eth',
        tokenAddress: '0x0000000000000000000000000000000000000000',
        tokenSymbol: 'ETH',
        from: faucet,
        to: address,
        amount: '0.5',
        network,
        blockNumber: 6_998_000,
        timestamp: '2026-11-15T11:03:00.000Z',
      },
    ]);
    return { newCount: 2, method: 'mock' };
  }

  async checkRpc(network: NetworkName): Promise<RpcCheck> {
    await this.sleep(Math.min(this.opts.latencyMs, 100));
    this.rpcFailure();
    const chainId = NETWORK_CONFIGS[network].chainId;
    return { url: 'mock://rpc', chainId, latencyMs: 12, chainMatches: true };
  }

  async knownTokens(network: NetworkName): Promise<{ tokens: KnownToken[] }> {
    // The catalogue stands in for a curated list; the real shipped lists stay untouched.
    return { tokens: this.catalogue(network).map((t) => ({ ...t, list: 'mock list' })) };
  }

  scanStartBlock(): number {
    return MOCK_SCAN_START;
  }

  /**
   * Simulated log scan in four chunks (with latency, progress and cancellation): it
   * "finds" cDAI (also on the known list), a gift token that is on no list, and the
   * plain ERC-20 that fails the ERC-7984 check. A resumed scan finds nothing new.
   */
  async scanReceivedTokens(
    _address: string,
    network: NetworkName,
    opts: Omit<ScanOptions, 'toBlock'>,
  ): Promise<ScanResult> {
    const toBlock = this.block;
    const fromBlock = Math.max(opts.fromBlock, MOCK_SCAN_START);
    const found = new Set<string>();
    const hits = [
      catalogue(network)[1].address,
      mockGiftToken(network),
      mockNonConfidentialToken(network),
    ];
    const span = Math.max(1, Math.ceil((toBlock - fromBlock + 1) / 4));
    let scannedTo = fromBlock - 1;
    for (let at = fromBlock; at <= toBlock; at += span) {
      if (opts.signal?.aborted) {
        return { contracts: [...found], fromBlock, toBlock, scannedTo, cancelled: true };
      }
      await this.sleep(this.opts.latencyMs);
      if (this.opts.fail === 'rpc') {
        return {
          contracts: [...found],
          fromBlock,
          toBlock,
          scannedTo,
          cancelled: false,
          error: translateTxError(
            Object.assign(new Error('fetch failed (mock)'), { code: 'NETWORK_ERROR' }),
          ),
        };
      }
      const end = Math.min(at + span - 1, toBlock);
      // Each hit sits at a fixed block, so a resumed scan only finds what is new.
      hits.forEach((h, i) => {
        const block = MOCK_SCAN_START + 1000 + i * 1000;
        if (block >= at && block <= end) found.add(h);
      });
      scannedTo = end;
      opts.onProgress?.({ fromBlock, toBlock, current: end, found: found.size });
    }
    return { contracts: [...found], fromBlock, toBlock, scannedTo, cancelled: false };
  }

  async checkRpcEndpoints(network: NetworkName): Promise<RpcEndpointCheck[]> {
    await this.sleep(Math.min(this.opts.latencyMs, 100));
    if (this.opts.fail === 'rpc') {
      return [
        {
          url: 'mock://rpc',
          ok: false,
          error: 'That RPC endpoint did not answer. Check the URL and your connection.',
        },
      ];
    }
    const chainId = NETWORK_CONFIGS[network].chainId;
    return [
      {
        url: 'mock://rpc',
        ok: true,
        chainId,
        chainMatches: true,
        latencyMs: 12,
        blockNumber: this.block,
      },
    ];
  }

  async checkRelayer(): Promise<RelayerCheck> {
    await this.sleep(Math.min(this.opts.latencyMs, 100));
    return { url: 'mock://relayer', ok: true, status: 200, latencyMs: 9 };
  }

  async setCustomRpc(network: NetworkName, url: string): Promise<RpcProbe> {
    // Validate the shape like the real path, but never contact or save the URL: a demo
    // must not change the user's real settings.
    const { validateRpcUrl } = await import('../network/rpcSettings.js');
    const problem = validateRpcUrl(url);
    if (problem) throw new Error(problem);
    return { chainId: NETWORK_CONFIGS[network].chainId, latencyMs: 12 };
  }

  suggestedTokens(network: NetworkName): TokenInfo[] {
    return this.catalogue(network).slice(0, 1);
  }

  explorerTxUrl(txHash: string, network: NetworkName): string {
    return `${NETWORK_CONFIGS[network].explorerUrl}/tx/${txHash}`;
  }
}

/** Run a UI callback, ignoring its errors (they must never fail a send). */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // intentionally ignored
  }
}
