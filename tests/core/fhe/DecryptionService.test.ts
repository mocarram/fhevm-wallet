import { Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { CHAIN_IDS } from '../../../src/core/network/NetworkConfig.js';
import { makeMockFhevmInstance } from '../../helpers/mockFhe.js';

const mockInstance = makeMockFhevmInstance({
  generateKeypair: vi.fn().mockReturnValue({
    publicKey: '0xpublicKey',
    privateKey: '0xprivateKey',
  }),
  createEIP712: vi.fn().mockReturnValue({
    domain: { name: 'Authorization', version: '1', chainId: 11155111, verifyingContract: '0x0' },
    types: {
      EIP712Domain: [],
      Reencrypt: [
        { name: 'publicKey', type: 'bytes32' },
        { name: 'contractAddresses', type: 'address[]' },
      ],
    },
    message: {
      publicKey: '0xpublicKey',
      contractAddresses: ['0xtoken'],
    },
  }),
  userDecrypt: vi.fn(),
});

vi.mock('../../../src/core/fhe/FheService.js', () => ({
  getFheInstance: vi.fn(async () => mockInstance),
}));

const TOKEN = '0xde709f2102306220921060314715629080e2fb77';
// Deterministic test wallet (well-known mnemonic).
const TEST_WALLET = Wallet.fromPhrase(
  'test test test test test test test test test test test junk',
);

describe('DecryptionService.generateKeypair', () => {
  it('returns the FHE instance keypair', async () => {
    const { generateKeypair } = await import('../../../src/core/fhe/DecryptionService.js');
    const kp = await generateKeypair(CHAIN_IDS.SEPOLIA);
    expect(kp).toEqual({ publicKey: '0xpublicKey', privateKey: '0xprivateKey' });
  });
});

describe('DecryptionService.createReencryptionSignature', () => {
  it('strips EIP712Domain from types and produces a signature', async () => {
    const { createReencryptionSignature } =
      await import('../../../src/core/fhe/DecryptionService.js');
    const signTypedData = vi.spyOn(TEST_WALLET, 'signTypedData').mockResolvedValue('0xdeadbeef');

    const sig = await createReencryptionSignature(
      TEST_WALLET,
      [TOKEN],
      '0xpublicKey',
      CHAIN_IDS.SEPOLIA,
    );
    expect(sig).toBe('0xdeadbeef');

    const [, types] = signTypedData.mock.calls[0];
    expect(types).not.toHaveProperty('EIP712Domain');
    expect(types).toHaveProperty('Reencrypt');
    signTypedData.mockRestore();
  });
});

describe('DecryptionService.decryptBalance', () => {
  it('returns bigint result from userDecrypt', async () => {
    vi.spyOn(TEST_WALLET, 'signTypedData').mockResolvedValue('0xsig');
    const handle = 0x1234n;
    const handleHex = '0x' + handle.toString(16).padStart(64, '0');
    mockInstance.userDecrypt.mockResolvedValueOnce({ [handleHex]: 1234n });

    const { decryptBalance } = await import('../../../src/core/fhe/DecryptionService.js');
    const result = await decryptBalance(handle, TOKEN, TEST_WALLET, 'sepolia');
    expect(result).toBe(1234n);
  });

  it('coerces string results into bigint', async () => {
    vi.spyOn(TEST_WALLET, 'signTypedData').mockResolvedValue('0xsig');
    const handle = 0x5n;
    const handleHex = '0x' + handle.toString(16).padStart(64, '0');
    mockInstance.userDecrypt.mockResolvedValueOnce({ [handleHex]: '42' });

    const { decryptBalance } = await import('../../../src/core/fhe/DecryptionService.js');
    expect(await decryptBalance(handle, TOKEN, TEST_WALLET, 'sepolia')).toBe(42n);
  });

  it('throws when no result is returned for the handle', async () => {
    vi.spyOn(TEST_WALLET, 'signTypedData').mockResolvedValue('0xsig');
    mockInstance.userDecrypt.mockResolvedValueOnce({});

    const { decryptBalance } = await import('../../../src/core/fhe/DecryptionService.js');
    await expect(decryptBalance(1n, TOKEN, TEST_WALLET, 'sepolia')).rejects.toThrow(
      /Decryption failed/,
    );
  });
});

describe('DecryptionService.prepareReencryption', () => {
  it('packages keypair, signature, contracts, and user address', async () => {
    vi.spyOn(TEST_WALLET, 'signTypedData').mockResolvedValue('0xsig2');
    const { prepareReencryption } = await import('../../../src/core/fhe/DecryptionService.js');

    const params = await prepareReencryption([TOKEN], TEST_WALLET, 'sepolia');
    expect(params.publicKey).toBe('0xpublicKey');
    expect(params.privateKey).toBe('0xprivateKey');
    expect(params.signature).toBe('0xsig2');
    expect(params.contractAddresses).toEqual([TOKEN]);
    expect(params.userAddress).toBe(TEST_WALLET.address);
  });
});
