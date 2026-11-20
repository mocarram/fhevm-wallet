import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server, Socket } from 'net';
import { AddressInfo } from 'net';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runCliAsync, tempHome } from './helpers.js';

// An "RPC" that accepts the TCP connection and then never says anything. Before the fix
// the CLI printed its timeout message and then never exited.
let stall: Server;
const sockets: Socket[] = [];
let stallUrl = '';

beforeAll(async () => {
  stall = createServer((s) => {
    sockets.push(s);
    s.on('error', () => {});
  });
  await new Promise<void>((r) => stall.listen(0, '127.0.0.1', () => r()));
  stallUrl = `http://127.0.0.1:${(stall.address() as AddressInfo).port}`;
});
afterAll(() => {
  sockets.forEach((s) => s.destroy());
  stall.close();
});

const TOKEN = '0xde709f2102306220921060314715629080e2fb77';

describe('commands exit promptly when the RPC never answers', () => {
  it('`fhew config --rpc-sepolia` gives up, says so and exits 1', async () => {
    const t = tempHome();
    try {
      const res = await runCliAsync(['config', '--rpc-sepolia', stallUrl], t.home, {}, 40_000);
      expect(res.ms).toBeLessThan(35_000);
      expect(res.code).toBe(1);
      expect(res.stdout).toMatch(/did not answer/);
    } finally {
      t.cleanup();
    }
  });

  it('`fhew token add` with a stalled RPC in the environment exits 1 with plain words', async () => {
    const t = tempHome();
    try {
      const res = await runCliAsync(
        ['token', 'add', TOKEN, '-n', 'sepolia'],
        t.home,
        { SEPOLIA_RPC_URL: stallUrl },
        40_000,
      );
      expect(res.ms).toBeLessThan(35_000);
      expect(res.code).toBe(1);
      const out = res.stdout + res.stderr;
      expect(out).toMatch(/Could not reach the network/);
      expect(out).not.toMatch(/code=TIMEOUT|version=6/);
    } finally {
      t.cleanup();
    }
  });
  it('`fhew history` with a stalled RPC and no terminal reports, shows saved data and exits 1', async () => {
    const t = tempHome();
    try {
      const dataDir = join(t.home, '.fhevm-wallet');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, 'tokens.json'),
        JSON.stringify({
          tokens: [
            {
              address: TOKEN,
              name: 'Test',
              symbol: 'TST',
              decimals: 6,
              network: 'sepolia',
              addedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      );
      const res = await runCliAsync(
        ['history', '-a', '0x000000000000000000000000000000000000dEaD', '-n', 'sepolia'],
        t.home,
        { SEPOLIA_RPC_URL: `${stallUrl}/v2/STALLKEY0123456789` },
        40_000,
      );
      expect(res.ms).toBeLessThan(35_000);
      expect(res.code).toBe(1);
      const out = res.stdout + res.stderr;
      expect(out).toMatch(/Could not reach the network/);
      expect(out).toMatch(/Showing transactions saved earlier/);
      expect(out).not.toMatch(/no interactive terminal/); // no prompt was attempted
      expect(out).not.toContain('STALLKEY0123456789');
    } finally {
      t.cleanup();
    }
  });
});

describe('failing commands set a non-zero exit code', () => {
  it.each([
    [['token', 'add', 'not-an-address', '-n', 'sepolia']],
    [['token', 'remove', TOKEN, '-n', 'sepolia']],
    [['wallet', 'export', 'nope']],
    [['config', '--network', 'moon']],
    [['history', '-a', '0x000000000000000000000000000000000000dEaD', '-n', 'sepolia']], // no tokens
  ])('%j', async (args) => {
    const t = tempHome();
    try {
      const res = await runCliAsync(args, t.home, {}, 30_000);
      expect(res.code).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('an RPC URL with a space is "not a valid URL", not "did not answer"', async () => {
    const t = tempHome();
    try {
      const res = await runCliAsync(
        ['config', '--rpc-sepolia', 'https://rpc.example/has space'],
        t.home,
        {},
        30_000,
      );
      expect(res.code).toBe(1);
      expect(res.stdout).toMatch(/not a valid URL/);
      expect(res.stdout).not.toMatch(/did not answer/);
    } finally {
      t.cleanup();
    }
  });

  it('a prompt without a terminal fails with one sentence, not a stack', async () => {
    const t = tempHome();
    try {
      const res = await runCliAsync(['wallet', 'import', 'x'], t.home, {}, 30_000);
      expect(res.code).toBe(1);
      expect(res.stdout + res.stderr).toMatch(/no interactive terminal/);
      expect(res.stderr).not.toMatch(/\n\s+at /);
    } finally {
      t.cleanup();
    }
  });
});
