/**
 * ERC-20 ⇄ ERC-7984 wrapper tokens (OpenZeppelin `ERC7984ERC20Wrapper`): detection,
 * chain reads and the single transactions of a wrap or unwrap. The flows that chain
 * them (approve → wrap, request → public decryption → finalize) live in
 * `src/core/backend/realWrap.ts`; the amount maths in `wrapMath.ts`.
 *
 * Interface (read from the deployed Sepolia wrappers' bytecode and OpenZeppelin
 * Confidential Contracts 0.3.2 / 0.5.3, see docs/ROADMAP.md Phase 5):
 * - `underlying()`, `rate()`, `decimals()`; `wrap(to, amount)` mints `amount / rate`
 * - `unwrap(from, to, externalEuint64, inputProof)` burns up to the amount, makes the
 *   burnt handle publicly decryptable and uses it as the request id
 * - `finalizeUnwrap(requestId, cleartext, decryptionProof)`: anyone may call it once
 * - `unwrapRequester(requestId)` (0.4+): the receiver while pending, 0 afterwards
 * - `UnwrapRequested(receiver indexed, requestId indexed, amount)` (0.4+) or
 *   `UnwrapRequested(receiver indexed, amount)` (0.3), the request id being the amount
 *
 * Every transaction goes through `prepareTokenCall` (chain check, simulation, fee, ETH
 * check, then `signAndBroadcast`), so the send-safety rules of AGENTS.md hold here too.
 */

import {
  Contract,
  getAddress,
  Interface,
  ZeroAddress,
  type Wallet,
  type HDNodeWallet,
} from 'ethers';
import { getProvider, type NetworkName } from '../network/index.js';
import { CHAIN_IDS } from '../network/NetworkConfig.js';
import { encryptAmount } from '../fhe/EncryptionService.js';
import type { DecryptSession } from '../fhe/DecryptSession.js';
import { normaliseHandle } from '../fhe/DecryptSession.js';
import type { EthCall } from './erc7984Check.js';
import { sanitizeTokenName, sanitizeTokenSymbol } from './tokenText.js';
import { rpcErrorOf, translateTxError, WalletTxError } from './txErrors.js';
import type { TxErrorCode } from './txErrors.js';
import { getDecryptedBalance, prepareTokenCall, type PreparedCall } from './TokenService.js';
import { MAX_EUINT64 } from './limits.js';
import { DecryptionFailedError } from './txErrors.js';

/** The wrapper's ABI: OpenZeppelin ERC7984ERC20Wrapper 0.3–0.5 (euint64 = bytes32). */
export const WRAPPER_ABI = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function underlying() view returns (address)',
  'function rate() view returns (uint256)',
  'function maxTotalSupply() view returns (uint256)',
  'function inferredTotalSupply() view returns (uint256)',
  'function unwrapRequester(bytes32 unwrapRequestId) view returns (address)',
  'function wrap(address to, uint256 amount)',
  'function unwrap(address from, address to, bytes32 encryptedAmount, bytes inputProof)',
  'function finalizeUnwrap(bytes32 unwrapRequestId, uint64 unwrapAmountCleartext, bytes decryptionProof)',
  'event UnwrapRequested(address indexed receiver, bytes32 indexed unwrapRequestId, bytes32 amount)',
  'event UnwrapFinalized(address indexed receiver, bytes32 indexed unwrapRequestId, bytes32 encryptedAmount, uint64 cleartextAmount)',
  'error InvalidUnwrapRequest(bytes32 unwrapRequestId)',
  'error ERC7984TotalSupplyOverflow()',
  'error ERC7984UnauthorizedCaller(address caller)',
  'error ERC7984InvalidReceiver(address receiver)',
  'error ERC7984UnauthorizedSpender(address holder, address spender)',
  'error ERC7984UnauthorizedUseOfEncryptedAmount(bytes32 amount, address user)',
  'error ERC7984ZeroBalance(address holder)',
  'error SafeERC20FailedOperation(address token)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)',
]);

/** OpenZeppelin 0.3.x wrappers: the request id is the event's (unindexed) amount handle. */
const WRAPPER_V3_EVENTS = new Interface([
  'event UnwrapRequested(address indexed receiver, bytes32 amount)',
]);

/** The ERC-20 calls a wrap needs (plus OpenZeppelin ERC20's custom errors). */
export const ERC20_ABI = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InvalidSpender(address spender)',
]);

/** The public ERC-20 behind a wrapper (name and symbol sanitised). */
export interface UnderlyingInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

/** A wrapper token and its ERC-20, as the UI and the maths need them. */
export interface WrapperInfo {
  /** The wrapper (the confidential token) address. */
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  /** Underlying base units per confidential base unit. */
  rate: bigint;
  underlying: UnderlyingInfo;
  /**
   * The wrapper answers `unwrapRequester` (OpenZeppelin 0.4+), so whether a request is
   * still open can be read on-chain. Older wrappers only show it by refusing finalize.
   */
  hasRequester: boolean;
}

/** Public facts for a wrap: ERC-20 balance and allowance, room left in the supply cap. */
export interface WrapState {
  balance: bigint;
  allowance: bigint;
  /** Confidential units the wrapper can still mint, when it reports its supply. */
  supplyRoom?: bigint;
}

/**
 * True for an error that means "the contract did not answer", not "the RPC failed".
 * BAD_DATA only counts when the node returned `0x` ("could not decode result data"):
 * ethers also reports a batch the node dropped ("missing response for request", e.g.
 * an RPC that limits batch sizes) as BAD_DATA, and that must never read as "not a
 * wrapper".
 */
function isContractNoAnswer(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; shortMessage?: unknown; message?: unknown };
  if (e.code === 'BAD_DATA') {
    const text = `${String(e.shortMessage ?? '')} ${String(e.message ?? '')}`;
    return /could not decode result data/i.test(text) && !/missing response/i.test(text);
  }
  return e.code === 'CALL_EXCEPTION' && rpcErrorOf(err) === null;
}

/** Decode `fn`'s single return value, or null when it does not decode. */
async function read<T>(
  call: EthCall,
  iface: Interface,
  to: string,
  fn: string,
  args: unknown[] = [],
): Promise<T | null> {
  let raw: string;
  try {
    raw = await call(to, iface.encodeFunctionData(fn, args));
  } catch (err) {
    if (isContractNoAnswer(err)) return null;
    throw err; // a transport failure is never "not a wrapper"
  }
  if (typeof raw !== 'string' || raw === '0x') return null;
  try {
    return iface.decodeFunctionResult(fn, raw)[0] as T;
  } catch {
    return null;
  }
}

/** Some ERC-20s (MKR-style) return bytes32 for name/symbol; keep the readable part. */
async function readText(call: EthCall, to: string, fn: 'name' | 'symbol'): Promise<string> {
  const text = await read<string>(call, ERC20_ABI, to, fn);
  if (text !== null) return text;
  const b32 = await read<string>(
    call,
    new Interface([`function ${fn}() view returns (bytes32)`]),
    to,
    fn,
  );
  if (!b32) return '';
  return Buffer.from(b32.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
}

/** 10^n as bigint. */
function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Read a token's wrapper interface. Null when it is no wrapper (no `underlying()` or
 * `rate()` answer). Transport failures are thrown, never read as "not a wrapper".
 * Names and symbols are contract text: sanitised here, before anything stores them.
 */
export async function readWrapperInfo(call: EthCall, wrapper: string): Promise<WrapperInfo | null> {
  const address = getAddress(wrapper);
  const [underlyingRaw, rate] = await Promise.all([
    read<string>(call, WRAPPER_ABI, address, 'underlying'),
    read<bigint>(call, WRAPPER_ABI, address, 'rate'),
  ]);
  if (!underlyingRaw || rate === null || rate <= 0n) return null;
  const underlying = getAddress(underlyingRaw);
  if (underlying === ZeroAddress) return null;
  // A few reads at a time: some public RPCs refuse JSON-RPC batches above 10 requests,
  // and ethers batches whatever is sent in the same tick.
  const [decimals, name, symbol, requester] = await Promise.all([
    read<bigint>(call, WRAPPER_ABI, address, 'decimals'),
    readText(call, address, 'name'),
    readText(call, address, 'symbol'),
    read<string>(call, WRAPPER_ABI, address, 'unwrapRequester', [`0x${'00'.repeat(31)}01`]),
  ]);
  const [uDecimals, uName, uSymbol] = await Promise.all([
    read<bigint>(call, ERC20_ABI, underlying, 'decimals'),
    readText(call, underlying, 'name'),
    readText(call, underlying, 'symbol'),
  ]);
  if (decimals === null || decimals > 36n) return null;
  // The wrapper derives rate = 10^(underlying decimals − its decimals); a token without
  // decimals() makes it fall back to 18. Prefer the token's own answer, else infer.
  let underlyingDecimals = uDecimals !== null && uDecimals <= 77n ? Number(uDecimals) : null;
  if (underlyingDecimals === null) {
    const digits = rate.toString().length - 1;
    underlyingDecimals = pow10(digits) === rate ? Number(decimals) + digits : 18;
  }
  return {
    address,
    name: sanitizeTokenName(name),
    symbol: sanitizeTokenSymbol(symbol),
    decimals: Number(decimals),
    rate,
    underlying: {
      address: underlying,
      name: sanitizeTokenName(uName),
      symbol: sanitizeTokenSymbol(uSymbol),
      decimals: underlyingDecimals,
    },
    hasRequester: requester !== null,
  };
}

/** `readWrapperInfo` over the network's provider; RPC failures become WalletTxError. */
export async function getWrapperInfo(
  wrapper: string,
  network: NetworkName,
): Promise<WrapperInfo | null> {
  const provider = getProvider(network);
  try {
    return await readWrapperInfo((to, data) => provider.call({ to, data }), wrapper);
  } catch (err) {
    throw translateTxError(err, { action: 'wrapper check' });
  }
}

/** ERC-20 balance and allowance of `owner` for the wrapper, and the supply room left. */
export async function getWrapState(
  info: WrapperInfo,
  owner: string,
  network: NetworkName,
): Promise<WrapState> {
  const provider = getProvider(network);
  const erc20 = new Contract(info.underlying.address, ERC20_ABI, provider);
  const wrapper = new Contract(info.address, WRAPPER_ABI, provider);
  try {
    const [balance, allowance, room] = await Promise.all([
      erc20.balanceOf(owner) as Promise<bigint>,
      erc20.allowance(owner, info.address) as Promise<bigint>,
      Promise.all([
        wrapper.maxTotalSupply() as Promise<bigint>,
        wrapper.inferredTotalSupply() as Promise<bigint>,
      ]).then(
        ([max, inferred]) => (max > MAX_EUINT64 ? MAX_EUINT64 : max) - inferred,
        () => undefined, // older wrappers may not report it; the simulation still checks
      ),
    ]);
    return { balance, allowance, supplyRoom: room };
  } catch (err) {
    throw translateTxError(err, { action: 'balance check' });
  }
}

/** Prepare `approve(wrapper, amount)` on the ERC-20: exact, never unlimited. */
export function prepareApprove(
  wallet: Wallet | HDNodeWallet,
  info: WrapperInfo,
  amount: bigint,
  network: NetworkName,
): Promise<PreparedCall> {
  return prepareTokenCall(wallet, info.underlying.address, network, {
    fn: 'approve(address,uint256)',
    args: [info.address, amount],
    abi: ERC20_ABI,
    action: 'approval',
    audit: {
      event: 'APPROVAL_SET',
      details: { token: info.underlying.address, spender: info.address, network },
    },
  });
}

/** Prepare `wrap(self, pull)`; `pull` must be a multiple of the rate (wrapMath). */
export function prepareWrapCall(
  wallet: Wallet | HDNodeWallet,
  info: WrapperInfo,
  pull: bigint,
  network: NetworkName,
): Promise<PreparedCall> {
  if (pull <= 0n || pull % info.rate !== 0n) {
    throw new Error('wrap amount must be a positive multiple of the rate');
  }
  return prepareTokenCall(wallet, info.address, network, {
    fn: 'wrap(address,uint256)',
    args: [wallet.address, pull],
    abi: WRAPPER_ABI,
    action: 'wrap',
    audit: { event: 'WRAPPED', details: { token: info.address, network } },
  });
}

/**
 * Prepare `unwrap(self, self, encrypted, proof)`. The decrypted balance is checked first:
 * a burn above it burns 0 without reverting. The input is encrypted for (wrapper, sender).
 * Returns the prepared call and the balance it was checked against.
 */
export async function prepareUnwrapCall(
  wallet: Wallet | HDNodeWallet,
  info: WrapperInfo,
  amount: bigint,
  network: NetworkName,
  opts: { session?: DecryptSession } = {},
): Promise<{ call: PreparedCall; balance: bigint }> {
  if (amount <= 0n || amount > MAX_EUINT64) {
    throw new WalletTxError(
      'AMOUNT_OUT_OF_RANGE',
      'That amount cannot be unwrapped.',
      "Confidential amounts are 64-bit numbers in the token's smallest unit, and must be above zero.",
      'Enter a smaller amount.',
    );
  }
  const session = opts.session?.active ? opts.session : undefined;
  let balance: bigint;
  try {
    balance = await getDecryptedBalance(info.address, wallet, network, { session });
  } catch (err) {
    const t = translateTxError(err);
    if (!(err instanceof DecryptionFailedError)) throw t;
    throw new WalletTxError(
      'BALANCE_CHECK_FAILED',
      "Couldn't check your confidential balance before unwrapping.",
      'Decrypting the balance through the Zama relayer failed. Nothing was sent.',
      'Try again in a minute.',
      t.raw,
    );
  }
  if (amount > balance) {
    throw new WalletTxError(
      'INSUFFICIENT_TOKEN_BALANCE',
      'That is more than this wallet holds.',
      'ERC-7984 would burn 0 instead of failing, so the wallet stops the unwrap here.',
      'Enter a smaller amount.',
    );
  }
  const chainId = network === 'mainnet' ? CHAIN_IDS.MAINNET : CHAIN_IDS.SEPOLIA;
  let encrypted;
  try {
    encrypted = await encryptAmount(chainId, info.address, wallet.address, amount);
  } catch (err) {
    throw translateTxError(err, { action: 'unwrap' });
  }
  const call = await prepareTokenCall(wallet, info.address, network, {
    fn: 'unwrap(address,address,bytes32,bytes)',
    args: [wallet.address, wallet.address, encrypted.handleHex, encrypted.inputProofHex],
    abi: WRAPPER_ABI,
    action: 'unwrap request',
    audit: { event: 'UNWRAP_REQUESTED', details: { token: info.address, network } },
  });
  return { call, balance };
}

/** Prepare `finalizeUnwrap(requestId, cleartext, proof)` with the relayer's public decryption. */
export function prepareFinalizeCall(
  wallet: Wallet | HDNodeWallet,
  info: WrapperInfo,
  requestId: string,
  cleartext: bigint,
  proof: string,
  network: NetworkName,
): Promise<PreparedCall> {
  if (cleartext < 0n || cleartext > MAX_EUINT64) throw new Error('Not a 64-bit amount');
  return prepareTokenCall(wallet, info.address, network, {
    fn: 'finalizeUnwrap(bytes32,uint64,bytes)',
    args: [normaliseHandle(requestId), cleartext, proof],
    abi: WRAPPER_ABI,
    action: 'unwrap finish',
    audit: {
      event: 'UNWRAP_FINALIZED',
      details: { token: info.address, requestId: normaliseHandle(requestId), network },
    },
  });
}

/** A log as receipts carry it. */
export interface LogLike {
  address: string;
  topics: readonly string[];
  data: string;
}

const REQUESTED_V4 = WRAPPER_ABI.getEvent('UnwrapRequested')!.topicHash;
const REQUESTED_V3 = WRAPPER_V3_EVENTS.getEvent('UnwrapRequested')!.topicHash;

/**
 * The unwrap request id in a request transaction's logs: `UnwrapRequested` from the
 * wrapper for `receiver` (0.4+: the indexed id; 0.3: the amount handle). Null if absent.
 */
export function requestIdFromLogs(
  logs: readonly LogLike[],
  wrapper: string,
  receiver: string,
): string | null {
  const w = wrapper.toLowerCase();
  const r = receiver.toLowerCase().slice(2).padStart(64, '0');
  for (const log of logs) {
    if (log.address.toLowerCase() !== w) continue;
    if (log.topics[1]?.toLowerCase().slice(2) !== r) continue;
    if (log.topics[0] === REQUESTED_V4 && log.topics.length >= 3) {
      return normaliseHandle(log.topics[2]);
    }
    if (log.topics[0] === REQUESTED_V3 && log.data.length >= 66) {
      return normaliseHandle(log.data.slice(0, 66));
    }
  }
  return null;
}

/** What the chain says about one of our transactions. */
export type TxOutcome =
  | { status: 'mined'; blockNumber: number; logs: LogLike[] }
  | { status: 'reverted'; blockNumber: number }
  /** The node knows it, not mined yet. */
  | { status: 'pending' }
  /** The node does not know it (dropped, or never arrived). */
  | { status: 'missing' };

/** Look a transaction up: receipt first, then the mempool. */
export async function getTxOutcome(txHash: string, network: NetworkName): Promise<TxOutcome> {
  const provider = getProvider(network);
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      if (receipt.status === 1) {
        return {
          status: 'mined',
          blockNumber: receipt.blockNumber,
          logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
        };
      }
      if (receipt.status === 0) return { status: 'reverted', blockNumber: receipt.blockNumber };
    }
    const tx = await provider.getTransaction(txHash);
    return tx ? { status: 'pending' } : { status: 'missing' };
  } catch (err) {
    throw translateTxError(err, { action: 'transaction check' });
  }
}

/**
 * Whether an unwrap request is still open on-chain: `pending` (requester set),
 * `finalized` (requester cleared: finished by this wallet or anyone), or `unknown` for
 * wrappers without `unwrapRequester` (0.3.x), where only finalize's simulation tells.
 */
export async function getUnwrapRequestStatus(
  info: WrapperInfo,
  requestId: string,
  network: NetworkName,
): Promise<'pending' | 'finalized' | 'unknown'> {
  if (!info.hasRequester) return 'unknown';
  const wrapper = new Contract(info.address, WRAPPER_ABI, getProvider(network));
  try {
    const who = (await wrapper.unwrapRequester(normaliseHandle(requestId))) as string;
    return who === ZeroAddress ? 'finalized' : 'pending';
  } catch (err) {
    throw translateTxError(err, { action: 'unwrap check' });
  }
}

/** ERC-20 balance of `owner` (public). */
export async function getUnderlyingBalance(
  info: WrapperInfo,
  owner: string,
  network: NetworkName,
): Promise<bigint> {
  const erc20 = new Contract(info.underlying.address, ERC20_ABI, getProvider(network));
  return (await erc20.balanceOf(owner)) as bigint;
}

/** The unwrap's amount is not publicly decryptable yet (request not mined, or the gateway is behind). */
export function unwrapDecryptPending(raw?: string): WalletTxError {
  const code: TxErrorCode = 'PUBLIC_DECRYPT_PENDING';
  return new WalletTxError(
    code,
    'The unwrapped amount is not decryptable yet.',
    'Step 1 (the unwrap request) has to be confirmed on-chain, and the Zama gateway then needs a little time.',
    'Wait a minute and finish the unwrap again. Nothing was signed or sent.',
    raw,
  );
}

/** The wrapper has no open request with this id (finished by this wallet or anyone). */
export function unwrapAlreadyFinished(): WalletTxError {
  return translateTxError({ code: 'CALL_EXCEPTION', revert: { name: 'InvalidUnwrapRequest' } });
}
