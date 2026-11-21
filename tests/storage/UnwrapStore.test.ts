import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addUnwrap,
  assertUnwrapStoreWritable,
  findUnwrap,
  isOpenUnwrap,
  listUnwraps,
  listUnwrapsSafe,
  removeUnwrap,
  UnwrapStoreError,
  updateUnwrap,
} from '../../src/storage/UnwrapStore.js';
import {
  cachedWrappers,
  getCachedWrapper,
  MAX_AGE_MS,
  setCachedWrapper,
} from '../../src/storage/WrapperCache.js';
import { WALLET_DATA_ENTRIES } from '../../src/storage/paths.js';
import { getTestDataDir, wipeTestDataDir } from '../helpers/dataDir.js';

const WALLET = '0x12ac1188C78Ec055f09dBb5a674b801A98047a8f';
const TOKEN = '0x85E3A388B8b8939Ab4f41e0B1eF70A998b23F938';
const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');

function entry(n: number) {
  return {
    id: h(n),
    network: 'sepolia' as const,
    wallet: WALLET,
    token: TOKEN,
    symbol: 'cZAMA',
    decimals: 6,
    rate: '1000000000000',
    underlying: {
      address: '0xfeA311967E1899976E954aA6fb760e078407E37d',
      symbol: 'ZAMA',
      decimals: 18,
    },
    hasRequester: true,
    amount: '10000000',
    requestTxHash: h(n),
  };
}

beforeEach(() => wipeTestDataDir());

describe('UnwrapStore', () => {
  it('records a signed request and moves it through its states', () => {
    const e = addUnwrap(entry(1));
    expect(e.state).toBe('signed');
    expect(isOpenUnwrap(e)).toBe(true);
    updateUnwrap(e.id, { state: 'requested', requestId: h(99), requestBlock: 5 });
    const f = updateUnwrap(e.id, { state: 'finished', finishedBy: 'wallet', finalizeTxHash: h(7) });
    expect(isOpenUnwrap(f)).toBe(false);
    expect(listUnwraps({ open: true })).toHaveLength(0);
    expect(listUnwraps({ wallet: WALLET.toLowerCase(), network: 'sepolia' })).toHaveLength(1);
    expect(listUnwraps({ network: 'mainnet' })).toHaveLength(0);
  });

  it('never records the same request twice', () => {
    addUnwrap(entry(1));
    expect(() => addUnwrap(entry(1))).toThrow(/already recorded/);
  });

  it('finds an entry by request hash, request id or finalize hash prefix', () => {
    addUnwrap(entry(1));
    updateUnwrap(h(1), { state: 'requested', requestId: '0xabcdef' + '0'.repeat(58) });
    expect(findUnwrap('0xabcdef00')).toHaveLength(1);
    expect(findUnwrap(h(1))).toHaveLength(1);
    expect(findUnwrap('nope')).toHaveLength(0);
  });

  it('is owner-only and listed in WALLET_DATA_ENTRIES', () => {
    addUnwrap(entry(1));
    const file = join(getTestDataDir(), 'unwraps.json');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
    expect(WALLET_DATA_ENTRIES).toContain('unwraps.json');
    expect(WALLET_DATA_ENTRIES).toContain('wrappers.json');
  });

  it('never overwrites a damaged file: reads for display are empty, writes throw', () => {
    addUnwrap(entry(1));
    const file = join(getTestDataDir(), 'unwraps.json');
    writeFileSync(file, '{"version":1,"entries":[{"broken":true}]}');
    expect(listUnwrapsSafe()).toEqual([]);
    expect(() => listUnwraps()).toThrow(UnwrapStoreError);
    expect(() => assertUnwrapStoreWritable()).toThrow(/will not overwrite/);
    expect(() => addUnwrap(entry(2))).toThrow(UnwrapStoreError);
    expect(readFileSync(file, 'utf8')).toContain('broken');
  });

  it('forgets an entry on request', () => {
    addUnwrap(entry(1));
    removeUnwrap(h(1));
    expect(listUnwraps()).toEqual([]);
    expect(existsSync(join(getTestDataDir(), 'unwraps.json'))).toBe(true);
  });
});

describe('WrapperCache', () => {
  const info = {
    address: TOKEN,
    name: 'Confidential Zama',
    symbol: 'cZAMA',
    decimals: 6,
    rate: 10n ** 12n,
    underlying: {
      address: '0xfeA311967E1899976E954aA6fb760e078407E37d',
      name: 'Zama',
      symbol: 'ZAMA',
      decimals: 18,
    },
    hasRequester: true,
  };

  it('remembers wrappers and non-wrappers, and expires them', () => {
    expect(getCachedWrapper('sepolia', TOKEN)).toBeUndefined();
    setCachedWrapper('sepolia', TOKEN, info);
    expect(getCachedWrapper('sepolia', TOKEN.toLowerCase())).toEqual(info);
    expect(cachedWrappers('sepolia')[TOKEN.toLowerCase()]?.rate).toBe(10n ** 12n);
    expect(cachedWrappers('mainnet')).toEqual({});
    expect(getCachedWrapper('sepolia', TOKEN, Date.now() + MAX_AGE_MS + 1)).toBeUndefined();
    const other = '0x0000000000000000000000000000000000000abc';
    setCachedWrapper('sepolia', other, null);
    expect(getCachedWrapper('sepolia', other)).toBeNull();
  });
});
