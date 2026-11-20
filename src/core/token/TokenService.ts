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
import { logEvent } from '../../storage/AuditLog.js';
import { recordLocalTransaction } from '../../storage/TransactionStore.js';
import { getCachedBalance, setCachedBalance, invalidateBalance } from './BalanceCache.js';
import { MAX_EUINT64 } from './limits.js';

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
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)',
  'event OperatorSet(address indexed holder, address indexed operator, uint48 until)',
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
  const { forceRefresh = false, blockTag } = options;

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
    balance = await decryptBalance(encryptedHandle, tokenAddress, wallet, network);
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
  /** Broadcast the transfer and wait for one confirmation. */
  send: () => Promise<TransferResult>;
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
): Promise<PreparedTransfer> {
  assertTransferAmount(amount);
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
      tokenBalance = await getDecryptedBalance(tokenAddress, wallet, network);
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

    const send = async (): Promise<TransferResult> => {
      const audit = { token: tokenAddress, to: toAddress, network };
      const result = await signAndBroadcast({
        signer: connectedWallet,
        provider,
        build: () => transfer.populateTransaction(...args, { gasLimit }),
        network,
        action: 'send',
        // Signed is not sent: TRANSFER_SIGNED without TRANSFER_BROADCAST means the
        // broadcast failed or its answer was lost.
        onSigned: (txHash) => logEvent('TRANSFER_SIGNED', { ...audit, txHash }),
        onBroadcast: (txHash) => logEvent('TRANSFER_BROADCAST', { ...audit, txHash }),
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
 * Transaction type
 */
export type WalletTransactionType = 'transfer' | 'mint' | 'burn' | 'eth';

/**
 * Transaction from Etherscan API
 */
export interface WalletTransaction {
  txHash: string;
  type: WalletTransactionType;
  from: string;
  to: string;
  blockNumber: number;
  timestamp: number;
  tokenAddress: string;
  tokenSymbol: string;
  amount: string | null; // ETH transfers have amount, token transfers are encrypted
}

interface EtherscanLog {
  transactionHash: string;
  address: string;
  topics: string[];
  blockNumber: string;
  timeStamp: string;
}

interface EtherscanLogsResponse {
  status: string;
  result: EtherscanLog[] | string;
}

interface EtherscanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  blockNumber: string;
  timeStamp: string;
}

interface EtherscanTxResponse {
  status: string;
  result: EtherscanTx[] | string;
}

/** Etherscan requests give up after this long instead of hanging the history screen. */
const ETHERSCAN_TIMEOUT_MS = 15_000;

// Etherscan V2 API base URL
const ETHERSCAN_V2_API = 'https://api.etherscan.io/v2/api';

// ConfidentialTransfer event signature hash
// keccak256("ConfidentialTransfer(address,address,bytes32)")
const CONFIDENTIAL_TRANSFER_TOPIC =
  '0x67500e8d0ed826d2194f514dd0d8124f35648ab6e3fb5e6ed867134cffe661e9';

// Zero address for mint/burn detection
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Parse address from event topic (remove padding)
 */
function parseAddressFromTopic(topic: string): string {
  return '0x' + topic.slice(-40);
}

/**
 * Determine transaction type based on from/to addresses
 */
function getTransactionType(from: string, to: string): WalletTransactionType {
  if (from.toLowerCase() === ZERO_ADDRESS) return 'mint';
  if (to.toLowerCase() === ZERO_ADDRESS) return 'burn';
  return 'transfer';
}

/**
 * Format ETH amount from wei
 */
function formatWeiToEth(wei: string): string {
  const value = BigInt(wei);
  if (value === 0n) return '0';

  const eth = Number(value) / 1e18;
  // Format with up to 6 decimal places, remove trailing zeros
  return eth.toFixed(6).replace(/\.?0+$/, '');
}

/**
 * Get transactions for a wallet from Etherscan V2 API
 * Queries ConfidentialTransfer events and ETH transfers
 * Requires ETHERSCAN_API_KEY environment variable
 */
export async function getWalletTransactions(
  walletAddress: string,
  tokenAddresses: string[],
  tokenMap: Map<string, { symbol: string }>,
  network: NetworkName,
  startBlock: number = 0,
): Promise<WalletTransaction[]> {
  const config = getNetworkConfig(network);
  const apiKey = process.env.ETHERSCAN_API_KEY;

  if (!apiKey) {
    return [];
  }

  const transactions: WalletTransaction[] = [];
  const seenTxHashes = new Set<string>();

  // Pad wallet address to 32 bytes for topic matching
  const paddedWallet = '0x' + walletAddress.slice(2).toLowerCase().padStart(64, '0');

  // Query ConfidentialTransfer events for each token contract
  for (const tokenAddress of tokenAddresses) {
    const tokenInfo = tokenMap.get(tokenAddress.toLowerCase());
    if (!tokenInfo) continue;

    // Query outgoing transfers (wallet is sender)
    const outgoingUrl = new URL(ETHERSCAN_V2_API);
    outgoingUrl.searchParams.set('chainid', config.chainIdNumber.toString());
    outgoingUrl.searchParams.set('module', 'logs');
    outgoingUrl.searchParams.set('action', 'getLogs');
    outgoingUrl.searchParams.set('address', tokenAddress);
    outgoingUrl.searchParams.set('topic0', CONFIDENTIAL_TRANSFER_TOPIC);
    outgoingUrl.searchParams.set('topic1', paddedWallet);
    outgoingUrl.searchParams.set('topic0_1_opr', 'and');
    outgoingUrl.searchParams.set('fromBlock', startBlock.toString());
    outgoingUrl.searchParams.set('toBlock', 'latest');
    outgoingUrl.searchParams.set('apikey', apiKey);

    // Query incoming transfers (wallet is recipient)
    const incomingUrl = new URL(ETHERSCAN_V2_API);
    incomingUrl.searchParams.set('chainid', config.chainIdNumber.toString());
    incomingUrl.searchParams.set('module', 'logs');
    incomingUrl.searchParams.set('action', 'getLogs');
    incomingUrl.searchParams.set('address', tokenAddress);
    incomingUrl.searchParams.set('topic0', CONFIDENTIAL_TRANSFER_TOPIC);
    incomingUrl.searchParams.set('topic2', paddedWallet);
    incomingUrl.searchParams.set('topic0_2_opr', 'and');
    incomingUrl.searchParams.set('fromBlock', startBlock.toString());
    incomingUrl.searchParams.set('toBlock', 'latest');
    incomingUrl.searchParams.set('apikey', apiKey);

    const [outgoingRes, incomingRes] = await Promise.all([
      fetch(outgoingUrl.toString(), { signal: AbortSignal.timeout(ETHERSCAN_TIMEOUT_MS) }),
      fetch(incomingUrl.toString(), { signal: AbortSignal.timeout(ETHERSCAN_TIMEOUT_MS) }),
    ]);

    const [outgoingData, incomingData] = await Promise.all([
      outgoingRes.json() as Promise<EtherscanLogsResponse>,
      incomingRes.json() as Promise<EtherscanLogsResponse>,
    ]);

    // Process outgoing transfers
    if (outgoingData.status === '1' && Array.isArray(outgoingData.result)) {
      for (const log of outgoingData.result) {
        if (seenTxHashes.has(log.transactionHash)) continue;
        seenTxHashes.add(log.transactionHash);

        const from = parseAddressFromTopic(log.topics[1]);
        const to = parseAddressFromTopic(log.topics[2]);

        transactions.push({
          txHash: log.transactionHash,
          type: getTransactionType(from, to),
          from,
          to,
          blockNumber: parseInt(log.blockNumber, 16),
          timestamp: parseInt(log.timeStamp, 16),
          tokenAddress: log.address,
          tokenSymbol: tokenInfo.symbol,
          amount: null, // Encrypted
        });
      }
    }

    // Process incoming transfers
    if (incomingData.status === '1' && Array.isArray(incomingData.result)) {
      for (const log of incomingData.result) {
        if (seenTxHashes.has(log.transactionHash)) continue;
        seenTxHashes.add(log.transactionHash);

        const from = parseAddressFromTopic(log.topics[1]);
        const to = parseAddressFromTopic(log.topics[2]);

        transactions.push({
          txHash: log.transactionHash,
          type: getTransactionType(from, to),
          from,
          to,
          blockNumber: parseInt(log.blockNumber, 16),
          timestamp: parseInt(log.timeStamp, 16),
          tokenAddress: log.address,
          tokenSymbol: tokenInfo.symbol,
          amount: null, // Encrypted
        });
      }
    }
  }

  // Query ETH transfers
  const ethUrl = new URL(ETHERSCAN_V2_API);
  ethUrl.searchParams.set('chainid', config.chainIdNumber.toString());
  ethUrl.searchParams.set('module', 'account');
  ethUrl.searchParams.set('action', 'txlist');
  ethUrl.searchParams.set('address', walletAddress);
  ethUrl.searchParams.set('startblock', startBlock.toString());
  ethUrl.searchParams.set('endblock', '99999999');
  ethUrl.searchParams.set('sort', 'desc');
  ethUrl.searchParams.set('apikey', apiKey);

  const ethRes = await fetch(ethUrl.toString(), {
    signal: AbortSignal.timeout(ETHERSCAN_TIMEOUT_MS),
  });
  const ethData = (await ethRes.json()) as EtherscanTxResponse;

  if (ethData.status === '1' && Array.isArray(ethData.result)) {
    for (const tx of ethData.result) {
      // Only include transactions with ETH value (not contract calls with 0 value)
      if (tx.value === '0') continue;
      if (seenTxHashes.has(tx.hash)) continue;
      seenTxHashes.add(tx.hash);

      transactions.push({
        txHash: tx.hash,
        type: 'eth',
        from: tx.from,
        to: tx.to,
        blockNumber: parseInt(tx.blockNumber, 10),
        timestamp: parseInt(tx.timeStamp, 10),
        tokenAddress: '', // Native ETH
        tokenSymbol: 'ETH',
        amount: formatWeiToEth(tx.value),
      });
    }
  }

  return transactions;
}

/**
 * Get transactions via RPC (eth_getLogs) - no API key required
 * Slower than Etherscan but works without configuration
 */
export async function getWalletTransactionsViaRPC(
  walletAddress: string,
  tokenAddresses: string[],
  tokenMap: Map<string, { symbol: string }>,
  network: NetworkName,
  startBlock: number = 0,
): Promise<WalletTransaction[]> {
  try {
    return await scanTransferLogs(walletAddress, tokenAddresses, tokenMap, network, startBlock);
  } catch (err) {
    // A malformed eth_getLogs reply surfaces as a TypeError deep inside ethers
    // ("params.map is not a function"). Say what happened instead.
    if (err instanceof TypeError && !/fetch failed/i.test(err.message)) {
      throw new WalletTxError(
        'RPC_BAD_ANSWER',
        'The RPC endpoint sent an answer the wallet could not read.',
        'Its reply to the transaction-history query did not have the expected shape.',
        'Try again, or set an Etherscan API key or another RPC URL with fhevm-wallet config.',
        err.message,
      );
    }
    throw err;
  }
}

/** The eth_getLogs scan behind `getWalletTransactionsViaRPC`. */
async function scanTransferLogs(
  walletAddress: string,
  tokenAddresses: string[],
  tokenMap: Map<string, { symbol: string }>,
  network: NetworkName,
  startBlock: number,
): Promise<WalletTransaction[]> {
  const provider = getProvider(network);
  const currentBlock = await provider.getBlockNumber();

  const transactions: WalletTransaction[] = [];
  const seenTxHashes = new Set<string>();

  // Pad wallet address to 32 bytes for topic matching
  const paddedWallet = '0x' + walletAddress.slice(2).toLowerCase().padStart(64, '0');

  // Process in chunks of 10,000 blocks to avoid RPC limits
  const CHUNK_SIZE = 10000;

  for (const tokenAddress of tokenAddresses) {
    const tokenInfo = tokenMap.get(tokenAddress.toLowerCase());
    if (!tokenInfo) continue;

    // Query in chunks
    for (let fromBlock = startBlock; fromBlock <= currentBlock; fromBlock += CHUNK_SIZE) {
      const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, currentBlock);

      // Query outgoing transfers (wallet is sender - topic1)
      const outgoingFilter = {
        address: tokenAddress,
        topics: [CONFIDENTIAL_TRANSFER_TOPIC, paddedWallet, null],
        fromBlock,
        toBlock,
      };

      // Query incoming transfers (wallet is recipient - topic2)
      const incomingFilter = {
        address: tokenAddress,
        topics: [CONFIDENTIAL_TRANSFER_TOPIC, null, paddedWallet],
        fromBlock,
        toBlock,
      };

      const [outgoingLogs, incomingLogs] = await Promise.all([
        provider.getLogs(outgoingFilter),
        provider.getLogs(incomingFilter),
      ]);

      const allLogs = [...outgoingLogs, ...incomingLogs];

      // Collect unique block numbers for timestamp fetching
      const blockNumbers = new Set<number>();
      for (const log of allLogs) {
        if (!seenTxHashes.has(log.transactionHash)) {
          blockNumbers.add(log.blockNumber);
        }
      }

      // Batch fetch block timestamps
      const blockTimestamps = new Map<number, number>();
      const blockPromises = Array.from(blockNumbers).map(async (blockNum) => {
        const block = await provider.getBlock(blockNum);
        if (block) {
          blockTimestamps.set(blockNum, block.timestamp);
        }
      });
      await Promise.all(blockPromises);

      // Process logs
      for (const log of allLogs) {
        if (seenTxHashes.has(log.transactionHash)) continue;
        seenTxHashes.add(log.transactionHash);

        const from = parseAddressFromTopic(log.topics[1]);
        const to = parseAddressFromTopic(log.topics[2]);
        const timestamp = blockTimestamps.get(log.blockNumber) || 0;

        transactions.push({
          txHash: log.transactionHash,
          type: getTransactionType(from, to),
          from,
          to,
          blockNumber: log.blockNumber,
          timestamp,
          tokenAddress: log.address,
          tokenSymbol: tokenInfo.symbol,
          amount: null, // Encrypted
        });
      }
    }
  }

  // Sort by block number descending (newest first)
  transactions.sort((a, b) => b.blockNumber - a.blockNumber);

  return transactions;
}

/**
 * Allow `operator` to move this wallet's tokens until `untilUnixSeconds`.
 * ERC-7984 has no `approve`; operators replace allowances. Pass 0 to revoke.
 */
export async function setOperator(
  wallet: Wallet | HDNodeWallet,
  tokenAddress: string,
  operator: string,
  untilUnixSeconds: number,
  network: NetworkName,
): Promise<TransferResult> {
  // uint48 holds timestamps far beyond any realistic expiry; reject nonsense early.
  if (!Number.isInteger(untilUnixSeconds) || untilUnixSeconds < 0 || untilUnixSeconds >= 2 ** 48) {
    throw new Error('Operator expiry must be a unix timestamp in seconds');
  }
  try {
    const provider = getProvider(network);
    const connectedWallet = wallet.connect(provider);
    const contract = getTokenContract(tokenAddress, network, connectedWallet);
    const fn = contract.getFunction('setOperator(address,uint48)');
    // Simulate first so a revert is reported before anything is signed.
    const estimate = await fn.estimateGas(operator, untilUnixSeconds);
    const gasLimit = (estimate * (100n + GAS_BUFFER_PERCENT)) / 100n;
    // Same sign-locally-then-broadcast flow as transfers, so a timed-out broadcast still
    // reports the hash instead of "could not reach the network, try again".
    const result = await signAndBroadcast({
      signer: connectedWallet,
      provider,
      build: () => fn.populateTransaction(operator, untilUnixSeconds, { gasLimit }),
      network,
      action: 'operator change',
    });
    bestEffort(() =>
      logEvent('OPERATOR_SET', {
        token: tokenAddress,
        operator,
        until: String(untilUnixSeconds),
        network,
        txHash: result.txHash,
      }),
    );
    return result;
  } catch (err) {
    throw translateTxError(err, { iface: ERC7984_INTERFACE, action: 'operator change' });
  }
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
