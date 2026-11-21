/**
 * Wallet storage (encrypted keystores)
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { ensureSecureDir, writeSecureFile } from './secureFs.js';
import { join } from 'path';
import { getAddress } from 'ethers';
import { assertTrustedDataDir, DATA_DIR } from './paths.js';

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
  // Checked again here, not only at startup: the TUI stays open for hours, and a folder
  // that became writable by others since then may now hold a planted keystore. Before
  // walletExists, whose ensureSecureDir would quietly re-tighten (and so hide) it.
  assertTrustedDataDir();
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
  let meta: Partial<WalletMetadata>;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Partial<WalletMetadata>;
  } catch {
    return null;
  }
  // The address shown (receive screen, QR code, lists) comes from the keystore, which is
  // what signs: a .meta.json that was edited or got out of step must not show an address
  // the key does not control.
  const fromKeystore = keystoreAddress(name);
  const address =
    fromKeystore ??
    (typeof meta.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(meta.address)
      ? meta.address
      : 'Unknown');
  return {
    name,
    address,
    createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : 'Unknown',
  };
}

/**
 * The address recorded inside the encrypted JSON keystore (the `address` field ethers
 * writes, unencrypted), checksummed, or null when there is none to read. Decrypting
 * would prove more, but needs the password; the field is what the key was saved with.
 */
export function keystoreAddress(name: string): string | null {
  try {
    const ks = JSON.parse(readFileSync(getWalletPath(name), 'utf-8')) as { address?: unknown };
    if (typeof ks.address !== 'string') return null;
    const hex = ks.address.replace(/^0x/i, '');
    return /^[0-9a-fA-F]{40}$/.test(hex) ? getAddress('0x' + hex) : null;
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
