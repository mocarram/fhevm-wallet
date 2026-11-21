import { describe, expect, it } from 'vitest';
import {
  classifyRpcLimit,
  isRateLimited,
  parseRangeLimit,
} from '../../../src/core/network/rpcLimits.js';

/** Error replies seen from real endpoints (Sepolia, Nov 2026) and documented by others. */
const NODIES = {
  code: -32001,
  message:
    'Block range too large: maximum allowed is 50 blocks on your current plan. Upgrade your subscription at https://nodies.app/pricing for larger ranges.',
};
const PUBLICNODE_PRUNED = { code: 4444, message: 'pruned history unavailable' };
const PUBLICNODE_TOPIC_ONLY = {
  code: -32701,
  message:
    'Please specify an address in your request or, to remove restrictions, order a dedicated full node here: https://www.allnodes.com/eth/host',
};
const DRPC = {
  code: 35,
  message: 'chain is not available on free plan, please upgrade to paid plan',
};

describe('classifyRpcLimit', () => {
  it('recognises the replies of the default endpoints', () => {
    expect(classifyRpcLimit(NODIES)).toBe('range');
    expect(classifyRpcLimit(PUBLICNODE_PRUNED)).toBe('pruned');
    expect(classifyRpcLimit(PUBLICNODE_TOPIC_ONLY)).toBe('restricted');
    expect(classifyRpcLimit(DRPC)).toBe('restricted');
  });

  it('reads them inside an ethers error as well', () => {
    const wrapped = Object.assign(new Error('could not coalesce error'), { error: NODIES });
    expect(classifyRpcLimit(wrapped)).toBe('range');
  });

  it('keeps Infura\'s -32005 "more than 10000 results" a range error, other -32005 a rate limit', () => {
    expect(
      classifyRpcLimit({ code: -32005, message: 'query returned more than 10000 results' }),
    ).toBe('range');
    expect(classifyRpcLimit({ code: -32005, message: 'limit exceeded' })).toBe('rate');
    expect(isRateLimited({ response: { statusCode: 429 } })).toBe(true);
  });

  it('leaves reverts and ordinary errors alone', () => {
    expect(classifyRpcLimit({ code: 3, message: 'execution reverted: forbidden' })).toBeNull();
    expect(classifyRpcLimit({ code: -32000, message: 'insufficient funds for gas' })).toBeNull();
    expect(classifyRpcLimit({ code: -32000, message: 'exceeds block gas limit' })).toBeNull();
  });
});

describe('parseRangeLimit', () => {
  it('reads the limits providers name', () => {
    expect(parseRangeLimit(NODIES)).toBe(50);
    expect(parseRangeLimit({ message: 'eth_getLogs is limited to a 10,000 range' })).toBe(10_000);
    expect(parseRangeLimit({ message: 'exceed maximum block range: 1000' })).toBe(1000);
    expect(
      parseRangeLimit({
        message:
          'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response. Based on your parameters, this block range should work: [0x10, 0x4f]',
      }),
    ).toBe(64);
    expect(
      parseRangeLimit({ message: 'You can make eth_getLogs requests with up to a 2K block range' }),
    ).toBe(2000);
  });

  it('returns null when no limit is named', () => {
    expect(parseRangeLimit({ message: 'query returned more than 10000 results' })).toBeNull();
    expect(parseRangeLimit({ message: 'block range is too wide' })).toBeNull();
  });
});
