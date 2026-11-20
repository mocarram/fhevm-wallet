/**
 * Wallet CRUD operations
 */

import { resolve as resolvePath } from 'path';
import { Wallet, HDNodeWallet } from 'ethers';
import { writeNewPrivateFile } from '../../storage/secureFs.js';
import { isValidWalletName } from '../../utils/validation.js';
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
export async function createWallet(name: string, password: string): Promise<CreateWalletResult> {
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
  const wallet = wallets.find((w) => w.name === name);
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
export async function exportWalletPrivateKey(name: string, password: string): Promise<string> {
  const wallet = await loadWallet(name, password);
  logEvent('WALLET_EXPORTED', { name });
  return wallet.privateKey;
}

/**
 * Copy a wallet's encrypted keystore (standard Ethereum JSON keystore, still protected by
 * the wallet password) to `destPath` with owner-only permissions. Safer than exporting the
 * raw private key: the file is useless without the password.
 *
 * Refuses to overwrite anything already at `destPath`, and leaves the permissions of the
 * folder it lands in alone (that folder belongs to the user, not to the wallet).
 */
export function exportKeystoreFile(name: string, destPath: string): string {
  if (!isValidWalletName(name)) throw new Error(`"${name}" is not a valid wallet name`);
  const target = resolvePath(destPath);
  const keystore = loadWalletKeystore(name);
  try {
    writeNewPrivateFile(target, keystore);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error(`${target} already exists; choose another file name`);
    if (code === 'ENOENT') throw new Error(`The folder for ${target} does not exist`);
    throw err;
  }
  logEvent('WALLET_EXPORTED', { name, format: 'keystore' });
  return target;
}
