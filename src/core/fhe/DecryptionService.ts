/**
 * FHE decryption service for reencrypting and decrypting balances
 */

import { Wallet, HDNodeWallet } from 'ethers';
import { getFheInstance } from './FheService.js';
import { FHE_OPERATION_TIMEOUT_MS } from './timeouts.js';
import { CHAIN_IDS, NetworkName } from '../network/NetworkConfig.js';
import { quietSdk } from './sdkConsole.js';
import type { DecryptAuth, DecryptAuthority, HandlePair } from './DecryptSession.js';

export interface ReencryptionParams {
  publicKey: string;
  privateKey: string;
  signature: string;
  contractAddresses: string[];
  userAddress: string;
}

/**
 * Generate a keypair for reencryption
 * Returns hex strings (without 0x prefix)
 */
export async function generateKeypair(
  chainId: bigint,
): Promise<{ publicKey: string; privateKey: string }> {
  const fheInstance = await getFheInstance(chainId);
  const keypair = fheInstance.generateKeypair();
  return {
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
  };
}

/**
 * Create EIP-712 signature for reencryption authorization
 */
export async function createReencryptionSignature(
  wallet: Wallet | HDNodeWallet,
  contractAddresses: string[],
  publicKey: string,
  chainId: bigint,
  durationDays: number = 1,
): Promise<string> {
  const fheInstance = await getFheInstance(chainId);

  // Get current timestamp
  const startTimestamp = Math.floor(Date.now() / 1000);

  // Get the EIP-712 typed data for reencryption
  const eip712Data = fheInstance.createEIP712(
    publicKey,
    contractAddresses,
    startTimestamp,
    durationDays,
  );

  // Sign using wallet's signTypedData
  // Need to remove EIP712Domain from types as ethers adds it automatically
  const { EIP712Domain: _EIP712Domain, ...types } = eip712Data.types as Record<string, unknown>;

  const signature = await wallet.signTypedData(
    eip712Data.domain as Record<string, unknown>,
    types as Record<string, Array<{ name: string; type: string }>>,
    eip712Data.message as Record<string, unknown>,
  );

  return signature;
}

/**
 * Decrypt an encrypted balance using user decrypt
 *
 * @param encryptedHandle - The encrypted balance handle from the contract
 * @param contractAddress - The token contract address
 * @param wallet - The user's wallet for signing
 * @param network - The network name
 * @returns The decrypted balance as bigint
 */
export async function decryptBalance(
  encryptedHandle: bigint,
  contractAddress: string,
  wallet: Wallet | HDNodeWallet,
  network: NetworkName,
): Promise<bigint> {
  const chainId = network === 'mainnet' ? CHAIN_IDS.MAINNET : CHAIN_IDS.SEPOLIA;
  const fheInstance = await getFheInstance(chainId);

  // Generate keypair for this decryption
  const { publicKey, privateKey } = fheInstance.generateKeypair();

  // Use current timestamp and 1 day duration
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;

  // Create authorization signature
  const signature = await createReencryptionSignature(
    wallet,
    [contractAddress],
    publicKey,
    chainId,
    durationDays,
  );

  // Format handle as hex string
  const handleHex = ('0x' + encryptedHandle.toString(16).padStart(64, '0')) as `0x${string}`;

  // Request user decrypt from the Gateway
  const results = await quietSdk(
    () =>
      fheInstance.userDecrypt(
        [{ handle: handleHex, contractAddress }],
        privateKey,
        publicKey,
        signature,
        [contractAddress],
        wallet.address,
        startTimestamp,
        durationDays,
      ),
    { ms: FHE_OPERATION_TIMEOUT_MS, what: 'Decrypting the balance' },
  );

  // The results are indexed by handle hex
  const decryptedValue = results[handleHex];
  if (decryptedValue === undefined) {
    throw new Error('Decryption failed: no result returned for handle');
  }

  // The result can be bigint, boolean, or hex string
  if (typeof decryptedValue === 'bigint') {
    return decryptedValue;
  } else if (typeof decryptedValue === 'string') {
    return BigInt(decryptedValue);
  } else {
    // Boolean - shouldn't happen for balance
    return decryptedValue ? 1n : 0n;
  }
}

/**
 * Prepare reencryption parameters without performing the reencryption
 * Useful for batch operations or when you need to manage the timing
 */
export async function prepareReencryption(
  contractAddresses: string[],
  wallet: Wallet | HDNodeWallet,
  network: NetworkName,
): Promise<ReencryptionParams> {
  const chainId = network === 'mainnet' ? CHAIN_IDS.MAINNET : CHAIN_IDS.SEPOLIA;
  const fheInstance = await getFheInstance(chainId);

  const { publicKey, privateKey } = fheInstance.generateKeypair();

  const signature = await createReencryptionSignature(
    wallet,
    contractAddresses,
    publicKey,
    chainId,
  );

  return {
    publicKey,
    privateKey,
    signature,
    contractAddresses,
    userAddress: wallet.address,
  };
}

/** Turn an SDK clear value into a bigint (euint → bigint, ebool → 0/1). */
function clearToBigint(v: bigint | boolean | string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  return BigInt(v);
}

/**
 * The relayer-backed authority behind `DecryptSession` on Sepolia and Mainnet: one
 * keypair + EIP-712 signature per group of contracts, and batched userDecrypt calls.
 */
export function relayerDecryptAuthority(network: NetworkName): DecryptAuthority {
  const chainId = network === 'mainnet' ? CHAIN_IDS.MAINNET : CHAIN_IDS.SEPOLIA;
  return {
    async authorize(signer, contracts, startTimestamp, durationDays) {
      const fhe = await getFheInstance(chainId);
      const { publicKey, privateKey } = fhe.generateKeypair();
      const eip712 = fhe.createEIP712(publicKey, contracts, startTimestamp, durationDays);
      // ethers adds EIP712Domain itself and refuses it in `types`.
      const { EIP712Domain: _domain, ...types } = eip712.types as Record<string, unknown>;
      const signature = await signer.signTypedData(
        eip712.domain as Record<string, unknown>,
        types as Record<string, Array<{ name: string; type: string }>>,
        eip712.message as Record<string, unknown>,
      );
      return {
        publicKey,
        privateKey,
        signature,
        contracts,
        userAddress: signer.address,
        startTimestamp,
        durationDays,
      };
    },
    async userDecrypt(auth: DecryptAuth, pairs: HandlePair[]) {
      const fhe = await getFheInstance(chainId);
      const results = await quietSdk(
        () =>
          fhe.userDecrypt(
            pairs.map((p) => ({ handle: p.handle, contractAddress: p.contractAddress })),
            auth.privateKey,
            auth.publicKey,
            auth.signature,
            auth.contracts,
            auth.userAddress,
            auth.startTimestamp,
            auth.durationDays,
          ),
        { ms: FHE_OPERATION_TIMEOUT_MS, what: 'Decrypting' },
      );
      const out: Record<string, bigint> = {};
      for (const [handle, v] of Object.entries(results)) {
        out[handle.toLowerCase()] = clearToBigint(v as bigint | boolean | string);
      }
      return out;
    },
  };
}

/** A public decryption with the KMS proof that `FHE.checkSignatures` verifies on-chain. */
export interface PublicDecryption {
  value: bigint;
  /** `decryptionProof` from the relayer: KMS signatures plus extra data. */
  proof: string;
}

/**
 * Publicly decrypt one handle through the relayer (it must have been made publicly
 * decryptable on-chain first, e.g. by `requestDiscloseEncryptedAmount`). The SDK checks
 * the ACL and the KMS signature threshold before returning.
 */
export async function publicDecryptHandle(
  handle: string,
  network: NetworkName,
): Promise<PublicDecryption> {
  const chainId = network === 'mainnet' ? CHAIN_IDS.MAINNET : CHAIN_IDS.SEPOLIA;
  const fhe = await getFheInstance(chainId);
  const res = await quietSdk(() => fhe.publicDecrypt([handle]), {
    ms: FHE_OPERATION_TIMEOUT_MS,
    what: 'Public decryption',
  });
  const entry = Object.entries(res.clearValues).find(
    ([h]) => h.toLowerCase() === handle.toLowerCase(),
  );
  if (!entry) throw new Error('Public decryption returned no value for this handle.');
  return {
    value: clearToBigint(entry[1] as bigint | boolean | string),
    proof: res.decryptionProof,
  };
}
