/**
 * Encrypted keystore management using ethers
 */

import { Wallet, Mnemonic, HDNodeWallet } from 'ethers';

export interface KeystoreResult {
  keystore: string;
  address: string;
  mnemonic?: string;
}

/**
 * Create a new wallet with a random mnemonic
 */
export async function createNewWallet(password: string): Promise<KeystoreResult> {
  // Generate a random wallet with mnemonic
  const wallet = Wallet.createRandom();
  const mnemonic = wallet.mnemonic?.phrase;

  if (!mnemonic) {
    throw new Error('Failed to generate mnemonic');
  }

  // Encrypt to keystore
  const keystore = await wallet.encrypt(password);

  return {
    keystore,
    address: wallet.address,
    mnemonic,
  };
}

/**
 * Import wallet from mnemonic phrase
 */
export async function importFromMnemonic(
  mnemonic: string,
  password: string,
): Promise<KeystoreResult> {
  // Validate mnemonic
  if (!Mnemonic.isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }

  const wallet = Wallet.fromPhrase(mnemonic);
  const keystore = await wallet.encrypt(password);

  return {
    keystore,
    address: wallet.address,
    mnemonic,
  };
}

/**
 * Import wallet from private key
 */
export async function importFromPrivateKey(
  privateKey: string,
  password: string,
): Promise<KeystoreResult> {
  // Normalize private key (add 0x prefix if missing)
  const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

  const wallet = new Wallet(normalizedKey);
  const keystore = await wallet.encrypt(password);

  return {
    keystore,
    address: wallet.address,
  };
}

/**
 * Decrypt keystore to get wallet
 */
export async function decryptKeystore(
  keystore: string,
  password: string,
): Promise<Wallet | HDNodeWallet> {
  try {
    return await Wallet.fromEncryptedJson(keystore, password);
  } catch (error) {
    if (error instanceof Error && /(?:in)?correct password|invalid password/i.test(error.message)) {
      throw new Error('Invalid password');
    }
    throw error;
  }
}
