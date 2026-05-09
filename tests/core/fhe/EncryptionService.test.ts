import { describe, expect, it, vi } from 'vitest';
import { CHAIN_IDS } from '../../../src/core/network/NetworkConfig.js';
import { makeMockFhevmInstance } from '../../helpers/mockFhe.js';

const mockInstance = makeMockFhevmInstance();

vi.mock('../../../src/core/fhe/FheService.js', () => ({
  getFheInstance: vi.fn(async () => mockInstance),
}));

const TOKEN = '0xde709f2102306220921060314715629080e2fb77';
const USER = '0x52908400098527886E0F7030069857D2E4169EE7';

describe('EncryptionService', () => {
  it('encryptAmount returns hex-encoded handle and proof', async () => {
    const { encryptAmount } = await import('../../../src/core/fhe/EncryptionService.js');
    const result = await encryptAmount(CHAIN_IDS.SEPOLIA, TOKEN, USER, 42n);

    expect(result.handleHex).toBe('0x01020304');
    expect(result.inputProofHex).toBe('0x05060708');
    expect(result.handle).toBeInstanceOf(Uint8Array);
    expect(mockInstance.createEncryptedInput).toHaveBeenCalledWith(TOKEN, USER);
  });

  it('encryptAmounts batches multiple values', async () => {
    const { encryptAmounts } = await import('../../../src/core/fhe/EncryptionService.js');
    const results = await encryptAmounts(CHAIN_IDS.SEPOLIA, TOKEN, USER, [1n, 2n, 3n]);
    expect(results).toHaveLength(3);
    results.forEach((r) => expect(r.handleHex).toBe('0x01020304'));
  });
});
