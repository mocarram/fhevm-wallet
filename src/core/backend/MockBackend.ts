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

import { getAddress, hexlify, id, parseEther, randomBytes, verifyTypedData } from 'ethers';
import {
  DecryptSession,
  decryptDaysFromEnv,
  handleBits,
  MAX_BITS_PER_REQUEST,
  MAX_CONTRACTS_PER_SIGNATURE,
  normaliseHandle,
  type DecryptAuthority,
} from '../fhe/DecryptSession.js';
import { getAmountEntry } from '../../storage/AmountCache.js';
import {
  getTransactionByHash,
  isTransferAmountHandle,
  listTransactions,
} from '../../storage/TransactionStore.js';
import { getCachedBalance } from '../token/BalanceCache.js';
import type { NetworkName } from '../network/NetworkConfig.js';
import { NETWORK_CONFIGS } from '../network/NetworkConfig.js';
import type { RpcProbe } from '../network/ProviderFactory.js';
import {
  pendingPublicDecryption,
  sentButUnconfirmed,
  translateTxError,
  discloseIsBalanceError,
  discloseUnknownHandleError,
  type DiscloseRequestOptions,
  WalletTxError,
} from '../token/txErrors.js';
import { ERC7984_INTERFACE, type TokenInfo } from '../token/TokenService.js';
import { setCachedBalance } from '../token/BalanceCache.js';
import { assertRecipient, assertTransferAmount } from '../token/TokenService.js';
import type { TokenEntry } from '../token/TokenRegistry.js';
import type { TokenCheck } from '../token/erc7984Check.js';
import type { KnownToken } from '../token/tokenLists.js';
import type { ScanOptions, ScanResult } from '../token/tokenScan.js';
import { upsertTransactions } from '../../storage/TransactionStore.js';
import { MockWrapOps } from './mockWrap.js';
import type {
  AmountRequest,
  Backend,
  BalanceBatch,
  DiscloseStage,
  HistorySyncResult,
  PreparedDisclose,
  PreparedSend,
  RelayerCheck,
  PreparedTx,
  RpcCheck,
  RpcEndpointCheck,
  SendResult,
  UnlockedSigner,
} from './types.js';

/**
 * Failure modes the mock can inject. `public-pending`: public decryptions (unwrap step 2)
 * never become ready, so an unwrap stays pending for `fhew unwrap --resume`.
 */
export type MockFailure =
  'simulate' | 'unconfirmed' | 'reverted' | 'replaced' | 'rpc' | 'public-pending';

/** Tunables, normally read from the environment by `mockOptionsFromEnv`. */
export interface MockOptions {
  latencyMs: number;
  confirmMs: number;
  /** Starting ETH balance in wei for every wallet. */
  ethWei: bigint;
  fail?: MockFailure;
  /** Wait function; tests pass one that resolves immediately. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in ms (operator expiry, decrypt signatures); tests pass a fixed one. */
  now?: () => number;
}

/** EIP-712 the mock asks wallets to sign for user decryption (shape of the real one). */
const MOCK_DECRYPT_TYPES = {
  UserDecryptRequestVerification: [
    { name: 'publicKey', type: 'bytes' },
    { name: 'contractAddresses', type: 'address[]' },
    { name: 'startTimestamp', type: 'uint256' },
    { name: 'durationDays', type: 'uint256' },
  ],
};

/** A mock euint64 handle: 30 hash bytes, type byte 5 (euint64), version byte. */
function mockHandle(label: string): string {
  return '0x' + id(`fhew-mock-handle:${label}`).slice(2, 62) + '0500';
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
  const known: MockFailure[] = [
    'simulate',
    'unconfirmed',
    'reverted',
    'replaced',
    'rpc',
    'public-pending',
  ];
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
  /** Ciphertext handles the mock "chain" knows: value and who may decrypt (lowercase). */
  private readonly handles = new Map<string, { value: bigint; allowed: Set<string> }>();
  /** operator expiry (unix s) per `${network}:${token}:${holder}:${operator}` (lowercase) */
  private readonly operators = new Map<string, number>();
  /** handles made publicly decryptable (disclosure step 1) */
  private readonly publicHandles = new Set<string>();
  /** handles disclosed on the mock chain (step 2) */
  private readonly disclosedHandles = new Set<string>();
  /** userDecrypt requests served, for tests that count batching */
  userDecryptRequests = 0;

  constructor(opts: Partial<MockOptions> = {}) {
    this.opts = { ...mockOptionsFromEnv({}), ...opts };
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private nowMs(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Register a handle on the mock chain, decryptable by `allowed` (addresses). */
  registerHandle(handle: string, value: bigint, allowed: string[]): string {
    const h = normaliseHandle(handle);
    this.handles.set(h, { value, allowed: new Set(allowed.map((a) => a.toLowerCase())) });
    return h;
  }

  /**
   * Handles live in memory, but history outlives the process: re-register the seeded
   * incoming transfer's amount (see syncHistory) when a later run asks about it.
   */
  private recallHandle(handle: string, network: NetworkName, wallet: string): void {
    const h = normaliseHandle(handle);
    if (this.handles.has(h)) return;
    const key = `${network}:${wallet}`.toLowerCase();
    if (normaliseHandle(mockHandle(`amt:${key}`)) !== h) return;
    const tx = listTransactions({ walletAddress: wallet, network, limit: 10_000 }).find(
      (t) => t.amountHandle && normaliseHandle(t.amountHandle) === h,
    );
    const decimals = this.catalogue(network).find(
      (t) => t.address.toLowerCase() === tx?.tokenAddress.toLowerCase(),
    )?.decimals;
    if (!tx || decimals === undefined) return;
    this.registerHandle(h, 25n * 10n ** BigInt(decimals), [
      wallet,
      mockAddress('sender'),
      tx.tokenAddress,
    ]);
  }

  /** The current balance handle of `wallet` (changes whenever the balance does). */
  private balanceHandle(network: NetworkName, token: string, wallet: string): string {
    const value = this.balanceOf(network, token, wallet);
    const h = mockHandle(`bal:${this.balanceKey(network, token, wallet)}:${value}`);
    return this.registerHandle(h, value, [wallet, token]);
  }

  /** Simulated relayer: real EIP-712 signatures from the wallet, the SDK's limits and ACL rule. */
  private authority(network: NetworkName): DecryptAuthority {
    const domain = {
      name: 'MockDecryption',
      version: '1',
      chainId: Number(NETWORK_CONFIGS[network].chainId),
      verifyingContract: mockAddress('kms-verifier'),
    };
    return {
      authorize: async (signer, contracts, startTimestamp, durationDays) => {
        const publicKey = hexlify(randomBytes(32));
        const privateKey = hexlify(randomBytes(32));
        const message = { publicKey, contractAddresses: contracts, startTimestamp, durationDays };
        const signature = await signer.signTypedData(domain, MOCK_DECRYPT_TYPES, message);
        return {
          publicKey,
          privateKey,
          signature,
          contracts,
          userAddress: signer.address,
          startTimestamp,
          durationDays,
        };
      },
      userDecrypt: async (auth, pairs) => {
        await this.sleep(this.opts.latencyMs);
        this.rpcFailure();
        this.userDecryptRequests += 1;
        // The same checks the SDK makes before it contacts the relayer.
        if (auth.contracts.length > MAX_CONTRACTS_PER_SIGNATURE) {
          throw new Error('contractAddresses max length of 10 exceeded');
        }
        if (pairs.reduce((n, p) => n + handleBits(p.handle), 0) > MAX_BITS_PER_REQUEST) {
          throw new Error('Cannot decrypt more than 2048 encrypted bits in a single request');
        }
        const message = {
          publicKey: auth.publicKey,
          contractAddresses: auth.contracts,
          startTimestamp: auth.startTimestamp,
          durationDays: auth.durationDays,
        };
        const who = verifyTypedData(domain, MOCK_DECRYPT_TYPES, message, auth.signature);
        if (who.toLowerCase() !== auth.userAddress.toLowerCase()) {
          throw new Error('Invalid user decryption signature');
        }
        const user = auth.userAddress.toLowerCase();
        const out: Record<string, bigint> = {};
        for (const p of pairs) {
          const h = normaliseHandle(p.handle);
          const entry = this.handles.get(h);
          const contract = p.contractAddress.toLowerCase();
          if (!entry || !entry.allowed.has(user) || !auth.contracts.includes(contract)) {
            throw new Error(
              `User address ${auth.userAddress} is not authorized to user decrypt handle ${h}!`,
            );
          }
          out[h] = entry.value;
        }
        return out;
      },
    };
  }

  newDecryptSession(signer: UnlockedSigner, network: NetworkName): DecryptSession {
    return new DecryptSession(signer, network, this.authority(network), {
      durationDays: decryptDaysFromEnv(),
      now: () => this.nowMs(),
    });
  }

  async decryptBalances(
    session: DecryptSession,
    tokens: string[],
    opts: { forceRefresh?: boolean } = {},
  ): Promise<BalanceBatch> {
    const network = session.network;
    const owner = session.address;
    const values: Record<string, bigint> = {};
    const errors: Record<string, unknown> = {};
    const todo: Array<{ token: string; handle: string }> = [];
    try {
      await this.sleep(Math.min(this.opts.latencyMs, 100)); // the handle reads
      this.rpcFailure();
    } catch (err) {
      for (const t of tokens) errors[t.toLowerCase()] = err;
      return { values, errors };
    }
    for (const token of tokens) {
      const handle = this.balanceHandle(network, token, owner);
      const cached = opts.forceRefresh
        ? null
        : getCachedBalance(owner, token, network, BigInt(handle));
      if (cached !== null) values[token.toLowerCase()] = cached;
      else todo.push({ token, handle });
    }
    if (todo.length) {
      let outcome;
      try {
        outcome = await session.decrypt(
          todo.map((t) => ({ handle: t.handle, contractAddress: t.token })),
          tokens,
        );
      } catch (err) {
        for (const t of todo) errors[t.token.toLowerCase()] = err;
        return { values, errors };
      }
      for (const t of todo) {
        const v = outcome.values.get(t.handle);
        if (v === undefined) {
          errors[t.token.toLowerCase()] = outcome.errors.get(t.handle);
          continue;
        }
        values[t.token.toLowerCase()] = v;
        try {
          setCachedBalance(owner, t.token, network, BigInt(t.handle), v);
        } catch {
          // the cache is an optimisation
        }
      }
    }
    return { values, errors };
  }

  async decryptAmounts(
    session: DecryptSession,
    requests: AmountRequest[],
    contracts: string[],
  ): Promise<Record<string, bigint | null>> {
    const out: Record<string, bigint | null> = {};
    const user = session.address.toLowerCase();
    for (const r of requests) this.recallHandle(r.handle, session.network, session.address);
    const allowed = requests
      .map((r) => ({ handle: normaliseHandle(r.handle), contractAddress: r.token }))
      .filter((p) => {
        // The ACL pre-check the real backend makes: not allowed → null, no error.
        const ok = this.handles.get(p.handle)?.allowed.has(user) ?? false;
        if (!ok) out[p.handle] = null;
        return ok;
      });
    const { values } = await session.decrypt(allowed, contracts);
    for (const [h, v] of values) out[h] = v;
    return out;
  }

  private operatorKey(network: NetworkName, token: string, holder: string, op: string): string {
    return `${network}:${token}:${holder}:${op}`.toLowerCase();
  }

  async operatorStatus(
    tokenAddress: string,
    holder: string,
    spenders: string[],
    network: NetworkName,
  ): Promise<Record<string, boolean>> {
    await this.sleep(Math.min(this.opts.latencyMs, 100));
    this.rpcFailure();
    const now = Math.floor(this.nowMs() / 1000);
    return Object.fromEntries(
      spenders.map((sp) => [
        sp.toLowerCase(),
        (this.operators.get(this.operatorKey(network, tokenAddress, holder, sp)) ?? 0) >= now,
      ]),
    );
  }

  /** Shared pre-flight for non-transfer calls: latency, injected failures, fee and ETH. */
  private async prepareCall(
    from: string,
    network: NetworkName,
    label: string,
    onConfirmed: () => void,
  ): Promise<PreparedTx> {
    await this.sleep(this.opts.latencyMs);
    this.rpcFailure();
    if (this.opts.fail === 'simulate') {
      throw translateTxError(
        Object.assign(new Error(`missing revert data (mock: estimateGas ${label})`), {
          code: 'CALL_EXCEPTION',
          action: 'estimateGas',
          data: null,
        }),
        { iface: ERC7984_INTERFACE, action: label },
      );
    }
    const feeWei = (MOCK_GAS / 3n) * MOCK_GAS_PRICE;
    const ethBalanceWei = this.ethOf(from);
    if (ethBalanceWei < feeWei) {
      throw new WalletTxError(
        'INSUFFICIENT_GAS_FUNDS',
        'Not enough ETH to pay the network fee.',
        'Every transaction needs a little ETH for gas.',
        'Add ETH to this wallet (on Sepolia, use a faucet) and try again.',
      );
    }
    let used = false;
    return {
      feeWei,
      ethBalanceWei,
      send: async (hooks = {}) => {
        if (used) throw new Error('This prepared transaction was already used.');
        used = true;
        const r = await this.broadcastMock(network, from, label, feeWei, hooks);
        onConfirmed();
        return r;
      },
    };
  }

  async prepareSetOperator(
    signer: UnlockedSigner,
    tokenAddress: string,
    operator: string,
    untilUnixSeconds: number,
    network: NetworkName,
  ): Promise<PreparedTx> {
    if (
      !Number.isInteger(untilUnixSeconds) ||
      untilUnixSeconds < 0 ||
      untilUnixSeconds >= 2 ** 48
    ) {
      throw new Error('Operator expiry must be a unix timestamp in seconds');
    }
    const key = this.operatorKey(network, tokenAddress, signer.address, operator);
    return this.prepareCall(signer.address, network, 'operator change', () =>
      this.operators.set(key, untilUnixSeconds),
    );
  }

  async discloseStage(
    _tokenAddress: string,
    handle: string,
    network: NetworkName,
  ): Promise<DiscloseStage> {
    const h = normaliseHandle(handle);
    if (this.disclosedHandles.has(h) || getAmountEntry(network, h)?.disclosed) return 'disclosed';
    return this.publicHandles.has(h) ? 'requested' : 'private';
  }

  async prepareDiscloseRequest(
    signer: UnlockedSigner,
    tokenAddress: string,
    handle: string,
    network: NetworkName,
    opts: DiscloseRequestOptions = {},
  ): Promise<PreparedTx> {
    const h = normaliseHandle(handle);
    if (h === this.balanceHandle(network, tokenAddress, signer.address)) {
      throw discloseIsBalanceError();
    }
    // Same rule as the real backend: earlier balance handles stay usable by the holder.
    if (
      !opts.vouched &&
      !isTransferAmountHandle({ walletAddress: signer.address, network, tokenAddress, handle })
    ) {
      throw discloseUnknownHandleError();
    }
    this.recallHandle(h, network, signer.address);
    if (!this.handles.get(h)?.allowed.has(signer.address.toLowerCase())) {
      // What ERC7984UnauthorizedUseOfEncryptedAmount looks like after translation.
      throw new WalletTxError(
        'UNAUTHORIZED',
        'This wallet may not disclose that amount.',
        'Only the sender and the recipient of a transfer can use its encrypted amount.',
        'Pick a transfer you sent or received.',
      );
    }
    return this.prepareCall(signer.address, network, 'disclosure request', () =>
      this.publicHandles.add(h),
    );
  }

  async prepareDisclose(
    signer: UnlockedSigner,
    _tokenAddress: string,
    handle: string,
    network: NetworkName,
  ): Promise<PreparedDisclose> {
    const h = normaliseHandle(handle);
    await this.sleep(this.opts.latencyMs); // the public decryption round trip
    if (!this.publicHandles.has(h)) throw pendingPublicDecryption();
    const value = this.handles.get(h)!.value;
    const prepared = await this.prepareCall(signer.address, network, 'disclosure', () =>
      this.disclosedHandles.add(h),
    );
    return { ...prepared, value };
  }

  async findTransferHandle(txHash: string): Promise<AmountRequest | null> {
    // No receipts on the mock chain: only transfers already in local history are known.
    const tx = getTransactionByHash(txHash);
    return tx?.amountHandle ? { token: tx.tokenAddress, handle: tx.amountHandle } : null;
  }

  /**
   * Simulated broadcast + confirmation shared by transfers and other calls, with the
   * injected failure modes translated exactly like real ones.
   */
  private async broadcastMock(
    network: NetworkName,
    from: string,
    label: string,
    feeWei: bigint,
    hooks: { onSigned?: (h: string) => void; onBroadcast?: (h: string) => void },
  ): Promise<{ txHash: string; blockNumber: number }> {
    const txHash = id(`fhew-mock-tx:${network}:${from}:${label}:${this.nonce++}`);
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
    this.eth.set(from.toLowerCase(), this.ethOf(from) - feeWei);
    return { txHash, blockNumber };
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
    const handle = this.balanceHandle(network, tokenAddress, signer.address);
    // Keep the real cache in step so Home can show "cached 2m ago" after a restart.
    try {
      setCachedBalance(signer.address, tokenAddress, network, BigInt(handle), value);
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
    assertRecipient(to, tokenAddress);
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
      const { txHash, blockNumber } = await this.broadcastMock(
        network,
        from,
        `transfer:${to}:${amount}`,
        feeWei,
        hooks,
      );
      // Confirmed: move the tokens and credit the recipient (the fee is already paid).
      const after = this.balanceOf(network, tokenAddress, from) - amount;
      this.balances.set(this.balanceKey(network, tokenAddress, from), after);
      const toKey = this.balanceKey(network, tokenAddress, to);
      this.balances.set(toKey, this.balanceOf(network, tokenAddress, to) + amount);
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
    // The incoming transfer's amount: 25 tokens, decryptable by both parties (as
    // OpenZeppelin's ERC7984 allows sender and recipient on the ACL).
    const amountHandle = this.registerHandle(
      mockHandle(`amt:${key}`),
      25n * 10n ** BigInt(tokens[0].decimals),
      [address, mockAddress('sender'), tokens[0].address],
    );
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
        amountHandle,
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

  /** Wrap / unwrap simulation (mockWrap.ts), on this mock's balances and transactions. */
  readonly wrapOps = new MockWrapOps({
    sleep: (ms) => this.sleep(ms),
    latencyMs: () => this.opts.latencyMs,
    fail: () => this.opts.fail,
    rpcFailure: () => this.rpcFailure(),
    balanceOf: (n, t, w) => this.balanceOf(n, t, w),
    setBalance: (n, t, w, v) => void this.balances.set(this.balanceKey(n, t, w), v),
    prepareCall: (from, n, label, onConfirmed) => this.prepareCall(from, n, label, onConfirmed),
    registerHandle: (h, v, a) => this.registerHandle(h, v, a),
    catalogue: (n) => this.catalogue(n),
  });
  wrapperInfo: MockWrapOps['wrapperInfo'] = (...a) => this.wrapOps.wrapperInfo(...a);
  wrapState: MockWrapOps['wrapState'] = (...a) => this.wrapOps.wrapState(...a);
  prepareWrap: MockWrapOps['prepareWrap'] = (...a) => this.wrapOps.prepareWrap(...a);
  prepareUnwrap: MockWrapOps['prepareUnwrap'] = (...a) => this.wrapOps.prepareUnwrap(...a);
  unwrapRequestStatus: MockWrapOps['unwrapRequestStatus'] = (...a) =>
    this.wrapOps.unwrapRequestStatus(...a);
  txOutcome: MockWrapOps['txOutcome'] = (...a) => this.wrapOps.txOutcome(...a);
  unwrapRequestId: MockWrapOps['unwrapRequestId'] = (...a) => this.wrapOps.unwrapRequestId(...a);
  prepareFinalizeUnwrap: MockWrapOps['prepareFinalizeUnwrap'] = (...a) =>
    this.wrapOps.prepareFinalizeUnwrap(...a);
  underlyingBalance: MockWrapOps['underlyingBalance'] = (...a) =>
    this.wrapOps.underlyingBalance(...a);
}

/** Run a UI callback, ignoring its errors (they must never fail a send). */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // intentionally ignored
  }
}
