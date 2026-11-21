/**
 * Wrap and unwrap for FHEW_BACKEND=mock: deterministic, in memory, through the mock's
 * shared transaction path (latency, injected failures, fees), so the TUI and the CLI
 * behave as on a network.
 *
 * Mock wrappers: the catalogue's cUSDC wraps a 6-decimal USDC at rate 1, cDAI an
 * 18-decimal DAI at rate 1e12 (the cZAMA case, where small amounts wrap to 0). Every
 * wallet starts with 500 USDC and 1,000.000000123456789 DAI (so `max` leaves dust) and
 * no allowance. The mock USDC behaves like USDT: it refuses to change a non-zero
 * allowance to another non-zero value.
 *
 * Unwrap requests are kept in memory, but a later process (`fhew unwrap --resume`) still
 * finds them: a request recorded in the unwrap store counts as mined on the mock chain
 * (unless FHEW_MOCK_FAIL=unconfirmed), with an `UnwrapRequested` log built with the real
 * ABI. `FHEW_MOCK_FAIL=public-pending` keeps every public decryption pending.
 */

import { getAddress, id } from 'ethers';
import type { NetworkName } from '../network/NetworkConfig.js';
import type { DecryptSession } from '../fhe/DecryptSession.js';
import { normaliseHandle } from '../fhe/DecryptSession.js';
import { listUnwrapsSafe } from '../../storage/UnwrapStore.js';
import { WalletTxError } from '../token/txErrors.js';
import {
  requestIdFromLogs,
  unwrapAlreadyFinished,
  unwrapDecryptPending,
  WRAPPER_ABI,
  type LogLike,
  type TxOutcome,
  type WrapperInfo,
  type WrapState,
} from '../token/wrapper.js';
import { approvalPlan } from '../token/wrapMath.js';
import { MAX_EUINT64 } from '../token/limits.js';
import type { PreparedTx, UnlockedSigner } from './types.js';
import type {
  PreparedFinalize,
  PreparedUnwrap,
  PreparedWrap,
  WrapBackend,
  WrapHooks,
  WrapResult,
  WrapStep,
} from './wrapTypes.js';

/** What the mock wrapper needs from MockBackend (its chain state and transaction path). */
export interface MockChainAccess {
  sleep: (ms: number) => Promise<void>;
  latencyMs: () => number;
  /** The injected failure mode (FHEW_MOCK_FAIL). */
  fail: () => string | undefined;
  rpcFailure: () => void;
  /** Confidential balance (base units). */
  balanceOf: (network: NetworkName, token: string, wallet: string) => bigint;
  setBalance: (network: NetworkName, token: string, wallet: string, value: bigint) => void;
  /** Simulate, price and (on send) broadcast a call; `onConfirmed` runs once mined. */
  prepareCall: (
    from: string,
    network: NetworkName,
    label: string,
    onConfirmed: () => void,
  ) => Promise<PreparedTx>;
  registerHandle: (handle: string, value: bigint, allowed: string[]) => string;
  /** Catalogue tokens (address, symbol, decimals) for `network`. */
  catalogue: (
    network: NetworkName,
  ) => Array<{ address: string; symbol: string; name: string; decimals: number }>;
}

/** The ERC-20 behind each mock wrapper (by catalogue symbol). */
const UNDERLYING: Record<
  string,
  { symbol: string; name: string; decimals: number; rate: bigint; start: bigint }
> = {
  cUSDC: { symbol: 'USDC', name: 'USD Coin (mock)', decimals: 6, rate: 1n, start: 500_000_000n },
  cDAI: {
    symbol: 'DAI',
    name: 'Dai Stablecoin (mock)',
    decimals: 18,
    rate: 10n ** 12n,
    start: 1_000_000_000_123_456_789_000n,
  },
};

/** The mock underlying ERC-20 address of a wrapper symbol on `network` (stable). */
export function mockUnderlyingAddress(network: NetworkName, symbol: string): string {
  return getAddress('0x' + id(`fhew-mock:${network}:underlying:${symbol}`).slice(-40));
}

/** A mock request id (a euint64-shaped handle) derived from the request transaction. */
export function mockRequestId(txHash: string): string {
  return '0x' + id(`fhew-mock-unwrap:${txHash.toLowerCase()}`).slice(2, 62) + '0500';
}

interface MockRequest {
  network: NetworkName;
  token: string;
  receiver: string;
  value: bigint;
  open: boolean;
}

/** In-memory wrapper simulation. */
export class MockWrapOps implements WrapBackend {
  /** ERC-20 balances by `${network}:${underlying}:${wallet}` (lowercase). */
  private readonly erc20 = new Map<string, bigint>();
  /** Allowances by `${network}:${underlying}:${owner}:${spender}` (lowercase). */
  readonly allowances = new Map<string, bigint>();
  /** Unwrap requests by request id (lowercase). */
  private readonly requests = new Map<string, MockRequest>();
  /** Outcomes of mock transactions by hash (lowercase). */
  private readonly txs = new Map<string, TxOutcome>();
  private block = 8_000_000;

  constructor(private readonly chain: MockChainAccess) {}

  private wait(short = false): Promise<void> {
    const ms = this.chain.latencyMs();
    return this.chain.sleep(short ? Math.min(ms, 100) : ms);
  }

  /** The wrapper info of a catalogue token, or null. */
  private infoOf(token: string, network: NetworkName): WrapperInfo | null {
    const t = this.chain
      .catalogue(network)
      .find((x) => x.address.toLowerCase() === token.toLowerCase());
    const u = t ? UNDERLYING[t.symbol] : undefined;
    if (!t || !u) return null;
    return {
      address: t.address,
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      rate: u.rate,
      underlying: {
        address: mockUnderlyingAddress(network, t.symbol),
        name: u.name,
        symbol: u.symbol,
        decimals: u.decimals,
      },
      hasRequester: true,
    };
  }

  private erc20Key(network: NetworkName, underlying: string, wallet: string): string {
    return `${network}:${underlying}:${wallet}`.toLowerCase();
  }

  /** Public ERC-20 balance of `wallet` (starting balance on first use). */
  erc20Of(network: NetworkName, info: WrapperInfo, wallet: string): bigint {
    const key = this.erc20Key(network, info.underlying.address, wallet);
    if (!this.erc20.has(key)) {
      this.erc20.set(key, UNDERLYING[info.symbol]?.start ?? 0n);
    }
    return this.erc20.get(key)!;
  }

  private allowanceKey(network: NetworkName, info: WrapperInfo, owner: string): string {
    return `${network}:${info.underlying.address}:${owner}:${info.address}`.toLowerCase();
  }

  /** Set an allowance directly (tests). */
  setAllowance(network: NetworkName, info: WrapperInfo, owner: string, value: bigint): void {
    this.allowances.set(this.allowanceKey(network, info, owner), value);
  }

  private allowanceOf(network: NetworkName, info: WrapperInfo, owner: string): bigint {
    return this.allowances.get(this.allowanceKey(network, info, owner)) ?? 0n;
  }

  /** Record a mined mock transaction (for txOutcome). */
  private mined(txHash: string, logs: LogLike[] = []): void {
    this.txs.set(txHash.toLowerCase(), { status: 'mined', blockNumber: ++this.block, logs });
  }

  /** Wrap the shared prepareCall so the mined transaction is recorded with its logs. */
  private async call(
    from: string,
    network: NetworkName,
    label: string,
    onConfirmed: (txHash: string) => LogLike[] | void,
  ): Promise<PreparedTx> {
    let hash = '';
    const p = await this.chain.prepareCall(from, network, label, () => {
      this.mined(hash, onConfirmed(hash) ?? []);
    });
    return {
      ...p,
      send: async (hooks = {}) => {
        try {
          return await p.send({
            ...hooks,
            onSigned: (h) => {
              hash = h;
              hooks.onSigned?.(h);
            },
          });
        } catch (err) {
          // A mined revert is visible on the mock chain afterwards, like on a real one.
          if ((err as { code?: string }).code === 'TX_REVERTED' && hash) {
            this.txs.set(hash.toLowerCase(), { status: 'reverted', blockNumber: ++this.block });
          }
          throw err;
        }
      },
    };
  }

  async wrapperInfo(tokenAddress: string, network: NetworkName): Promise<WrapperInfo | null> {
    await this.wait(true);
    this.chain.rpcFailure();
    return this.infoOf(tokenAddress, network);
  }

  async wrapState(info: WrapperInfo, owner: string, network: NetworkName): Promise<WrapState> {
    await this.wait(true);
    this.chain.rpcFailure();
    return {
      balance: this.erc20Of(network, info, owner),
      allowance: this.allowanceOf(network, info, owner),
      supplyRoom: MAX_EUINT64 - 10n ** 15n, // plenty, but reported like a real wrapper
    };
  }

  private approveCall(
    signer: UnlockedSigner,
    info: WrapperInfo,
    value: bigint,
    network: NetworkName,
  ): Promise<PreparedTx> {
    const current = this.allowanceOf(network, info, signer.address);
    // USDT-style: a non-zero allowance must go through 0 first.
    if (info.underlying.symbol === 'USDC' && current > 0n && value > 0n) {
      return Promise.reject(
        new WalletTxError(
          'CONTRACT_REJECTED',
          'The token contract rejected the approval.',
          'The contract reverted without a reason.',
          'Check the token, recipient and amount, then try again.',
        ),
      );
    }
    return this.call(signer.address, network, `approve:${info.address}:${value}`, () => {
      this.setAllowance(network, info, signer.address, value);
    });
  }

  private wrapCall(
    signer: UnlockedSigner,
    info: WrapperInfo,
    pull: bigint,
    network: NetworkName,
  ): Promise<PreparedTx> {
    if (this.allowanceOf(network, info, signer.address) < pull) {
      return Promise.reject(
        new WalletTxError(
          'INSUFFICIENT_ALLOWANCE',
          'The wrapper may not take that much of your tokens yet.',
          'The approval for the wrapper is smaller than the amount (or was not confirmed yet).',
          'Wrap again: the wallet approves exactly the amount first.',
        ),
      );
    }
    return this.call(signer.address, network, `wrap:${info.address}:${pull}`, () => {
      const me = signer.address;
      this.erc20.set(
        this.erc20Key(network, info.underlying.address, me),
        this.erc20Of(network, info, me) - pull,
      );
      this.setAllowance(network, info, me, this.allowanceOf(network, info, me) - pull);
      this.chain.setBalance(
        network,
        info.address,
        me,
        this.chain.balanceOf(network, info.address, me) + pull / info.rate,
      );
    });
  }

  async prepareWrap(
    signer: UnlockedSigner,
    info: WrapperInfo,
    pull: bigint,
    network: NetworkName,
    _opts: { session?: DecryptSession } = {},
  ): Promise<PreparedWrap> {
    await this.wait();
    this.chain.rpcFailure();
    if (pull <= 0n || pull % info.rate !== 0n) {
      throw new Error('wrap amount must be a positive multiple of the rate');
    }
    const state = await this.wrapState(info, signer.address, network);
    if (state.balance < pull) {
      throw new WalletTxError(
        'INSUFFICIENT_TOKEN_BALANCE',
        'That is more than this wallet holds.',
        `This wallet has less public ${info.underlying.symbol} than the amount.`,
        'Enter a smaller amount.',
      );
    }
    let steps: WrapStep[];
    let first: PreparedTx;
    let feeEstimated = false;
    if (approvalPlan(state.allowance, pull) === 'none') {
      steps = ['wrap'];
      first = await this.wrapCall(signer, info, pull, network);
    } else {
      try {
        first = await this.approveCall(signer, info, pull, network);
        steps = ['approve', 'wrap'];
      } catch (err) {
        if (state.allowance === 0n) throw err;
        first = await this.approveCall(signer, info, 0n, network);
        steps = ['reset', 'approve', 'wrap'];
      }
      feeEstimated = true;
    }
    const feeWei = first.feeWei * BigInt(steps.length);
    if (first.ethBalanceWei < feeWei) {
      throw new WalletTxError(
        'INSUFFICIENT_GAS_FUNDS',
        'Not enough ETH to pay the network fees.',
        'Wrapping takes more than one transaction, and this wallet cannot pay for all of them.',
        'Add ETH to this wallet (on Sepolia, use a faucet) and try again. Nothing was sent.',
      );
    }
    let used = false;
    const send = async (hooks: WrapHooks = {}): Promise<WrapResult> => {
      if (used) throw new Error('This prepared wrap was already used.');
      used = true;
      const before = this.chain.balanceOf(network, info.address, signer.address);
      const out: Partial<WrapResult> = {};
      let next: PreparedTx | null = first;
      for (const step of steps) {
        hooks.onStep?.(step);
        if (!next) {
          try {
            next =
              step === 'approve'
                ? await this.approveCall(signer, info, pull, network)
                : await this.wrapCall(signer, info, pull, network);
          } catch (err) {
            const done = out.approveTxHash ?? out.resetTxHash ?? '';
            const e = err as WalletTxError;
            throw new WalletTxError(
              'WRAP_APPROVED_ONLY',
              'The approval went through, but the wrap was not sent.',
              `${e.message} (approval: ${done})`,
              'Wrap again: the approval is in place, so only the wrap is sent.',
            );
          }
        }
        const r = await next.send(hooks);
        hooks.onStepConfirmed?.(step, r.txHash);
        if (step === 'reset') out.resetTxHash = r.txHash;
        if (step === 'approve') out.approveTxHash = r.txHash;
        if (step === 'wrap') {
          out.txHash = r.txHash;
          out.blockNumber = r.blockNumber;
        }
        next = null;
      }
      const after = this.chain.balanceOf(network, info.address, signer.address);
      const wrapped = pull / info.rate;
      return {
        txHash: out.txHash!,
        blockNumber: out.blockNumber!,
        approveTxHash: out.approveTxHash,
        resetTxHash: out.resetTxHash,
        balanceBefore: before,
        balanceAfter: after,
        balanceCheck:
          after === before + wrapped ? 'moved' : after === before ? 'unchanged' : 'changed',
      };
    };
    return { steps, feeWei, feeEstimated, ethBalanceWei: first.ethBalanceWei, state, send };
  }

  async prepareUnwrap(
    signer: UnlockedSigner,
    info: WrapperInfo,
    amount: bigint,
    network: NetworkName,
  ): Promise<PreparedUnwrap> {
    await this.wait();
    this.chain.rpcFailure();
    if (amount <= 0n || amount > MAX_EUINT64) {
      throw new WalletTxError(
        'AMOUNT_OUT_OF_RANGE',
        'That amount cannot be unwrapped.',
        "Confidential amounts are 64-bit numbers in the token's smallest unit, and must be above zero.",
        'Enter a smaller amount.',
      );
    }
    const me = signer.address;
    const balance = this.chain.balanceOf(network, info.address, me);
    if (amount > balance) {
      throw new WalletTxError(
        'INSUFFICIENT_TOKEN_BALANCE',
        'That is more than this wallet holds.',
        'ERC-7984 would burn 0 instead of failing, so the wallet stops the unwrap here.',
        'Enter a smaller amount.',
      );
    }
    let requestId: string | null = null;
    const p = await this.call(me, network, `unwrap:${info.address}:${amount}`, (txHash) => {
      // Burn now; the request id is the burnt handle, publicly decryptable from here on.
      this.chain.setBalance(
        network,
        info.address,
        me,
        this.chain.balanceOf(network, info.address, me) - amount,
      );
      requestId = this.openRequest(network, info, me, amount, txHash);
      return [this.requestedLog(info, me, requestId)];
    });
    return {
      feeWei: p.feeWei,
      finalizeFeeWei: p.feeWei,
      ethBalanceWei: p.ethBalanceWei,
      balance,
      send: async (hooks) => {
        const r = await p.send(hooks);
        return { txHash: r.txHash, blockNumber: r.blockNumber, requestId };
      },
    };
  }

  private openRequest(
    network: NetworkName,
    info: WrapperInfo,
    receiver: string,
    value: bigint,
    txHash: string,
  ): string {
    const rid = normaliseHandle(mockRequestId(txHash));
    this.chain.registerHandle(rid, value, [receiver, info.address]);
    this.requests.set(rid, { network, token: info.address, receiver, value, open: true });
    return rid;
  }

  private requestedLog(info: WrapperInfo, receiver: string, requestId: string): LogLike {
    const ev = WRAPPER_ABI.getEvent('UnwrapRequested')!;
    const { topics, data } = WRAPPER_ABI.encodeEventLog(ev, [receiver, requestId, requestId]);
    return { address: info.address, topics, data };
  }

  /**
   * A request transaction from an earlier process, known only from the unwrap store:
   * treat it as mined (it was, on the "chain" of that process) unless confirmations are
   * being lost right now.
   */
  private recall(txHash: string): TxOutcome | null {
    if (this.chain.fail() === 'unconfirmed') return null;
    const entry = listUnwrapsSafe().find(
      (e) => e.requestTxHash.toLowerCase() === txHash.toLowerCase(),
    );
    if (!entry) return null;
    const info = this.infoOf(entry.token, entry.network);
    if (!info) return null;
    const rid = normaliseHandle(mockRequestId(txHash));
    if (!this.requests.has(rid)) {
      this.openRequest(entry.network, info, entry.wallet, BigInt(entry.amount), txHash);
    }
    this.mined(txHash, [this.requestedLog(info, entry.wallet, rid)]);
    return this.txs.get(txHash.toLowerCase())!;
  }

  /**
   * Requests recorded in the store with an id but unknown in memory (an earlier process)
   * are open, unless the store says they were finished.
   */
  private requestOf(requestId: string): MockRequest | undefined {
    const rid = normaliseHandle(requestId);
    if (!this.requests.has(rid)) {
      const entry = listUnwrapsSafe().find((e) => e.requestId?.toLowerCase() === rid);
      const info = entry ? this.infoOf(entry.token, entry.network) : null;
      if (entry && info) {
        this.chain.registerHandle(rid, BigInt(entry.amount), [entry.wallet, info.address]);
        this.requests.set(rid, {
          network: entry.network,
          token: info.address,
          receiver: entry.wallet,
          value: BigInt(entry.amount),
          open: entry.state !== 'finished',
        });
      }
    }
    return this.requests.get(rid);
  }

  async unwrapRequestStatus(
    _info: WrapperInfo,
    requestId: string,
  ): Promise<'pending' | 'finalized' | 'unknown'> {
    await this.wait(true);
    this.chain.rpcFailure();
    const r = this.requestOf(requestId);
    return r?.open ? 'pending' : 'finalized';
  }

  async txOutcome(txHash: string): Promise<TxOutcome> {
    await this.wait(true);
    this.chain.rpcFailure();
    return this.txs.get(txHash.toLowerCase()) ?? this.recall(txHash) ?? { status: 'missing' };
  }

  async unwrapRequestId(
    info: WrapperInfo,
    txHash: string,
    receiver: string,
  ): Promise<string | null> {
    const o = await this.txOutcome(txHash);
    return o.status === 'mined' ? requestIdFromLogs(o.logs, info.address, receiver) : null;
  }

  async prepareFinalizeUnwrap(
    signer: UnlockedSigner,
    info: WrapperInfo,
    requestId: string,
    network: NetworkName,
  ): Promise<PreparedFinalize> {
    await this.wait(); // the public decryption round trip
    this.chain.rpcFailure();
    const rid = normaliseHandle(requestId);
    const req = this.requestOf(rid);
    if (!req || !req.open) throw unwrapAlreadyFinished();
    if (this.chain.fail() === 'public-pending') throw unwrapDecryptPending();
    const p = await this.call(signer.address, network, `finalize:${rid}`, () => {
      req.open = false;
      const key = this.erc20Key(network, info.underlying.address, req.receiver);
      this.erc20.set(key, this.erc20Of(network, info, req.receiver) + req.value * info.rate);
    });
    return {
      feeWei: p.feeWei,
      ethBalanceWei: p.ethBalanceWei,
      value: req.value,
      receive: req.value * info.rate,
      send: async (hooks) => {
        if (!req.open) throw unwrapAlreadyFinished();
        return p.send(hooks);
      },
    };
  }

  async underlyingBalance(info: WrapperInfo, owner: string, network: NetworkName): Promise<bigint> {
    await this.wait(true);
    this.chain.rpcFailure();
    return this.erc20Of(network, info, owner);
  }
}
