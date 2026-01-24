/**
 * Wallet storage (encrypted keystores)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
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
  if (!existsSync(WALLETS_DIR)) {
    mkdirSync(WALLETS_DIR, { recursive: true });
  }
}

/**
 * Get path for a wallet keystore file
 */
function getWalletPath(name: string): string {
  return join(WALLETS_DIR, `${name}.json`);
}

/**
 * Get path for wallet metadata file
 */
function getMetadataPath(name: string): string {
  return join(WALLETS_DIR, `${name}.meta.json`);
}

/**
 * Check if a wallet exists
 */
export function walletExists(name: string): boolean {
  ensureWalletsDir();
  return existsSync(getWalletPath(name));
}

/**
 * Save wallet keystore
 */
export function saveWalletKeystore(name: string, keystore: string, address: string): void {
  ensureWalletsDir();
  writeFileSync(getWalletPath(name), keystore);

  const metadata: WalletMetadata = {
    name,
    address,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(getMetadataPath(name), JSON.stringify(metadata, null, 2));
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
  const files = readdirSync(WALLETS_DIR).filter(f => f.endsWith('.meta.json'));

  return files.map(file => {
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
