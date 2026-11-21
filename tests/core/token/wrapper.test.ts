import { AbiCoder, getAddress, Interface } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  ERC20_ABI,
  readWrapperInfo,
  requestIdFromLogs,
  WRAPPER_ABI,
} from '../../../src/core/token/wrapper.js';

const WRAPPER = '0x85E3A388B8b8939Ab4f41e0B1eF70A998b23F938';
const ZAMA = '0xfeA311967E1899976E954aA6fb760e078407E37d';
const coder = AbiCoder.defaultAbiCoder();

/** A fake eth_call: answers per (address, selector), reverts (CALL_EXCEPTION) otherwise. */
function fakeChain(answers: Record<string, Record<string, string>>) {
  return async (to: string, data: string): Promise<string> => {
    const byFn = answers[getAddress(to)] ?? {};
    for (const [fn, out] of Object.entries(byFn)) {
      const iface = fn in { underlying: 1, rate: 1, unwrapRequester: 1 } ? WRAPPER_ABI : ERC20_ABI;
      if (data.startsWith(iface.getFunction(fn)!.selector)) return out;
    }
    throw Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION',
      action: 'call',
      data: '0x',
    });
  };
}
const str = (s: string) => coder.encode(['string'], [s]);
const num = (n: bigint) => coder.encode(['uint256'], [n]);
const addr = (a: string) => coder.encode(['address'], [a]);

const CZAMA_CHAIN = {
  [WRAPPER]: {
    underlying: addr(ZAMA),
    rate: num(10n ** 12n),
    decimals: num(6n),
    name: str('Confidential Zama'),
    symbol: str('cZAMA'),
    unwrapRequester: addr('0x0000000000000000000000000000000000000000'),
  },
  [ZAMA]: { decimals: num(18n), name: str('Zama'), symbol: str('ZAMA') },
};

describe('readWrapperInfo', () => {
  it('reads a wrapper and its ERC-20 (cZAMA on Sepolia)', async () => {
    const info = await readWrapperInfo(fakeChain(CZAMA_CHAIN), WRAPPER);
    expect(info).toEqual({
      address: WRAPPER,
      name: 'Confidential Zama',
      symbol: 'cZAMA',
      decimals: 6,
      rate: 10n ** 12n,
      underlying: { address: ZAMA, name: 'Zama', symbol: 'ZAMA', decimals: 18 },
      hasRequester: true,
    });
  });

  it('is null for a plain ERC-7984 token (no underlying/rate)', async () => {
    const chain = fakeChain({
      [WRAPPER]: { decimals: num(6n), name: str('cKRW'), symbol: str('cKRW') },
    });
    expect(await readWrapperInfo(chain, WRAPPER)).toBeNull();
  });

  it('marks 0.3.x wrappers without unwrapRequester', async () => {
    const { unwrapRequester: _u, ...rest } = CZAMA_CHAIN[WRAPPER];
    const info = await readWrapperInfo(fakeChain({ ...CZAMA_CHAIN, [WRAPPER]: rest }), WRAPPER);
    expect(info?.hasRequester).toBe(false);
  });

  it('sanitises contract text and infers decimals when the ERC-20 has none', async () => {
    const chain = fakeChain({
      ...CZAMA_CHAIN,
      [WRAPPER]: { ...CZAMA_CHAIN[WRAPPER], symbol: str('c\u001b[31mZAMA‮') },
      [ZAMA]: { name: str('Zama'), symbol: str('ZA​MA') },
    });
    const info = await readWrapperInfo(chain, WRAPPER);
    expect(info?.symbol).not.toMatch(/[\u001b‮]/);
    expect(info?.underlying.symbol).not.toMatch(/\u200b/);
    expect(info?.underlying.decimals).toBe(18); // 6 + log10(1e12)
  });

  it('throws on a transport failure instead of saying "not a wrapper"', async () => {
    const down = async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' });
    };
    await expect(readWrapperInfo(down, WRAPPER)).rejects.toThrow(/fetch failed/);
    const rpcErr = async () => {
      throw Object.assign(new Error('rate limited'), {
        code: 'CALL_EXCEPTION',
        info: { error: { code: 429, message: 'Too many requests' } },
      });
    };
    await expect(readWrapperInfo(rpcErr, WRAPPER)).rejects.toThrow();
  });

  it('refuses a zero underlying or a zero rate', async () => {
    const zero = fakeChain({ [WRAPPER]: { ...CZAMA_CHAIN[WRAPPER], rate: num(0n) } });
    expect(await readWrapperInfo(zero, WRAPPER)).toBeNull();
  });
});

describe('requestIdFromLogs', () => {
  // A real UnwrapRequested log of cZAMAMock (Sepolia tx 0x171c5e33…, block 12164100).
  const MOCKW = '0xf2D628d2598aF4eAF94CB76a437Ff86CA78FfbFB';
  const RECEIVER = '0xe4E9c58c58E81E0D593F3e84601Ea69FF20b5d2D';
  const ID = '0x07494aab85541385e48272eb2e59eda81b2dba373aff0000000000aa36a70500';
  const v4 = {
    address: MOCKW,
    topics: [
      WRAPPER_ABI.getEvent('UnwrapRequested')!.topicHash,
      '0x000000000000000000000000e4e9c58c58e81e0d593f3e84601ea69ff20b5d2d',
      ID,
    ],
    data: ID,
  };

  it('reads the 0.4+ event (indexed id) for our receiver only', () => {
    expect(requestIdFromLogs([v4], MOCKW, RECEIVER)).toBe(ID);
    expect(requestIdFromLogs([v4], MOCKW, '0x0000000000000000000000000000000000000001')).toBeNull();
    expect(requestIdFromLogs([{ ...v4, address: WRAPPER }], MOCKW, RECEIVER)).toBeNull();
  });

  it('reads the 0.3.x event (id = the amount in data)', () => {
    const v3 = new Interface(['event UnwrapRequested(address indexed receiver, bytes32 amount)']);
    const ev = v3.getEvent('UnwrapRequested')!;
    const { topics, data } = v3.encodeEventLog(ev, [RECEIVER, ID]);
    expect(requestIdFromLogs([{ address: MOCKW, topics, data }], MOCKW, RECEIVER)).toBe(ID);
  });

  it('matches the topics seen in the deployed bytecode', () => {
    const t = (sig: string) =>
      new Interface([`event ${sig}`]).getEvent(sig.split('(')[0])!.topicHash;
    expect(WRAPPER_ABI.getEvent('UnwrapRequested')!.topicHash).toBe(
      t(
        'UnwrapRequested(address indexed receiver, bytes32 indexed unwrapRequestId, bytes32 amount)',
      ),
    );
    expect(WRAPPER_ABI.getEvent('UnwrapFinalized')!.topicHash).toBe(
      t(
        'UnwrapFinalized(address indexed receiver, bytes32 indexed unwrapRequestId, bytes32 encryptedAmount, uint64 cleartextAmount)',
      ),
    );
    // Selectors found in cZAMA's bytecode.
    expect(WRAPPER_ABI.getFunction('wrap')!.selector).toBe('0xbf376c7a');
    expect(WRAPPER_ABI.getFunction('finalizeUnwrap')!.selector).toBe(
      new Interface(['function finalizeUnwrap(bytes32,uint64,bytes)']).getFunction(
        'finalizeUnwrap',
      )!.selector,
    );
  });
});
