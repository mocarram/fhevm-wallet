/**
 * Wallet storage (encrypted keystores)
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { ensureSecureDir, writeSecureFile } from './secureFs.js';
import { join } from 'path';
import { DATA_DIR } from './paths.js';

const WALLETS_DIR = join(DATA_DIR, 'wallets');

export interface WalletMetadata {
  name: string;
  address: string;
  createdAt: string;
}

/**
 * Ensure wallets directory exists
 */
function ensureWalletsDir(): void {
  // Keystores are encrypted, but the folder still shouldn't be listable by other users.
  ensureSecureDir(WALLETS_DIR);
}

/**
 * Get path for a wallet keystore file
 */
function getWalletPath(name: string): string {
  assertSafeWalletName(name);
  return join(WALLETS_DIR, `${name}.json`);
}

/**
 * Wallet names become file names. Refuse anything that could leave the wallets folder
 * (`../tokens` would otherwise read tokens.json as a "keystore"). Kept looser than
 * isValidWalletName so wallets saved by older versions still load.
 */
function assertSafeWalletName(name: string): void {
  if (!name || name === '.' || name.includes('..') || /[/\\\0]/.test(name)) {
    throw new Error(`"${name}" is not a valid wallet name`);
  }
}

/**
 * Get path for wallet metadata file
 */
function getMetadataPath(name: string): string {
  assertSafeWalletName(name);
  return join(WALLETS_DIR, `${name}.meta.json`);
}

/**
 * Check if a wallet exists
 */
export function walletExists(name: string): boolean {
  ensureWalletsDir();
  let path: string;
  try {
    path = getWalletPath(name);
  } catch {
    return false; // an unsafe name never names an existing wallet
  }
  return existsSync(path);
}

/**
 * Save wallet keystore
 */
export function saveWalletKeystore(name: string, keystore: string, address: string): void {
  ensureWalletsDir();
  writeSecureFile(getWalletPath(name), keystore);

  const metadata: WalletMetadata = {
    name,
    address,
    createdAt: new Date().toISOString(),
  };
  writeSecureFile(getMetadataPath(name), JSON.stringify(metadata, null, 2));
}

/**
 * Load wallet keystore
 */
export function loadWalletKeystore(name: string): string {
  if (!walletExists(name)) {
    throw new Error(`Wallet "${name}" not found`);
  }
  return readFileSync(getWalletPath(name), 'utf-8');
}

/**
 * Load wallet metadata
 */
export function loadWalletMetadata(name: string): WalletMetadata | null {
  const metaPath = getMetadataPath(name);
  if (!existsSync(metaPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * List all wallets
 */
export function listWallets(): WalletMetadata[] {
  ensureWalletsDir();
  const files = readdirSync(WALLETS_DIR).filter((f) => f.endsWith('.meta.json'));

  return files.map((file) => {
    const name = file.replace('.meta.json', '');
    const metadata = loadWalletMetadata(name);
    if (metadata) {
      return metadata;
    }
    // Fallback if metadata is corrupted
    return {
      name,
      address: 'Unknown',
      createdAt: 'Unknown',
    };
  });
}

/**
 * Remove a wallet
 */
export function removeWallet(name: string): boolean {
  if (!walletExists(name)) {
    return false;
  }

  const walletPath = getWalletPath(name);
  const metaPath = getMetadataPath(name);

  if (existsSync(walletPath)) {
    unlinkSync(walletPath);
  }
  if (existsSync(metaPath)) {
    unlinkSync(metaPath);
  }

  return true;
}
