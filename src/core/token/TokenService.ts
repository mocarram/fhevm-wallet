/**
 * ERC-7984 token interactions
 */

import { Contract, Wallet, HDNodeWallet, TransactionReceipt, Signer } from 'ethers';
import { getProvider, NetworkName, getNetworkConfig } from '../network/index.js';
import { encryptAmount, EncryptedAmount } from '../fhe/EncryptionService.js';
import { decryptBalance } from '../fhe/DecryptionService.js';
import { CHAIN_IDS } from '../network/NetworkConfig.js';
import { logEvent } from '../../storage/AuditLog.js';
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
export async function getTokenInfo(
  tokenAddress: string,
  network: NetworkName,
): Promise<TokenInfo> {
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
  const encryptedHandle = await getEncryptedBalance(
    tokenAddress,
    wallet.address,
    network,
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
  const encrypted = await encryptAmount(
    chainId,
    tokenAddress,
    wallet.address,
    amount,
  );

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
  const encrypted = await encryptAmount(
    chainId,
    tokenAddress,
    wallet.address,
    amount,
  );

  // Get contract with signer
  const provider = getProvider(network);
  const connectedWallet = wallet.connect(provider);
  const contract = getTokenContract(tokenAddress, network, connectedWallet);

  // Execute approval
  const tx = await contract.approve(
    spenderAddress,
    encrypted.handleHex,
    encrypted.inputProofHex,
  );

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
