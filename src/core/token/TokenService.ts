/**
 * ERC-7984 token interactions
 */

import { Contract, Interface, Wallet, HDNodeWallet, TransactionReceipt, Signer } from 'ethers';
import { sentButUnconfirmed, translateTxError, WalletTxError } from './txErrors.js';
import { getProvider, NetworkName, getNetworkConfig } from '../network/index.js';
import { encryptAmount } from '../fhe/EncryptionService.js';
import { decryptBalance } from '../fhe/DecryptionService.js';
import { CHAIN_IDS } from '../network/NetworkConfig.js';
import { logEvent } from '../../storage/AuditLog.js';
import { recordLocalTransaction } from '../../storage/TransactionStore.js';
import { getCachedBalance, setCachedBalance, invalidateBalance } from './BalanceCache.js';

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

/** Largest value an euint64 can hold. Amounts are in the token's base units. */
export const MAX_EUINT64 = 2n ** 64n - 1n;

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
}

export interface GetBalanceOptions {
  forceRefresh?: boolean;
}

/**
 * Get token contract instance
 */
function getTokenContract(tokenAddress: string, network: NetworkName, signer?: Signer): Contract {
  const provider = getProvider(network);
  return new Contract(tokenAddress, ERC7984_ABI, signer ?? provider);
}

/**
 * Get token information (name, symbol, decimals)
 */
export async function getTokenInfo(tokenAddress: string, network: NetworkName): Promise<TokenInfo> {
  const contract = getTokenContract(tokenAddress, network);

  const [name, symbol, decimals] = await Promise.all([
    contract.name(),
    contract.symbol(),
    contract.decimals(),
  ]);

  return {
    address: tokenAddress,
    name,
    symbol,
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
): Promise<bigint> {
  const contract = getTokenContract(tokenAddress, network);
  // The ABI returns bytes32 (a 0x-hex string). Convert once here so the rest of the
  // wallet (zero check, cache key, decryption) works with a single bigint representation.
  const handle: string | bigint = await contract.confidentialBalanceOf(userAddress);
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
  const { forceRefresh = false } = options;

  // Always fetch the encrypted handle first (cheap RPC call)
  const encryptedHandle = await getEncryptedBalance(tokenAddress, wallet.address, network);

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
  const balance = await decryptBalance(encryptedHandle, tokenAddress, wallet, network);

  // Cache with the current handle
  setCachedBalance(wallet.address, tokenAddress, network, encryptedHandle, balance);

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
    // The encrypted input is bound to (token, sender): the sender must be msg.sender.
    const encrypted = await encryptAmount(chainId, tokenAddress, wallet.address, amount);

    const provider = getProvider(network);
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
    if (!pricePerGas) {
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
      // Phase 1: sign and broadcast. Failures here mean nothing was sent.
      let tx;
      try {
        tx = await transfer(...args, { gasLimit });
      } catch (err) {
        throw translateTxError(err, { iface: ERC7984_INTERFACE });
      }

      // From here on the transaction exists on the network. Record it immediately so the
      // hash is never lost, even if waiting for the receipt fails.
      logEvent('TRANSFER_SENT', { token: tokenAddress, to: toAddress, txHash: tx.hash, network });

      // Phase 2: wait for one confirmation. A failure here must NOT read as "try again":
      // the transfer may still confirm, and resending could pay twice.
      let receipt: TransactionReceipt | null;
      try {
        // ethers v6 wait() throws CALL_EXCEPTION (action "sendTransaction") on a status-0
        // receipt; sentButUnconfirmed keeps that as TX_REVERTED.
        receipt = await tx.wait();
      } catch (err) {
        throw sentButUnconfirmed(err, tx.hash, getTxExplorerUrl(tx.hash, network), {
          iface: ERC7984_INTERFACE,
        });
      }
      if (!receipt) {
        // Only possible with confirmations=0, which we never request.
        throw sentButUnconfirmed(
          new Error('No receipt returned'),
          tx.hash,
          getTxExplorerUrl(tx.hash, network),
        );
      }

      // The encrypted handle changed; drop the cached plaintext balance.
      invalidateBalance(wallet.address, tokenAddress, network);
      // The amount is deliberately not logged: the audit log should not undo the
      // confidentiality the token provides.
      logEvent('TRANSFER', { token: tokenAddress, to: toAddress, txHash: tx.hash, network });
      return { txHash: tx.hash, receipt };
    };

    return { gasLimit, feeWei, ethBalanceWei, send };
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
      fetch(outgoingUrl.toString()),
      fetch(incomingUrl.toString()),
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

  const ethRes = await fetch(ethUrl.toString());
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
    const contract = getTokenContract(tokenAddress, network, wallet.connect(provider));
    // Simulate first so a revert is reported before anything is signed.
    await contract.setOperator.estimateGas(operator, untilUnixSeconds);
    const tx = await contract.setOperator(operator, untilUnixSeconds);
    const receipt = await tx.wait();
    logEvent('OPERATOR_SET', {
      token: tokenAddress,
      operator,
      until: String(untilUnixSeconds),
      network,
    });
    return { txHash: tx.hash, receipt };
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
