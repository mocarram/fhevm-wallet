/**
 * Guards against the bug that broke Sepolia sends: calling mock-only `$_` functions.
 * Uses the real ethers Interface (no mocks) so the encoded selector is checked exactly.
 */
import { describe, expect, it } from 'vitest';
import { Interface, id } from 'ethers';
import { ERC7984_ABI } from '../../../src/core/token/TokenService.js';

const iface = new Interface(ERC7984_ABI);

describe('ERC7984_ABI', () => {
  it('contains no hardhat-exposed mock functions', () => {
    for (const fragment of ERC7984_ABI) {
      expect(fragment).not.toMatch(/\$_/);
    }
  });

  it('encodes the standard confidentialTransfer(address,bytes32,bytes) selector', () => {
    const data = iface.encodeFunctionData('confidentialTransfer(address,bytes32,bytes)', [
      '0x000000000000000000000000000000000000dEaD',
      '0x' + '11'.repeat(32),
      '0x1234',
    ]);
    expect(data.slice(0, 10)).toBe(id('confidentialTransfer(address,bytes32,bytes)').slice(0, 10));
  });

  it('uses the event signature the history scanner filters on', () => {
    const ev = iface.getEvent('ConfidentialTransfer');
    expect(ev?.topicHash).toBe(
      '0x67500e8d0ed826d2194f514dd0d8124f35648ab6e3fb5e6ed867134cffe661e9',
    );
  });

  it('decodes ERC-7984 custom errors by name', () => {
    const data = iface.encodeErrorResult('ERC7984InvalidReceiver', [
      '0x0000000000000000000000000000000000000000',
    ]);
    expect(iface.parseError(data)?.name).toBe('ERC7984InvalidReceiver');
  });
});
