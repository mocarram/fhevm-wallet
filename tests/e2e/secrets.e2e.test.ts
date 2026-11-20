import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CLI, runCliAsync, tempHome } from './helpers.js';
import { spawnSync } from 'child_process';

// A local "RPC provider" that always fails with HTTP 500. ethers puts the full request
// URL (with the key in its path and query) into the error it throws.
const KEY = 'SUPERSECRETPATHTOKEN9876';
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    res.statusCode = 500;
    res.end('boom');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('secrets never reach the terminal', () => {
  it('a 500 from a key-bearing RPC URL does not print the key', async () => {
    const t = tempHome();
    try {
      const rpc = `${base}/qn/${KEY}/?auth=${KEY}`;
      const res = await runCliAsync(
        ['token', 'add', '0xde709f2102306220921060314715629080e2fb77', '-n', 'sepolia'],
        t.home,
        { SEPOLIA_RPC_URL: rpc },
      );
      const out = res.stdout + res.stderr;
      expect(out).toMatch(/Could not reach the network|failed|error/i);
      expect(out).not.toContain(KEY);
    } finally {
      t.cleanup();
    }
  });

  it('`fhew config --show` masks the path and query of a custom RPC URL', async () => {
    const t = tempHome();
    try {
      // As saved by `fhew config --rpc-sepolia` (written directly: no probe needed here).
      mkdirSync(join(t.home, '.fhevm-wallet'), { recursive: true });
      writeFileSync(
        join(t.home, '.fhevm-wallet', '.env'),
        `SEPOLIA_RPC_URL=https://rpc.example/qn/${KEY}?apikey=${KEY}\n`,
      );
      const res = await runCliAsync(['config', '--show'], t.home, {});
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('https://rpc.example/…');
      expect(res.stdout + res.stderr).not.toContain(KEY);
    } finally {
      t.cleanup();
    }
  });

  it('API keys saved with `fhew config` are never echoed back in full', async () => {
    const t = tempHome();
    try {
      const ETHERSCAN = 'ETHERSCANKEY0123456789';
      const ZAMA = 'ZAMAKEY0123456789ABCDEF';
      const outputs = [
        await runCliAsync(['config', '--etherscan-key', ETHERSCAN, '--zama-key', ZAMA], t.home, {}),
        await runCliAsync(['config', '--show'], t.home, {}),
        await runCliAsync(['token', 'list'], t.home, {}),
      ];
      for (const res of outputs) {
        const out = res.stdout + res.stderr;
        expect(out).not.toContain(ETHERSCAN);
        expect(out).not.toContain(ZAMA);
      }
    } finally {
      t.cleanup();
    }
  });

  it('`--etherscan-key -` reads the key from stdin, so it is not in shell history', () => {
    const t = tempHome();
    try {
      const KEYVAL = 'PIPEDKEY0123456789';
      const res = spawnSync(process.execPath, [CLI, 'config', '--etherscan-key', '-'], {
        env: { PATH: process.env.PATH ?? '', HOME: t.home, NO_COLOR: '1' },
        input: `${KEYVAL}\n`,
        encoding: 'utf-8',
        timeout: 30_000,
      });
      expect(res.status).toBe(0);
      expect(res.stdout + res.stderr).not.toContain(KEYVAL);
      expect(readFileSync(join(t.home, '.fhevm-wallet', '.env'), 'utf-8')).toBe(
        `ETHERSCAN_API_KEY=${KEYVAL}\n`,
      );
    } finally {
      t.cleanup();
    }
  });
});
