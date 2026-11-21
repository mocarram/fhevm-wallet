import { describe, expect, it } from 'vitest';
import { MockBackend, mockNonConfidentialToken } from '../../src/core/backend/MockBackend.js';
import { doctorFailed, nodeVersionOk, runDoctorChecks } from '../../src/core/doctor.js';
import { DATA_DIR, ensureDataDir } from '../../src/storage/paths.js';
import type { TokenEntry } from '../../src/core/token/TokenRegistry.js';

const backend = (fail?: 'rpc') => new MockBackend({ latencyMs: 0, sleep: async () => {}, fail });
const entry = (address: string, symbol: string): TokenEntry => ({
  address,
  symbol,
  name: symbol,
  decimals: 6,
  network: 'sepolia',
  addedAt: '2026-01-01T00:00:00.000Z',
});

describe('runDoctorChecks', () => {
  it('passes a healthy mock setup and checks every token', async () => {
    ensureDataDir();
    const b = backend();
    const t = b.catalogue('sepolia')[0];
    const rows = await runDoctorChecks({
      backend: b,
      network: 'sepolia',
      address: '0x52908400098527886E0F7030069857D2E4169EE7',
      tokens: [entry(t.address, t.symbol)],
      dataDir: DATA_DIR,
      etherscanKey: false,
      nodeVersion: '24.11.0',
    });
    expect(doctorFailed(rows)).toBe(false);
    expect(rows.map((r) => r.id)).toEqual(
      expect.arrayContaining(['node', 'data-dir', 'rpc.0', 'relayer', 'eth', `token.${t.address}`]),
    );
  });

  it('fails on an old Node, a non-ERC-7984 token and a dead RPC', async () => {
    ensureDataDir();
    const plain = mockNonConfidentialToken('sepolia');
    const rows = await runDoctorChecks({
      backend: backend(),
      network: 'sepolia',
      tokens: [entry(plain, 'PLAIN')],
      dataDir: DATA_DIR,
      etherscanKey: true,
      nodeVersion: '22.1.0',
    });
    expect(rows.find((r) => r.id === 'node')?.status).toBe('fail');
    expect(rows.find((r) => r.id === `token.${plain}`)).toMatchObject({
      status: 'fail',
      text: 'PLAIN is not an ERC-7984 token',
    });
    const dead = await runDoctorChecks({
      backend: backend('rpc'),
      network: 'sepolia',
      tokens: [],
      dataDir: DATA_DIR,
      etherscanKey: true,
    });
    expect(dead.find((r) => r.id === 'rpc')?.status).toBe('fail');
    expect(doctorFailed(dead)).toBe(true);
  });

  it('nodeVersionOk', () => {
    expect(nodeVersionOk('24.11.0')).toBe(true);
    expect(nodeVersionOk('24.10.9')).toBe(false);
    expect(nodeVersionOk('25.0.0')).toBe(true);
  });
});
