/**
 * Validation utilities
 */

import { isAddress, Mnemonic } from 'ethers';

/**
 * Validate an Ethereum address
 */
export function isValidAddress(address: string): boolean {
  return isAddress(address);
}

/**
 * Validate a mnemonic phrase
 */
export function isValidMnemonic(mnemonic: string): boolean {
  return Mnemonic.isValidMnemonic(mnemonic);
}

/**
 * Validate a private key
 */
export function isValidPrivateKey(key: string): boolean {
  // Remove 0x prefix if present
  const cleaned = key.startsWith('0x') ? key.slice(2) : key;

  // Check if it's a valid 64-character hex string
  if (cleaned.length !== 64) {
    return false;
  }

  return /^[0-9a-fA-F]+$/.test(cleaned);
}

/**
 * Validate a wallet name
 */
export function isValidWalletName(name: string): boolean {
  // Allow alphanumeric, hyphens, and underscores, 1-32 characters
  return /^[a-zA-Z0-9_-]{1,32}$/.test(name);
}

/**
 * Validate a token amount
 */
export function isValidAmount(amount: string): boolean {
  // Allow positive numbers with optional decimal point
  return /^\d+(\.\d+)?$/.test(amount) && parseFloat(amount) > 0;
}

/**
 * Validate network name
 */
export function isValidNetwork(network: string): network is 'mainnet' | 'sepolia' {
  return network === 'mainnet' || network === 'sepolia';
}
