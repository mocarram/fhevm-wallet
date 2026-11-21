/**
 * ERC-7984 token interactions
 */

import {
  Contract,
  Interface,
  Wallet,
  HDNodeWallet,
  Transaction,
  TransactionReceipt,
  Signer,
  type JsonRpcProvider,
  type TransactionRequest,
} from 'ethers';
import {
  DecryptionFailedError,
  discloseIsBalanceError,
  discloseUnknownHandleError,
  type DiscloseRequestOptions,
  isEmptyRevert,
  isNoContractAnswer,
  sentButUnconfirmed,
  translateTxError,
  WalletTxError,
} from './txErrors.js';
import { sanitizeTokenName, sanitizeTokenSymbol } from './tokenText.js';
import { getProvider, NetworkName, getNetworkConfig } from '../network/index.js';
import { encryptAmount } from '../fhe/EncryptionService.js';
import { decryptBalance } from '../fhe/DecryptionService.js';
import { CHAIN_IDS } from '../network/NetworkConfig.js';
import { logEvent, type AuditEvent } from '../../storage/AuditLog.js';
import { normaliseHandle, type DecryptSession } from '../fhe/DecryptSession.js';
import { isTransferAmountHandle, recordLocalTransaction } from '../../storage/TransactionStore.js';
import { getCachedBalance, setCachedBalance, invalidateBalance } from './BalanceCache.js';
import { MAX_EUINT64 } from './limits.js';
import { CONFIDENTIAL_TRANSFER_TOPIC0 as CONFIDENTIAL_TRANSFER_TOPIC } from './tokenScan.js';

/** The address in a 32-byte indexed event topic. */
function parseAddressFromTopic(topic: string): string {
  return '0x' + topic.slice(-40);
}

/**
 * Minimal ERC-7984 ABI.
 *
 * Only standard functions are listed. Earlier versions called `$_transfer`, which exists
 * only on OpenZeppelin's hardhat-exposed *mock* contracts; on a real token it reverts
 * during gas estimation. The custom errors are included so ethers can decode reverts
 * into names that `translateTxError` understands.
 */
export const ERC7984_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function confidentialTotalSupply() view returns (bytes32)',
  'function confidentialBalanceOf(address account) view returns (bytes32)',
  'function confidentialTransfer(address to, bytes32 encryptedAmount, bytes inputProof) returns (bytes32)',
  'function setOperator(address operator, uint48 until)',
  'function isOperator(address holder, address spender) view returns (bool)',
  // Disclosure (OpenZeppelin ERC7984): make an amount publicly decryptable, then publish
  // the KMS-signed cleartext. euint64 is a bytes32 handle at the ABI level.
  'function requestDiscloseEncryptedAmount(bytes32 encryptedAmount)',
  'function discloseEncryptedAmount(bytes32 encryptedAmount, uint64 cleartextAmount, bytes decryptionProof)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)',
  'event OperatorSet(address indexed holder, address indexed operator, uint48 until)',
  'event AmountDiscloseRequested(bytes32 indexed encryptedAmount, address indexed requester)',
  'event AmountDisclosed(bytes32 indexed encryptedAmount, uint64 amount)',
  'error ERC7984InvalidReceiver(address receiver)',
  'error ERC7984InvalidSender(address sender)',
  'error ERC7984UnauthorizedSpender(address holder, address spender)',
  'error ERC7984UnauthorizedUseOfEncryptedAmount(bytes32 amount, address user)',
  'error ERC7984ZeroBalance(address holder)',
  'error ZamaProtocolUnsupported()',
];

/** Parsed ABI, used to decode custom-error revert data that ethers leaves undecoded. */
export const ERC7984_INTERFACE = new Interface(ERC7984_ABI);

/** Largest value an euint64 can hold (re-exported from `limits.ts`, its home). */
export { MAX_EUINT64 };

/**
 * How long to wait for a broadcast transaction to be mined before reporting it as sent but
 * not confirmed yet. Sepolia blocks are ~12 s; five minutes covers a congested mempool.
 */
export const CONFIRMATION_TIMEOUT_MS = 5 * 60_000;

/** Extra gas on top of the estimate; FHE operations make estimates slightly unstable. */
const GAS_BUFFER_PERCENT = 20n;

export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

export interface TransferResult {
  txHash: string;
  receipt: TransactionReceipt;
  /**
   * For token transfers: whether the re-decrypted balance dropped by exactly the amount.
   * ERC-7984 moves 0 instead of reverting when the balance is short, so a mined receipt
   * alone does not prove the tokens moved.
   * - moved: balance went down by the amount
   * - unchanged: balance is the same (the transfer moved 0)
   * - changed: balance changed by a different amount (other activity at the same time)
   * - unknown: the balance could not be decrypted after sending
   */
  balanceCheck?: 'moved' | 'unchanged' | 'changed' | 'unknown';
  /** Decrypted balance after the transfer, when known. */
  balanceAfter?: bigint;
}

export interface GetBalanceOptions {
  forceRefresh?: boolean;
  /**
   * Read the encrypted handle at this block. After a send, pass the receipt's block so a
   * node that lags behind cannot hand back the old handle (and the old balance).
   */
  blockTag?: number;
  /**
   * Decrypt through this session's signature instead of signing a new one-off request.
   * Must belong to the same wallet and network.
   */
  session?: DecryptSession;
}

/**
 * Run local bookkeeping (audit log, cache) after a transaction is already on-chain.
 * A full disk or broken permissions must not turn a confirmed transfer into an error
 * that tempts the user to send again.
 */
function bestEffort(fn: () => void): void {
  try {
    fn();
  } catch {
    // Intentionally ignored: the on-chain result is what matters to the user.
  }
}

/** Options for `signAndBroadcast`. */
interface SignAndBroadcastOptions {
  /** Wallet already connected to `provider`; it fills in nonce, fees and chain id. */
  signer: Wallet | HDNodeWallet;
  provider: JsonRpcProvider;
  /** Builds the unsigned call (to, data, gasLimit). Runs before anything is signed. */
  build: () => Promise<TransactionRequest>;
  network: NetworkName;
  /** What is being sent, for error titles: "send" or "operator change". */
  action: string;
  /** Best-effort hooks for the audit log. Never given amounts. */
  onSigned?: (txHash: string) => void;
  onBroadcast?: (txHash: string) => void;
}

/**
 * Sign a transaction locally, then broadcast it and wait for one confirmation.
 *
 * Signing first means the hash is known before anything leaves this machine. Sending via
 * `contract.fn(...)` instead would give us no hash when the broadcast call itself times
 * out, even though the node may have accepted it, and the user could be told to "try
 * again" and pay twice. Used by both transfers and operator changes.
 */
async function signAndBroadcast(opts: SignAndBroadcastOptions): Promise<TransferResult> {
  const { signer, provider, network, action } = opts;
  const translateOpts = { iface: ERC7984_INTERFACE, action };

  // Step 1: build and sign locally. Nothing has left this machine yet, so a failure
  // here is safe to retry.
  let signed: string;
  try {
    const request = await signer.populateTransaction(await opts.build());
    signed = await signer.signTransaction(request);
  } catch (err) {
    throw translateTxError(err, translateOpts);
  }

  // The hash is known before broadcasting. From here on, *every* failure must carry it
  // and must not say "try again" unless the node provably refused it: a broadcast that
  // timed out may still be in the mempool, and resending would pay twice.
  const txHash = Transaction.from(signed).hash!;
  const explorerUrl = getTxExplorerUrl(txHash, network);
  if (opts.onSigned) bestEffort(() => opts.onSigned!(txHash));

  let tx: Awaited<ReturnType<JsonRpcProvider['broadcastTransaction']>>;
  try {
    tx = await provider.broadcastTransaction(signed);
  } catch (err) {
    // "nonce too low" can mean our own transaction was already mined (an RPC gateway
    // retried the broadcast on another backend). If the chain has a receipt for our
    // hash, report what actually happened instead of an unclear error.
    if ((err as { code?: string } | null)?.code === 'NONCE_EXPIRED') {
      const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
      // Only an explicit status decides. 1 is success and 0 is a revert (what ethers'
      // wait() checks). A null status only exists on pre-Byzantium receipts, which
      // mainnet and Sepolia never produce, so it means the RPC gave a malformed answer:
      // trust it neither way and fall through to SENT_UNCONFIRMED ("check the explorer").
      // That is the safe side: we never claim success, and never say "not sent".
      if (receipt?.status === 1) {
        if (opts.onBroadcast) bestEffort(() => opts.onBroadcast!(txHash));
        return { txHash, receipt };
      }
      if (receipt?.status === 0) {
        // Same shape ethers' wait() throws for a status-0 receipt, so it maps to TX_REVERTED.
        throw sentButUnconfirmed(
          Object.assign(new Error('transaction execution reverted'), {
            code: 'CALL_EXCEPTION',
            action: 'sendTransaction',
            receipt,
          }),
          txHash,
          explorerUrl,
          translateOpts,
        );
      }
    }
    throw sentButUnconfirmed(err, txHash, explorerUrl, translateOpts);
  }
  if (opts.onBroadcast) bestEffort(() => opts.onBroadcast!(txHash));

  let receipt: TransactionReceipt | null;
  try {
    // ethers v6 wait() throws CALL_EXCEPTION (action "sendTransaction") on a status-0
    // receipt, and TRANSACTION_REPLACED if another tx took the nonce; sentButUnconfirmed
    // maps those to TX_REVERTED and TX_REPLACED.
    // Bounded wait: past it the user gets SENT_UNCONFIRMED with the hash to check,
    // rather than a spinner that never ends.
    receipt = await tx.wait(1, CONFIRMATION_TIMEOUT_MS);
    if (!receipt) throw new Error('No receipt returned'); // only with confirmations=0
  } catch (err) {
    throw sentButUnconfirmed(err, txHash, explorerUrl, translateOpts);
  }
  return { txHash, receipt };
}

/** Outcome of re-decrypting the sender's balance after a confirmed transfer. */
export interface BalanceAfterCheck {
  balanceCheck: NonNullable<TransferResult['balanceCheck']>;
  balanceAfter?: bigint;
}

/**
 * Compare the balance after a confirmed transfer with the balance before it.
 * Never throws: the transfer is already final, so a decryption failure (relayer busy,
 * network blip) only means the outcome is "unknown", not that the send failed.
 */
export async function checkBalanceAfter(
  readBalance: () => Promise<bigint>,
  balanceBefore: bigint,
  amount: bigint,
): Promise<BalanceAfterCheck> {
  let balanceAfter: bigint;
  try {
    balanceAfter = await readBalance();
  } catch {
    return { balanceCheck: 'unknown' };
  }
  if (balanceAfter === balanceBefore - amount) return { balanceCheck: 'moved', balanceAfter };
  if (balanceAfter === balanceBefore) return { balanceCheck: 'unchanged', balanceAfter };
  // Something else touched the balance at the same time (an incoming transfer, say).
  return { balanceCheck: 'changed', balanceAfter };
}

/**
 * Get token contract instance
 */
function getTokenContract(tokenAddress: string, network: NetworkName, signer?: Signer): Contract {
  const provider = getProvider(network);
  return new Contract(tokenAddress, ERC7984_ABI, signer ?? provider);
}

/**
 * Whether a failed read means "there is no such contract (function) here". `0x` back
 * (BAD_DATA) does. A revert with no data only does when the address has no code: ethers
 * reports a JSON-RPC error from the endpoint in the same shape, and that is the RPC's
 * problem, not the token's. If the code check itself fails, say nothing about the token.
 */
async function answeredLikeNoContract(
  err: unknown,
  address: string,
  network: NetworkName,
): Promise<boolean> {
  if (isNoContractAnswer(err)) return true;
  if (!isEmptyRevert(err)) return false;
  try {
    return (await getProvider(network).getCode(address)) === '0x';
  } catch {
    return false;
  }
}

/**
 * Get token information (name, symbol, decimals)
 */
export async function getTokenInfo(tokenAddress: string, network: NetworkName): Promise<TokenInfo> {
  const contract = getTokenContract(tokenAddress, network);

  let name: unknown, symbol: unknown, decimals: unknown;
  try {
    [name, symbol, decimals] = await Promise.all([
      contract.name(),
      contract.symbol(),
      contract.decimals(),
    ]);
  } catch (err) {
    // `0x` back from name() & co. means there is no token here (an account, another kind
    // of contract, or a token on a different network). Say that, not "could not decode".
    if (await answeredLikeNoContract(err, tokenAddress, network)) {
      throw new WalletTxError(
        'NOT_A_TOKEN',
        `That address is not a token contract on ${network}.`,
        'It did not answer name(), symbol() and decimals() the way a token does. It may be a wallet address, another kind of contract, or a token on a different network.',
        'Check the address and network on a block explorer.',
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }

  // name() and symbol() are whatever the (user-added, untrusted) contract returns: strip
  // terminal escapes and invisible characters, and cap the length, before anything
  // stores or prints them. decimals is a uint8, so it is already bounded.
  return {
    address: tokenAddress,
    name: sanitizeTokenName(String(name)),
    symbol: sanitizeTokenSymbol(String(symbol)),
    decimals: Number(decimals),
  };
}

/**
 * Get encrypted balance handle for an address
 * Note: This returns the encrypted handle, not the actual balance
 */
export async function getEncryptedBalance(
  tokenAddress: string,
  userAddress: string,
  network: NetworkName,
  blockTag?: number,
): Promise<bigint> {
  const contract = getTokenContract(tokenAddress, network);
  // The ABI returns bytes32 (a 0x-hex string). Convert once here so the rest of the
  // wallet (zero check, cache key, decryption) works with a single bigint representation.
  let handle: string | bigint;
  try {
    handle =
      blockTag === undefined
        ? await contract.confidentialBalanceOf(userAddress)
        : await contract.confidentialBalanceOf(userAddress, { blockTag });
  } catch (err) {
    if (await answeredLikeNoContract(err, tokenAddress, network)) {
      throw new WalletTxError(
        'NOT_ERC7984',
        `That address is not an ERC-7984 token on ${network}.`,
        'It did not answer confidentialBalanceOf(). It may not be a confidential token, or it may be on a different network.',
        'Check the token address and network on a block explorer.',
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }
  return BigInt(handle);
}

/**
 * Get decrypted balance for a user
 * Uses handle-based caching: only decrypts if the encrypted handle changed
 */
export async function getDecryptedBalance(
  tokenAddress: string,
  wallet: Wallet | HDNodeWallet,
  network: NetworkName,
  options: GetBalanceOptions = {},
): Promise<bigint> {
  const { forceRefresh = false, blockTag, session } = options;

  // Always fetch the encrypted handle first (cheap RPC call)
  const encryptedHandle = await getEncryptedBalance(
    tokenAddress,
    wallet.address,
    network,
    blockTag,
  );

  // If handle is zero, no balance
  if (encryptedHandle === 0n) {
    return 0n;
  }

  // Check cache using handle comparison (unless force refresh)
  if (!forceRefresh) {
    const cached = getCachedBalance(wallet.address, tokenAddress, network, encryptedHandle);
    if (cached !== null) {
      // Handle matches = balance unchanged, return cached value
      return cached;
    }
  }

  // Handle changed or no cache - decrypt the balance (expensive)
  // Mark failures of this step, so callers can tell a relayer problem from a failed
  // contract read above.
  let balance: bigint;
  try {
    balance = session
      ? await decryptOneWithSession(session, encryptedHandle, tokenAddress)
      : await decryptBalance(encryptedHandle, tokenAddress, wallet, network);
  } catch (err) {
    throw new DecryptionFailedError(err);
  }

  // Cache with the current handle. The cache is an optimisation: a disk error must not
  // hide a balance that was decrypted fine.
  bestEffort(() =>
    setCachedBalance(wallet.address, tokenAddress, network, encryptedHandle, balance),
  );

  return balance;
}

/** Decrypt one handle with a session; throws the request's error. */
async function decryptOneWithSession(
  session: DecryptSession,
  handle: bigint,
  tokenAddress: string,
): Promise<bigint> {
  const key = normaliseHandle(handle);
  const { values, errors } = await session.decrypt([
    { handle: key, contractAddress: tokenAddress },
  ]);
  const v = values.get(key);
  if (v === undefined) throw errors.get(key) ?? new Error('Decryption returned no value');
  return v;
}

/** Decrypted balances by lowercase token address, and per-token failures. */
export interface BalanceBatch {
  values: Record<string, bigint>;
  errors: Record<string, unknown>;
}

/**
 * Decrypt the balances of many tokens with one session: read every handle (cheap RPC
 * reads, in parallel), answer zero handles and unchanged handles from the cache, and
 * send the rest to the relayer in as few userDecrypt requests as the SDK allows. The
 * session signs once for the whole token list.
 */
export async function decryptBalancesWithSession(
  session: DecryptSession,
  tokenAddresses: string[],
  network: NetworkName,
  options: { forceRefresh?: boolean } = {},
): Promise<BalanceBatch> {
  const values: Record<string, bigint> = {};
  const errors: Record<string, unknown> = {};
  const owner = session.address;
  const handles = await Promise.all(
    tokenAddresses.map(async (token) => {
      try {
        return { token, handle: await getEncryptedBalance(token, owner, network) };
      } catch (err) {
        errors[token.toLowerCase()] = err;
        return null;
      }
    }),
  );
  const todo: Array<{ token: string; handle: bigint }> = [];
  for (const h of handles) {
    if (!h) continue;
    const key = h.token.toLowerCase();
    if (h.handle === 0n) {
      values[key] = 0n;
      continue;
    }
    const cached = options.forceRefresh
      ? null
      : getCachedBalance(owner, h.token, network, h.handle);
    if (cached !== null) values[key] = cached;
    else todo.push(h);
  }
  if (todo.length) {
    let outcome: Awaited<ReturnType<DecryptSession['decrypt']>>;
    try {
      outcome = await session.decrypt(
        todo.map((t) => ({ handle: normaliseHandle(t.handle), contractAddress: t.token })),
        tokenAddresses,
      );
    } catch (err) {
      // Signing failed (or the wallet was locked meanwhile): every pending token failed.
      for (const t of todo) errors[t.token.toLowerCase()] = new DecryptionFailedError(err);
      return { values, errors };
    }
    for (const t of todo) {
      const key = t.token.toLowerCase();
      const v = outcome.values.get(normaliseHandle(t.handle));
      if (v === undefined) {
        errors[key] = new DecryptionFailedError(outcome.errors.get(normaliseHandle(t.handle)));
        continue;
      }
      values[key] = v;
      bestEffort(() => setCachedBalance(owner, t.token, network, t.handle, v));
    }
  }
  return { values, errors };
}

/** Optional progress callbacks for `PreparedTransfer.send`. Errors thrown in them are ignored. */
export interface SendHooks {
  /** The transaction is signed locally; nothing has left the machine yet. */
  onSigned?: (txHash: string) => void;
  /** The node accepted the transaction; it is now waiting to be mined. */
  onBroadcast?: (txHash: string) => void;
}

/** Result of a successful pre-flight check: everything needed to show a review and send. */
export interface PreparedTransfer {
  /** Gas limit including a safety buffer. */
  gasLimit: bigint;
  /** Estimated worst-case network fee in wei (gasLimit × maxFeePerGas). */
  feeWei: bigint;
  /** The sender's ETH balance in wei at preparation time. */
  ethBalanceWei: bigint;
  /** The sender's decrypted token balance (base units) at preparation time. */
  tokenBalance: bigint;
  /**
   * Broadcast the transfer and wait for one confirmation. `hooks.onBroadcast` fires as
   * soon as the node accepted it, so a UI can show "pending" with the hash while waiting.
   */
  send: (hooks?: SendHooks) => Promise<TransferResult>;
}

/**
 * Reject amounts an euint64 cannot hold. Done before encryption so the user gets a
 * clear message instead of an SDK error.
 */
export function assertTransferAmount(amount: bigint): void {
  if (amount <= 0n || amount > MAX_EUINT64) {
    throw new WalletTxError(
      'AMOUNT_OUT_OF_RANGE',
      'That amount cannot be sent.',
      "Confidential amounts are 64-bit numbers in the token's smallest unit, and must be above zero.",
      'Enter a smaller amount.',
    );
  }
}

/**
 * Encrypt the amount, simulate the transfer and check the wallet can pay for gas.
 *
 * Nothing is signed or broadcast here. Any failure is thrown as a `WalletTxError`
 * with a plain-English explanation, so the UI can stop before asking to sign.
 */
export async function prepareConfidentialTransfer(
  wallet: Wallet | HDNodeWallet,
  tokenAddress: string,
  toAddress: string,
  amount: bigint,
  network: NetworkName,
  opts: { session?: DecryptSession } = {},
): Promise<PreparedTransfer> {
  assertTransferAmount(amount);
  // The session's signature covers the balance checks before and after the send.
  const session = opts.session?.active ? opts.session : undefined;
  const chainId = network === 'mainnet' ? CHAIN_IDS.MAINNET : CHAIN_IDS.SEPOLIA;

  try {
    const provider = getProvider(network);

    // The RPC must serve the chain we sign for; a mixed-up custom URL fails confusingly.
    // The provider also checks once per process, but ask again right before signing:
    // this is the one place where a wrong chain could cost money.
    const rpcChainId = BigInt((await provider.send('eth_chainId', [])) as string);
    if (rpcChainId !== chainId) {
      throw new WalletTxError(
        'WRONG_CHAIN',
        'Your RPC endpoint is on the wrong network.',
        `It serves chain ${rpcChainId}, but ${network} is chain ${chainId}.`,
        'Fix the RPC URL in Settings, or reset it to the default.',
      );
    }

    // A transfer above the balance does not revert in ERC-7984: it silently moves 0.
    // Decrypt first (cached while the encrypted handle is unchanged) and stop early.
    let tokenBalance: bigint;
    try {
      tokenBalance = await getDecryptedBalance(tokenAddress, wallet, network, { session });
    } catch (err) {
      // Only the decrypt step becomes BALANCE_CHECK_FAILED. A failed contract read keeps
      // its own meaning (unreachable RPC, wrong chain, not an ERC-7984 token, a revert).
      const translated = translateTxError(err, { iface: ERC7984_INTERFACE });
      if (!(err instanceof DecryptionFailedError)) throw translated;
      throw new WalletTxError(
        'BALANCE_CHECK_FAILED',
        "Couldn't check your token balance before sending.",
        translated.code === 'RELAYER_TIMEOUT'
          ? 'Decrypting the balance through the Zama relayer timed out. Nothing was sent.'
          : 'Decrypting the balance through the Zama relayer failed. Nothing was sent.',
        'Try again in a minute.',
        translated.raw,
      );
    }
    if (amount > tokenBalance) {
      throw new WalletTxError(
        'INSUFFICIENT_TOKEN_BALANCE',
        'That is more than this wallet holds.',
        'ERC-7984 would send 0 instead of failing, so the wallet stops the send here.',
        'Enter a smaller amount, or check you picked the right wallet and token.',
      );
    }

    // The encrypted input is bound to (token, sender): the sender must be msg.sender.
    const encrypted = await encryptAmount(chainId, tokenAddress, wallet.address, amount);

    const connectedWallet = wallet.connect(provider);
    const contract = getTokenContract(tokenAddress, network, connectedWallet);
    const transfer = contract.getFunction('confidentialTransfer(address,bytes32,bytes)');
    const args = [toAddress, encrypted.handleHex, encrypted.inputProofHex] as const;

    // Simulate first. A revert here means the real send would fail too.
    const estimate = await transfer.estimateGas(...args);
    const gasLimit = (estimate * (100n + GAS_BUFFER_PERCENT)) / 100n;

    const [feeData, ethBalanceWei] = await Promise.all([
      provider.getFeeData(),
      provider.getBalance(wallet.address),
    ]);
    const pricePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (pricePerGas == null) {
      // Without a price we can't check affordability or show a fee; don't guess "0".
      throw new WalletTxError(
        'RPC_UNAVAILABLE',
        'Could not get the current network fee.',
        'The RPC endpoint did not return gas price information.',
        'Try again, or use a different RPC endpoint in Settings.',
      );
    }
    const feeWei = gasLimit * pricePerGas;

    if (ethBalanceWei < feeWei) {
      throw new WalletTxError(
        'INSUFFICIENT_GAS_FUNDS',
        'Not enough ETH to pay the network fee.',
        'Every send needs a little ETH for gas, even though the token amount is encrypted.',
        'Add ETH to this wallet (on Sepolia, use a faucet) and try again.',
      );
    }

    const send = async (hooks: SendHooks = {}): Promise<TransferResult> => {
      const audit = { token: tokenAddress, to: toAddress, network };
      const result = await signAndBroadcast({
        signer: connectedWallet,
        provider,
        build: () => transfer.populateTransaction(...args, { gasLimit }),
        network,
        action: 'send',
        // Signed is not sent: TRANSFER_SIGNED without TRANSFER_BROADCAST means the
        // broadcast failed or its answer was lost.
        onSigned: (txHash) => {
          bestEffort(() => logEvent('TRANSFER_SIGNED', { ...audit, txHash }));
          if (hooks.onSigned) bestEffort(() => hooks.onSigned!(txHash));
        },
        onBroadcast: (txHash) => {
          bestEffort(() => logEvent('TRANSFER_BROADCAST', { ...audit, txHash }));
          if (hooks.onBroadcast) bestEffort(() => hooks.onBroadcast!(txHash));
        },
      });

      // Confirmed. Local bookkeeping must never turn a successful transfer into an error.
      // The encrypted handle changed, so drop the cached plaintext balance; the amount is
      // deliberately not logged so the audit log doesn't undo the token's confidentiality.
      bestEffort(() => invalidateBalance(wallet.address, tokenAddress, network));
      bestEffort(() => logEvent('TRANSFER', { ...audit, txHash: result.txHash }));

      // ERC-7984 moves 0 instead of reverting when the balance is short, so a confirmed
      // receipt alone does not prove the tokens moved. Re-decrypt to find out. This is
      // best-effort: the transfer is already final, so a failure here only means "unknown".
      const { balanceCheck, balanceAfter } = await checkBalanceAfter(
        () =>
          getDecryptedBalance(tokenAddress, wallet, network, {
            forceRefresh: true,
            session: session?.active ? session : undefined,
            // At (or after) the block that mined the transfer, never an older one.
            blockTag: result.receipt.blockNumber,
          }),
        tokenBalance,
        amount,
      );
      return { ...result, balanceCheck, balanceAfter };
    };

    return { gasLimit, feeWei, ethBalanceWei, tokenBalance, send };
  } catch (err) {
    throw translateTxError(err, { iface: ERC7984_INTERFACE });
  }
}

/**
 * Transfer tokens confidentially: prepare (simulate + gas check), then send.
 * Kept for callers that do not need to show a review step in between.
 */
export async function confidentialTransfer(
  wallet: Wallet | HDNodeWallet,
  tokenAddress: string,
  toAddress: string,
  amount: bigint,
  network: NetworkName,
): Promise<TransferResult> {
  const prepared = await prepareConfidentialTransfer(
    wallet,
    tokenAddress,
    toAddress,
    amount,
    network,
  );
  return prepared.send();
}

/**
 * Record a completed transfer in transaction history
 */
export function recordTransferTransaction(params: {
  tokenAddress: string;
  tokenSymbol: string;
  from: string;
  to: string;
  amount: string;
  txHash: string;
  network: NetworkName;
  blockNumber: number;
}): void {
  recordLocalTransaction(params);
}

/**
 * Allow `operator` to move this wallet's tokens until `untilUnixSeconds` (0 revokes):
 * `prepareSetOperator` and send it at once, for callers without a review step.
 */
export async function setOperator(
  wallet: Wallet | HDNodeWallet,
  tokenAddress: string,
  operator: string,
  untilUnixSeconds: number,
  network: NetworkName,
): Promise<TransferResult> {
  const prepared = await prepareSetOperator(
    wallet,
    tokenAddress,
    operator,
    untilUnixSeconds,
    network,
  );
  return prepared.send();
}

/** Whether `spender` may currently move `holder`'s tokens. */
export async function isOperator(
  tokenAddress: string,
  holder: string,
  spender: string,
  network: NetworkName,
): Promise<boolean> {
  const contract = getTokenContract(tokenAddress, network);
  return Boolean(await contract.isOperator(holder, spender));
}

/**
 * Get transaction explorer URL
 */
export function getTxExplorerUrl(txHash: string, network: NetworkName): string {
  const config = getNetworkConfig(network);
  return `${config.explorerUrl}/tx/${txHash}`;
}

/** A simulated, fee-checked contract call (operator change, disclosure) ready to sign. */
export interface PreparedCall {
  gasLimit: bigint;
  feeWei: bigint;
  ethBalanceWei: bigint;
  /** Sign locally, broadcast, wait for one confirmation. Same error rules as transfers. */
  send: (hooks?: SendHooks) => Promise<TransferResult>;
}

/** What `prepareTokenCall` sends. */
interface TokenCallSpec {
  /** Full function signature, e.g. `setOperator(address,uint48)`. */
  fn: string;
  args: unknown[];
  /** For error titles: "operator change", "disclosure request", "disclosure". */
  action: string;
  /** Written to the audit log once confirmed. Never contains amounts. */
  audit: { event: AuditEvent; details: Record<string, string> };
}

/**
 * The send-safety flow for any token call that is not a transfer: check the RPC chain,
 * simulate (estimateGas), price the fee and check the ETH balance. Nothing is signed
 * until `send` is called; then it goes through `signAndBroadcast`, so after the
 * broadcast every failure keeps its hash (SENT_UNCONFIRMED, TX_REVERTED, TX_REPLACED).
 */
async function prepareTokenCall(
  wallet: Wallet | HDNodeWallet,
  tokenAddress: string,
  network: NetworkName,
  spec: TokenCallSpec,
): Promise<PreparedCall> {
  const chainId = network === 'mainnet' ? CHAIN_IDS.MAINNET : CHAIN_IDS.SEPOLIA;
  const translateOpts = { iface: ERC7984_INTERFACE, action: spec.action };
  try {
    const provider = getProvider(network);
    const rpcChainId = BigInt((await provider.send('eth_chainId', [])) as string);
    if (rpcChainId !== chainId) {
      throw new WalletTxError(
        'WRONG_CHAIN',
        'Your RPC endpoint is on the wrong network.',
        `It serves chain ${rpcChainId}, but ${network} is chain ${chainId}.`,
        'Fix the RPC URL in Settings, or reset it to the default.',
      );
    }
    const connectedWallet = wallet.connect(provider);
    const contract = getTokenContract(tokenAddress, network, connectedWallet);
    const fn = contract.getFunction(spec.fn);
    // Simulate first: a revert here means the real transaction would fail too.
    const estimate = await fn.estimateGas(...spec.args);
    const gasLimit = (estimate * (100n + GAS_BUFFER_PERCENT)) / 100n;
    const [feeData, ethBalanceWei] = await Promise.all([
      provider.getFeeData(),
      provider.getBalance(wallet.address),
    ]);
    const pricePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (pricePerGas == null) {
      throw new WalletTxError(
        'RPC_UNAVAILABLE',
        'Could not get the current network fee.',
        'The RPC endpoint did not return gas price information.',
        'Try again, or use a different RPC endpoint in Settings.',
      );
    }
    const feeWei = gasLimit * pricePerGas;
    if (ethBalanceWei < feeWei) {
      throw new WalletTxError(
        'INSUFFICIENT_GAS_FUNDS',
        'Not enough ETH to pay the network fee.',
        'Every transaction needs a little ETH for gas.',
        'Add ETH to this wallet (on Sepolia, use a faucet) and try again.',
      );
    }
    const send = async (hooks: SendHooks = {}): Promise<TransferResult> => {
      const result = await signAndBroadcast({
        signer: connectedWallet,
        provider,
        build: () => fn.populateTransaction(...spec.args, { gasLimit }),
        network,
        action: spec.action,
        onSigned: (txHash) => {
          if (hooks.onSigned) bestEffort(() => hooks.onSigned!(txHash));
        },
        onBroadcast: (txHash) => {
          if (hooks.onBroadcast) bestEffort(() => hooks.onBroadcast!(txHash));
        },
      });
      bestEffort(() =>
        logEvent(spec.audit.event, { ...spec.audit.details, txHash: result.txHash }),
      );
      return result;
    };
    return { gasLimit, feeWei, ethBalanceWei, send };
  } catch (err) {
    throw translateTxError(err, translateOpts);
  }
}

/** Largest value a uint48 holds; `setOperator`'s expiry type. */
export const MAX_UINT48 = 2 ** 48 - 1;

/**
 * Prepare `setOperator(operator, until)`: simulated and fee-checked, not signed.
 * `until` is a unix time in seconds; 0 revokes. ERC-7984 has no `approve`: an operator
 * can move *all* of the holder's tokens until `until`.
 */
export async function prepareSetOperator(
  wallet: Wallet | HDNodeWallet,
  tokenAddress: string,
  operator: string,
  untilUnixSeconds: number,
  network: NetworkName,
): Promise<PreparedCall> {
  if (
    !Number.isInteger(untilUnixSeconds) ||
    untilUnixSeconds < 0 ||
    untilUnixSeconds > MAX_UINT48
  ) {
    throw new Error('Operator expiry must be a unix timestamp in seconds');
  }
  return prepareTokenCall(wallet, tokenAddress, network, {
    fn: 'setOperator(address,uint48)',
    args: [operator, untilUnixSeconds],
    action: 'operator change',
    audit: {
      event: 'OPERATOR_SET',
      details: { token: tokenAddress, operator, until: String(untilUnixSeconds), network },
    },
  });
}

/**
 * Prepare `requestDiscloseEncryptedAmount(handle)`: step 1 of disclosing an amount. The
 * token checks the caller may use the handle (ACL) and makes it publicly decryptable.
 */
export async function prepareDiscloseRequest(
  wallet: Wallet | HDNodeWallet,
  tokenAddress: string,
  handle: string,
  network: NetworkName,
  opts: DiscloseRequestOptions = {},
): Promise<PreparedCall> {
  // The contract would accept the wallet's own balance handle and publish the balance.
  const balance = await getEncryptedBalance(tokenAddress, wallet.address, network);
  if (normaliseHandle(balance) === normaliseHandle(handle)) throw discloseIsBalanceError();
  // ...and any earlier balance handle too: only known transfer amounts go ahead.
  if (
    !opts.vouched &&
    !isTransferAmountHandle({ walletAddress: wallet.address, network, tokenAddress, handle })
  ) {
    throw discloseUnknownHandleError();
  }
  return prepareTokenCall(wallet, tokenAddress, network, {
    fn: 'requestDiscloseEncryptedAmount(bytes32)',
    args: [normaliseHandle(handle)],
    action: 'disclosure request',
    audit: { event: 'DISCLOSE_REQUESTED', details: { token: tokenAddress, network } },
  });
}

/**
 * Prepare `discloseEncryptedAmount(handle, cleartext, proof)`: step 2. The contract
 * verifies the KMS signatures (`FHE.checkSignatures`) and emits `AmountDisclosed`.
 * The cleartext is public on-chain from then on, but it is still never written to the
 * audit log.
 */
export async function prepareDiscloseAmount(
  wallet: Wallet | HDNodeWallet,
  tokenAddress: string,
  handle: string,
  cleartext: bigint,
  proof: string,
  network: NetworkName,
): Promise<PreparedCall> {
  if (cleartext < 0n || cleartext > MAX_EUINT64) throw new Error('Not a 64-bit amount');
  return prepareTokenCall(wallet, tokenAddress, network, {
    fn: 'discloseEncryptedAmount(bytes32,uint64,bytes)',
    args: [normaliseHandle(handle), cleartext, proof],
    action: 'disclosure',
    audit: { event: 'AMOUNT_DISCLOSED', details: { token: tokenAddress, network } },
  });
}

/** Minimal ACL ABI (Zama host contracts), the same calls the relayer SDK makes. */
const ACL_ABI = [
  'function persistAllowed(bytes32 handle, address account) view returns (bool)',
  'function isAllowedForDecryption(bytes32 handle) view returns (bool)',
];

function aclContract(aclAddress: string, network: NetworkName): Contract {
  return new Contract(aclAddress, ACL_ABI, getProvider(network));
}

/**
 * Which handles `user` may user-decrypt: the SDK requires both the user and the token
 * contract to be persistently allowed on the ACL, and would fail the whole batch for one
 * bad handle. Checking first lets the wallet show "encrypted" for those quietly.
 */
export async function filterUserDecryptable(
  aclAddress: string,
  pairs: Array<{ handle: string; contractAddress: string }>,
  user: string,
  network: NetworkName,
): Promise<Set<string>> {
  const acl = aclContract(aclAddress, network);
  const ok = new Set<string>();
  await Promise.all(
    pairs.map(async (p) => {
      const h = normaliseHandle(p.handle);
      const [u, c] = await Promise.all([
        acl.persistAllowed(h, user) as Promise<boolean>,
        acl.persistAllowed(h, p.contractAddress) as Promise<boolean>,
      ]);
      if (u && c) ok.add(h);
    }),
  );
  return ok;
}

/** Whether a handle has been made publicly decryptable (disclosure step 1 done). */
export async function isPubliclyDecryptable(
  aclAddress: string,
  handle: string,
  network: NetworkName,
): Promise<boolean> {
  return Boolean(
    await aclContract(aclAddress, network).isAllowedForDecryption(normaliseHandle(handle)),
  );
}

/**
 * Find the ConfidentialTransfer amount handle in a mined transaction, for a transfer
 * from or to `wallet` on one of `tokens`. Null when there is none.
 */
export async function findTransferHandle(
  txHash: string,
  wallet: string,
  tokens: string[],
  network: NetworkName,
): Promise<{ token: string; handle: string } | null> {
  const receipt = await getProvider(network).getTransactionReceipt(txHash);
  if (!receipt) return null;
  const me = wallet.toLowerCase();
  const tracked = new Set(tokens.map((t) => t.toLowerCase()));
  for (const log of receipt.logs) {
    if (log.topics[0] !== CONFIDENTIAL_TRANSFER_TOPIC || log.topics.length < 4) continue;
    if (!tracked.has(log.address.toLowerCase())) continue;
    const from = parseAddressFromTopic(log.topics[1]).toLowerCase();
    const to = parseAddressFromTopic(log.topics[2]).toLowerCase();
    if (from === me || to === me) return { token: log.address, handle: log.topics[3] };
  }
  return null;
}
