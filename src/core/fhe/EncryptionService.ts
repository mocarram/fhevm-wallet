/**
 * FHE encryption service
 */

import { FhevmInstance } from '@zama-fhe/relayer-sdk/node';
import { getFheInstance } from './FheService.js';

export interface EncryptedAmount {
  handle: Uint8Array;
  handleHex: string;
  inputProof: Uint8Array;
  inputProofHex: string;
}

/**
 * Convert Uint8Array to hex string
 */
function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Encrypt an amount for a confidential token transfer
 *
 * @param chainId - The chain ID
 * @param contractAddress - The token contract address
 * @param userAddress - The sender's address
 * @param amount - The amount to encrypt (as bigint)
 * @returns Encrypted amount data with handle and proof
 */
export async function encryptAmount(
  chainId: bigint,
  contractAddress: string,
  userAddress: string,
  amount: bigint,
): Promise<EncryptedAmount> {
  const fheInstance = await getFheInstance(chainId);

  const encryptedInput = await fheInstance
    .createEncryptedInput(contractAddress, userAddress)
    .add64(amount)
    .encrypt();

  const handle = encryptedInput.handles[0];
  const inputProof = encryptedInput.inputProof;

  return {
    handle,
    handleHex: toHex(handle),
    inputProof,
    inputProofHex: toHex(inputProof),
  };
}

/**
 * Encrypt multiple amounts in a batch
 */
export async function encryptAmounts(
  chainId: bigint,
  contractAddress: string,
  userAddress: string,
  amounts: bigint[],
): Promise<EncryptedAmount[]> {
  const results: EncryptedAmount[] = [];

  for (const amount of amounts) {
    const encrypted = await encryptAmount(chainId, contractAddress, userAddress, amount);
    results.push(encrypted);
  }

  return results;
}
