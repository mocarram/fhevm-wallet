/**
 * Wallet CRUD operations
 */

import { Wallet, HDNodeWallet } from 'ethers';
import {
  createNewWallet,
  importFromMnemonic,
  importFromPrivateKey,
  decryptKeystore,
} from './KeyStore.js';
import {
  walletExists,
  saveWalletKeystore,
  loadWalletKeystore,
  listWallets as listStoredWallets,
  removeWallet as removeStoredWallet,
  WalletMetadata,
} from '../../storage/WalletStore.js';
import { logEvent } from '../../storage/AuditLog.js';
import { getProvider, NetworkName } from '../network/index.js';

export interface CreateWalletResult {
  address: string;
  mnemonic: string;
}

export interface WalletInfo extends WalletMetadata {
  balance?: string;
}

/**
 * Create a new wallet
 */
export async function createWallet(
  name: string,
  password: string,
): Promise<CreateWalletResult> {
  if (walletExists(name)) {
    throw new Error(`Wallet "${name}" already exists`);
  }

  const result = await createNewWallet(password);
  saveWalletKeystore(name, result.keystore, result.address);

  logEvent('WALLET_CREATED', { name, address: result.address });

  return {
    address: result.address,
    mnemonic: result.mnemonic!,
  };
}

/**
 * Import wallet from mnemonic
 */
export async function importWalletFromMnemonic(
  name: string,
  mnemonic: string,
  password: string,
): Promise<string> {
  if (walletExists(name)) {
    throw new Error(`Wallet "${name}" already exists`);
  }

  const result = await importFromMnemonic(mnemonic, password);
  saveWalletKeystore(name, result.keystore, result.address);

  logEvent('WALLET_IMPORTED', { name, address: result.address });

  return result.address;
}

/**
 * Import wallet from private key
 */
export async function importWalletFromPrivateKey(
  name: string,
  privateKey: string,
  password: string,
): Promise<string> {
  if (walletExists(name)) {
    throw new Error(`Wallet "${name}" already exists`);
  }

  const result = await importFromPrivateKey(privateKey, password);
  saveWalletKeystore(name, result.keystore, result.address);

  logEvent('WALLET_IMPORTED', { name, address: result.address });

  return result.address;
}

/**
 * Load and decrypt a wallet
 */
export async function loadWallet(
  name: string,
  password: string,
  network?: NetworkName,
): Promise<Wallet | HDNodeWallet> {
  const keystore = loadWalletKeystore(name);
  const wallet = await decryptKeystore(keystore, password);

  if (network) {
    const provider = getProvider(network);
    return wallet.connect(provider);
  }

  return wallet;
}

/**
 * List all wallets
 */
export function listWallets(): WalletInfo[] {
  return listStoredWallets();
}

/**
 * Remove a wallet
 */
export function removeWallet(name: string): boolean {
  const result = removeStoredWallet(name);
  if (result) {
    logEvent('WALLET_REMOVED', { name });
  }
  return result;
}

/**
 * Get wallet address without decrypting
 */
export function getWalletAddress(name: string): string | null {
  const wallets = listStoredWallets();
  const wallet = wallets.find(w => w.name === name);
  return wallet?.address ?? null;
}

/**
 * Check if wallet exists
 */
export function hasWallet(name: string): boolean {
  return walletExists(name);
}

/**
 * Export wallet private key
 */
export async function exportWalletPrivateKey(
  name: string,
  password: string,
): Promise<string> {
  const wallet = await loadWallet(name, password);
  logEvent('WALLET_EXPORTED', { name });
  return wallet.privateKey;
}
