import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { wipeTestDataDir } from '../../helpers/dataDir.js';
import { setCustomRpc, validateRpcUrl } from '../../../src/core/network/rpcSettings.js';
import { getEnvVar } from '../../../src/storage/paths.js';

// A tiny local JSON-RPC server whose chain id we control. No external network needed.
let server: Server;
let chainIdHex = '0xaa36a7';
let url = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      const reply = (m: { id: number }) => ({ jsonrpc: '2.0', id: m.id, result: chainIdHex });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(reply) : reply(msg)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  wipeTestDataDir();
  chainIdHex = '0xaa36a7';
});

describe('validateRpcUrl', () => {
  it('accepts https and local http only', () => {
    expect(validateRpcUrl('https://rpc.example')).toBeNull();
    expect(validateRpcUrl('http://localhost:8545')).toBeNull();
    expect(validateRpcUrl('http://rpc.example')).toMatch(/https/);
    expect(validateRpcUrl('not a url')).toMatch(/valid URL/);
    expect(validateRpcUrl('https://rpc.example/v3/ab cd')).toMatch(/not a valid URL.*space/);
  });
});

describe('setCustomRpc', () => {
  it('saves an endpoint that serves the right chain', async () => {
    const probe = await setCustomRpc('sepolia', url);
    expect(probe.chainId).toBe(11155111n);
    expect(getEnvVar('SEPOLIA_RPC_URL')).toBe(url);
  });

  it('refuses an endpoint on the wrong chain and saves nothing', async () => {
    chainIdHex = '0x1';
    await expect(setCustomRpc('sepolia', url)).rejects.toThrow(/serves chain 1/);
    expect(getEnvVar('SEPOLIA_RPC_URL')).toBeUndefined();
  });

  it('refuses an endpoint that does not answer', async () => {
    await expect(setCustomRpc('sepolia', 'http://127.0.0.1:1')).rejects.toThrow(/did not answer/);
  });
});
