import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

vi.mock('../../../src/core/token/TokenService.js', () => ({
  getTokenInfo: vi.fn(async (address: string) => ({
    address,
    name: 'Mock Token',
    symbol: 'MOCK',
    decimals: 6,
  })),
}));

const TOKEN = '0xde709f2102306220921060314715629080e2fb77';
const OTHER = '0x52908400098527886E0F7030069857D2E4169EE7';

beforeEach(() => {
  wipeTestDataDir();
});

describe('TokenRegistry', () => {
  it('addToken stores info from getTokenInfo and rejects duplicates', async () => {
    const { addToken, getToken, isTokenRegistered, listTokens } =
      await import('../../../src/core/token/TokenRegistry.js');

    const entry = await addToken(TOKEN, 'sepolia');
    expect(entry.symbol).toBe('MOCK');
    expect(isTokenRegistered(TOKEN, 'sepolia')).toBe(true);
    expect(getToken(TOKEN, 'sepolia')?.decimals).toBe(6);
    expect(listTokens('sepolia')).toHaveLength(1);

    await expect(addToken(TOKEN, 'sepolia')).rejects.toThrow(/already exists/);
  });

  it('listTokens filters by network', async () => {
    const { addToken, listTokens } = await import('../../../src/core/token/TokenRegistry.js');

    await addToken(TOKEN, 'sepolia');
    await addToken(OTHER, 'mainnet');

    expect(listTokens('sepolia')).toHaveLength(1);
    expect(listTokens('mainnet')).toHaveLength(1);
    expect(listTokens()).toHaveLength(2);
  });

  it('removeToken returns false when token is not registered', async () => {
    const { removeToken } = await import('../../../src/core/token/TokenRegistry.js');
    expect(removeToken(TOKEN, 'sepolia')).toBe(false);
  });

  it('removeToken removes a registered token and returns true', async () => {
    const { addToken, removeToken, isTokenRegistered } =
      await import('../../../src/core/token/TokenRegistry.js');
    await addToken(TOKEN, 'sepolia');
    expect(removeToken(TOKEN, 'sepolia')).toBe(true);
    expect(isTokenRegistered(TOKEN, 'sepolia')).toBe(false);
  });
});
