import { vi } from 'vitest';

export interface MockFhevmInstance {
  createEncryptedInput: ReturnType<typeof vi.fn>;
  generateKeypair: ReturnType<typeof vi.fn>;
  createEIP712: ReturnType<typeof vi.fn>;
  userDecrypt: ReturnType<typeof vi.fn>;
}

export function makeMockFhevmInstance(
  overrides: Partial<MockFhevmInstance> = {},
): MockFhevmInstance {
  const handle = new Uint8Array([1, 2, 3, 4]);
  const inputProof = new Uint8Array([5, 6, 7, 8]);

  const createEncryptedInput = vi.fn().mockReturnValue({
    add64: vi.fn().mockReturnThis(),
    encrypt: vi.fn().mockResolvedValue({
      handles: [handle],
      inputProof,
    }),
  });

  return {
    createEncryptedInput,
    generateKeypair: vi.fn().mockReturnValue({
      publicKey: '0xpub',
      privateKey: '0xpriv',
    }),
    createEIP712: vi.fn().mockReturnValue({
      domain: {},
      types: {},
      message: {},
    }),
    userDecrypt: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}
