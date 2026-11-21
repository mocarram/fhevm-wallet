import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface } from 'ethers';
import {
  checkErc7984,
  ERC165_INTERFACE_ID,
  ERC7984_INTERFACE_FUNCTIONS,
  ERC7984_INTERFACE_ID,
  interfaceIdOf,
  type EthCall,
} from '../../../src/core/token/erc7984Check.js';
import { MockBackend, mockNonConfidentialToken } from '../../../src/core/backend/MockBackend.js';

const TOKEN = '0x1111111111111111111111111111111111111111';
const iface = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function confidentialBalanceOf(address) view returns (bytes32)',
  'function supportsInterface(bytes4) view returns (bool)',
]);
const abi = AbiCoder.defaultAbiCoder();

interface Fake {
  name?: string;
  symbol?: string;
  decimals?: number;
  /** Raw return of confidentialBalanceOf, or null to revert. */
  balance?: string | null;
  /** Interface ids the contract reports; undefined = no ERC-165 (reverts). */
  supports?: string[];
}

/** A fake eth_call: answers like a contract described by `f`; unknown calls revert. */
function fakeCall(f: Fake): EthCall {
  const revert = () =>
    Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION',
      action: 'call',
      data: null,
    });
  return async (_to, data) => {
    const sel = data.slice(0, 10);
    const fn = iface.getFunction(sel);
    if (!fn) throw revert();
    switch (fn.name) {
      case 'name':
        if (f.name === undefined) throw revert();
        return abi.encode(['string'], [f.name]);
      case 'symbol':
        if (f.symbol === undefined) throw revert();
        return abi.encode(['string'], [f.symbol]);
      case 'decimals':
        if (f.decimals === undefined) throw revert();
        return abi.encode(['uint8'], [f.decimals]);
      case 'confidentialBalanceOf':
        if (f.balance === null || f.balance === undefined) throw revert();
        return f.balance;
      case 'supportsInterface': {
        if (!f.supports) throw revert();
        const [id] = iface.decodeFunctionData('supportsInterface', data);
        return abi.encode(['bool'], [f.supports.includes(id as string)]);
      }
    }
    throw revert();
  };
}

const HANDLE = '0x' + 'ab'.repeat(32);
const good: Fake = {
  name: 'Confidential USD',
  symbol: 'cUSD',
  decimals: 6,
  balance: HANDLE,
  supports: [ERC165_INTERFACE_ID, ERC7984_INTERFACE_ID],
};

describe('ERC-7984 interface id', () => {
  it('is the XOR of the IERC7984 selectors (OpenZeppelin v0.3.0 to v0.5.3)', () => {
    expect(ERC7984_INTERFACE_FUNCTIONS).toHaveLength(16);
    expect(interfaceIdOf(ERC7984_INTERFACE_FUNCTIONS)).toBe(ERC7984_INTERFACE_ID);
    // Sanity check of the method against a well-known id: ERC-165 itself.
    expect(interfaceIdOf(['supportsInterface(bytes4)'])).toBe(ERC165_INTERFACE_ID);
  });
});

describe('checkErc7984', () => {
  it('accepts a token that answers the probe and reports the interface', async () => {
    const r = await checkErc7984(fakeCall(good), TOKEN);
    expect(r.compliant).toBe(true);
    expect(r.erc165).toBe('yes');
    expect(r.info).toEqual({
      address: TOKEN,
      name: 'Confidential USD',
      symbol: 'cUSD',
      decimals: 6,
    });
    expect(r.problems).toEqual([]);
  });

  it('accepts an older token without ERC-165', async () => {
    const r = await checkErc7984(fakeCall({ ...good, supports: undefined }), TOKEN);
    expect(r.compliant).toBe(true);
    expect(r.erc165).toBe('absent');
    expect(r.warnings).toEqual([]);
  });

  it('warns when ERC-165 is there but the id is not', async () => {
    const r = await checkErc7984(fakeCall({ ...good, supports: [ERC165_INTERFACE_ID] }), TOKEN);
    expect(r.compliant).toBe(true);
    expect(r.erc165).toBe('no');
    expect(r.warnings.join(' ')).toMatch(/another version/);
  });

  it('refuses an ERC-20 (no confidential balance)', async () => {
    const r = await checkErc7984(fakeCall({ ...good, balance: null, supports: undefined }), TOKEN);
    expect(r.compliant).toBe(false);
    expect(r.info?.symbol).toBe('cUSD');
    expect(r.problems.join(' ')).toMatch(/not an ERC-7984 confidential token/);
  });

  it('refuses a balance that is not exactly one 32-byte word', async () => {
    const r = await checkErc7984(
      fakeCall({ ...good, balance: HANDLE + '00', supports: undefined }),
      TOKEN,
    );
    expect(r.compliant).toBe(false);
  });

  it('refuses an account (every call returns 0x)', async () => {
    const r = await checkErc7984(async () => '0x', TOKEN);
    expect(r.compliant).toBe(false);
    expect(r.info).toBeNull();
    expect(r.erc165).toBe('absent');
  });

  it('sanitises name and symbol', async () => {
    const r = await checkErc7984(
      fakeCall({ ...good, name: 'Evil\u001b[2J‮Token', symbol: 'c​USD' }),
      TOKEN,
    );
    expect(r.info?.name).not.toMatch(/[\u001b‮]/);
    expect(r.info?.symbol).not.toContain('\u200b');
  });

  it('trusts the ERC-7984 interface id when the balance probe answers oddly', async () => {
    const r = await checkErc7984(fakeCall({ ...good, balance: HANDLE + '00' }), TOKEN);
    expect(r.erc165).toBe('yes');
    expect(r.compliant).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/unusual/);
  });

  it('a reply missing from a JSON-RPC batch is a transport failure, not "not ERC-7984"', async () => {
    // nodies answers batches of more than 10 with one error; ethers reports BAD_DATA.
    const missing: EthCall = async () => {
      throw Object.assign(new Error('missing response for request (value=[...])'), {
        code: 'BAD_DATA',
        shortMessage: 'missing response for request',
      });
    };
    await expect(checkErc7984(missing, TOKEN)).rejects.toThrow(/missing response/);
  });

  it('rethrows transport failures instead of calling the token non-compliant', async () => {
    const down: EthCall = async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' });
    };
    await expect(checkErc7984(down, TOKEN)).rejects.toThrow(/fetch failed/);
    // A JSON-RPC error from the node (e.g. a rate limit) inside CALL_EXCEPTION too.
    const limited: EthCall = async () => {
      throw Object.assign(new Error('missing revert data'), {
        code: 'CALL_EXCEPTION',
        action: 'call',
        data: null,
        info: { error: { code: -32005, message: 'rate limit' } },
      });
    };
    await expect(checkErc7984(limited, TOKEN)).rejects.toThrow();
  });
});

describe('MockBackend.checkToken', () => {
  const backend = new MockBackend({ latencyMs: 0, sleep: async () => {} });
  it('accepts catalogue tokens and refuses the plain ERC-20', async () => {
    const t = backend.catalogue('sepolia')[0];
    expect((await backend.checkToken(t.address, 'sepolia')).compliant).toBe(true);
    const plain = await backend.checkToken(mockNonConfidentialToken('sepolia'), 'sepolia');
    expect(plain.compliant).toBe(false);
  });
});
