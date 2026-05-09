import { vi } from 'vitest';

export interface MockContractCalls {
  name?: string;
  symbol?: string;
  decimals?: number | bigint;
  confidentialBalanceOf?: bigint;
}

export function makeMockContract(calls: MockContractCalls = {}) {
  return {
    name: vi.fn().mockResolvedValue(calls.name ?? 'Confidential Token'),
    symbol: vi.fn().mockResolvedValue(calls.symbol ?? 'cTKN'),
    decimals: vi.fn().mockResolvedValue(calls.decimals ?? 6n),
    confidentialBalanceOf: vi.fn().mockResolvedValue(calls.confidentialBalanceOf ?? 0n),
  };
}

export function makeMockProvider() {
  return {
    getNetwork: vi.fn().mockResolvedValue({ chainId: 11155111n, name: 'sepolia' }),
    destroy: vi.fn(),
    getBlockNumber: vi.fn().mockResolvedValue(1_000_000),
  };
}
