/**
 * ERC-7984 token interactions
 */

import { Contract, Wallet, HDNodeWallet, TransactionReceipt, Signer } from 'ethers';
import { getProvider, NetworkName, getNetworkConfig } from '../network/index.js';
import { encryptAmount } from '../fhe/EncryptionService.js';
import { decryptBalance } from '../fhe/DecryptionService.js';
import { CHAIN_IDS } from '../network/NetworkConfig.js';
import { logEvent } from '../../storage/AuditLog.js';
import { recordLocalTransaction } from '../../storage/TransactionStore.js';
import { getCachedBalance, setCachedBalance, invalidateBalance } from './BalanceCache.js';

// ERC-7984 ABI (minimal interface)
const ERC7984_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function confidentialTotalSupply() view returns (uint256)',
  'function confidentialBalanceOf(address account) view returns (uint256)',
  'function $_transfer(address from, address to, bytes32 encryptedAmount, bytes inputProof) returns (uint256)',
  'function $_mint(address to, bytes32 encryptedAmount, bytes inputProof) returns (uint256)',
  'function $_burn(address from, bytes32 encryptedAmount, bytes inputProof) returns (uint256)',
  'event Transfer(address indexed from, address indexed to)',
];

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
  const balance = await contract.confidentialBalanceOf(userAddress);
  return balance;
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

/**
 * Transfer tokens confidentially
 */
export async function confidentialTransfer(
  wallet: Wallet | HDNodeWallet,
  tokenAddress: string,
  toAddress: string,
  amount: bigint,
  network: NetworkName,
): Promise<TransferResult> {
  const chainId = network === 'mainnet' ? CHAIN_IDS.MAINNET : CHAIN_IDS.SEPOLIA;

  // Encrypt the amount
  const encrypted = await encryptAmount(chainId, tokenAddress, wallet.address, amount);

  // Get contract with signer
  const provider = getProvider(network);
  const connectedWallet = wallet.connect(provider);
  const contract = getTokenContract(tokenAddress, network, connectedWallet);

  // Execute transfer (ERC-7984 uses $_transfer with from address)
  const tx = await contract.$_transfer(
    wallet.address,
    toAddress,
    encrypted.handleHex,
    encrypted.inputProofHex,
  );

  const receipt = await tx.wait();

  // Invalidate sender's cached balance after successful transfer
  invalidateBalance(wallet.address, tokenAddress, network);

  logEvent('TRANSFER', {
    token: tokenAddress,
    to: toAddress,
    amount: amount.toString(),
    txHash: tx.hash,
    network,
  });

  return {
    txHash: tx.hash,
    receipt,
  };
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
 * Approve tokens confidentially
 */
export async function confidentialApprove(
  wallet: Wallet | HDNodeWallet,
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint,
  network: NetworkName,
): Promise<TransferResult> {
  const chainId = network === 'mainnet' ? CHAIN_IDS.MAINNET : CHAIN_IDS.SEPOLIA;

  // Encrypt the amount
  const encrypted = await encryptAmount(chainId, tokenAddress, wallet.address, amount);

  // Get contract with signer
  const provider = getProvider(network);
  const connectedWallet = wallet.connect(provider);
  const contract = getTokenContract(tokenAddress, network, connectedWallet);

  // Execute approval
  const tx = await contract.approve(spenderAddress, encrypted.handleHex, encrypted.inputProofHex);

  const receipt = await tx.wait();

  return {
    txHash: tx.hash,
    receipt,
  };
}

/**
 * Get transaction explorer URL
 */
export function getTxExplorerUrl(txHash: string, network: NetworkName): string {
  const config = getNetworkConfig(network);
  return `${config.explorerUrl}/tx/${txHash}`;
}
