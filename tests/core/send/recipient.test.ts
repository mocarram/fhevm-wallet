import { getAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  findLookAlike,
  lookAlikeCandidates,
  recipientRefusal,
  selfSendWarning,
  parseAddressInput,
  shortAddress,
  splitForComparison,
} from '../../../src/core/send/recipient.js';
import { resolveRecipient, resolveToken } from '../../../src/core/send/resolve.js';

const BOB = getAddress('0x91be4c2a6d0f83b1e7c5a9d2f4e8b0c6d3d207af');
const contacts = [
  { name: 'bob', address: BOB },
  { name: 'treasury', address: '0x4C2d7E1a9B3f60c8D5e2A4b7C1f9E3d6a0F2b8E1' },
];
const LOOKALIKE = '0x91be9f71c0ae2b58d4a3f6c0b9e1d7a5f33307af';

describe('parseAddressInput', () => {
  it('accepts lowercase and returns checksum form', () => {
    const r = parseAddressInput(BOB.toLowerCase());
    expect(r).toEqual({ ok: true, address: BOB });
  });

  it('rejects a mixed-case address with a bad checksum', () => {
    // Flip the case of one letter: still valid hex, but the EIP-55 checksum breaks.
    const at = BOB.search(/[a-fA-F]/);
    const ch = BOB[at];
    const typo =
      BOB.slice(0, at) +
      (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) +
      BOB.slice(at + 1);
    const r = parseAddressInput(typo);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/checksum/);
  });

  it('rejects the wrong length', () => {
    expect(parseAddressInput('0x1234').ok).toBe(false);
    expect(parseAddressInput('hello').ok).toBe(false);
  });
});

describe('findLookAlike', () => {
  it('flags an address matching first and last 4 hex chars of a contact', () => {
    expect(findLookAlike(LOOKALIKE, contacts)?.name).toBe('bob');
  });

  it('does not flag the contact itself or unrelated addresses', () => {
    expect(findLookAlike(BOB.toLowerCase(), contacts)).toBeNull();
    expect(findLookAlike('0x6E1d3a0B7c25F9e84D1A6b3C0e7F52a9d8C194Fa', contacts)).toBeNull();
  });

  it('needs both ends to match', () => {
    const onlyStart = '0x91be000000000000000000000000000000000000';
    expect(findLookAlike(onlyStart, contacts)).toBeNull();
  });
});

describe('address display', () => {
  it('splits around the compared characters', () => {
    expect(splitForComparison(BOB)).toEqual([BOB.slice(0, 6), BOB.slice(6, -4), BOB.slice(-4)]);
    expect(shortAddress(BOB)).toBe(`${BOB.slice(0, 6)}…${BOB.slice(-4)}`);
  });
});

describe('resolveRecipient', () => {
  it('resolves contact names case-insensitively', () => {
    const r = resolveRecipient('Bob', contacts);
    expect(r.ok && r.address).toBe(BOB);
  });

  it('resolves an address and attaches a matching contact', () => {
    const r = resolveRecipient(BOB.toLowerCase(), contacts);
    expect(r.ok && r.contact?.name).toBe('bob');
  });

  it('explains an unknown name', () => {
    const r = resolveRecipient('carol', contacts);
    expect(r.ok).toBe(false);
  });
});

describe('resolveToken', () => {
  const tokens = [
    { address: '0x00000000000000000000000000000000000000a1', symbol: 'cUSDC' },
    { address: '0x00000000000000000000000000000000000000a2', symbol: 'cDAI' },
    { address: '0x00000000000000000000000000000000000000a3', symbol: 'dup' },
    { address: '0x00000000000000000000000000000000000000a4', symbol: 'DUP' },
  ];
  it('matches symbols case-insensitively and addresses exactly', () => {
    expect(resolveToken('cusdc', tokens)).toMatchObject({ ok: true, token: tokens[0] });
    expect(resolveToken(tokens[1].address.toUpperCase().replace('0X', '0x'), tokens).ok).toBe(true);
  });
  it('refuses ambiguous and unknown symbols', () => {
    expect(resolveToken('dup', tokens).ok).toBe(false);
    const r = resolveToken('ceth', tokens);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Try cusdc/);
  });
});

describe('recipient refusals and warnings (M8)', () => {
  const TOKEN = '0x1111111111111111111111111111111111111111';
  const ME = '0x52908400098527886E0F7030069857D2E4169EE7';

  it('refuses the token contract itself and the zero address', () => {
    expect(recipientRefusal(TOKEN.toUpperCase().replace('0X', '0x'), TOKEN)).toMatch(
      /token contract itself/,
    );
    expect(recipientRefusal('0x' + '0'.repeat(40), TOKEN)).toMatch(/zero address/);
    expect(recipientRefusal(ME, TOKEN)).toBeNull();
  });

  it('warns, without refusing, when sending to yourself', () => {
    expect(selfSendWarning(ME.toLowerCase(), ME)).toMatch(/your own address/);
    expect(selfSendWarning(TOKEN, ME)).toBeNull();
  });

  it('checks look-alikes against own wallets and history, contacts first', () => {
    const lookalike = '0x5290' + 'f'.repeat(32) + '9EE7';
    const candidates = lookAlikeCandidates({
      contacts: [],
      wallets: [{ name: 'main', address: ME }],
      counterparties: [ME, '0x000000000000000000000000000000000000dEaD'],
    });
    expect(candidates).toHaveLength(2);
    expect(findLookAlike(lookalike, candidates)?.name).toBe('your wallet "main"');
    const fromHistory = lookAlikeCandidates({ counterparties: [ME] });
    expect(findLookAlike(lookalike, fromHistory)?.name).toBe('an address from your history');
  });
});
