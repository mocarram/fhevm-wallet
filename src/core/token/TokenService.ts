/**
 * ERC-7984 token interactions
 */

import { Contract, Wallet, HDNodeWallet, TransactionReceipt, Signer } from 'ethers';
import { getProvider, NetworkName, getNetworkConfig } from '../network/index.js';
import { encryptAmount, EncryptedAmount } from '../fhe/EncryptionService.js';
import { decryptBalance } from '../fhe/DecryptionService.js';
import { CHAIN_IDS } from '../network/NetworkConfig.js';
import { logEvent } from '../../storage/AuditLog.js';

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
 * This performs the full reencryption flow
 */
export async function getDecryptedBalance(
  tokenAddress: string,
  wallet: Wallet | HDNodeWallet,
  network: NetworkName,
): Promise<bigint> {
  // Get the encrypted balance handle
  const encryptedHandle = await getEncryptedBalance(
    tokenAddress,
    wallet.address,
    network,
  );

  // If balance is zero, return immediately
  if (encryptedHandle === 0n) {
    return 0n;
  }

  // Decrypt the balance
  return decryptBalance(encryptedHandle, tokenAddress, wallet, network);
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
