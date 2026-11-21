import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { createServer, Server } from 'http';
import { createServer as createTcpServer, Server as TcpServer, Socket, AddressInfo } from 'net';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { Wallet } from 'ethers';
import { CLI, runCliAsync, tempHome } from './helpers.js';

// Local "RPC providers" that misbehave in the ways real ones do:
// - echo500: HTTP 500 whose body repeats the request path and query (where the key is);
// - stall:   accepts the connection and never answers;
// - empty:   a healthy Sepolia node with no contract anywhere (every eth_call returns 0x).
const KEY = 'SECRET500KEY999';
const QKEY = 'QUERYKEY12345';
let echo500: Server;
let empty: Server;
let stall: TcpServer;
const sockets: Socket[] = [];
let echoBase = '';
let emptyBase = '';
let stallBase = '';

const port = (s: Server | TcpServer) => (s.address() as AddressInfo).port;

beforeAll(async () => {
  echo500 = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: `internal error for ${req.url}` }));
    });
  });
  empty = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msgs = [JSON.parse(body)].flat() as { id: number; method: string }[];
      const reply = (m: { id: number; method: string }) => ({
        jsonrpc: '2.0',
        id: m.id,
        result: m.method === 'eth_chainId' ? '0xaa36a7' : '0x',
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(msgs.length === 1 ? reply(msgs[0]) : msgs.map(reply)));
    });
  });
  stall = createTcpServer((s) => {
    sockets.push(s);
    s.on('error', () => {});
  });
  for (const s of [echo500, empty, stall]) {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  }
  echoBase = `http://127.0.0.1:${port(echo500)}`;
  emptyBase = `http://127.0.0.1:${port(empty)}`;
  stallBase = `http://127.0.0.1:${port(stall)}`;
});
afterAll(() => {
  sockets.forEach((s) => s.destroy());
  [echo500, empty, stall].forEach((s) => s.close());
});

const TOKEN = '0xde709f2102306220921060314715629080e2fb77';
const keyUrl = (base: string) => `${base}/v2/${KEY}?apikey=${QKEY}`;

describe('token add and config against RPC errors', () => {
  it('an address with no contract is "not a token contract", exit 1', async () => {
    const t = tempHome();
    try {
      const res = await runCliAsync(['token', 'add', TOKEN, '-n', 'sepolia'], t.home, {
        SEPOLIA_RPC_URL: emptyBase,
      });
      expect(res.code).toBe(1);
      expect(res.stdout + res.stderr).toMatch(/That address is not a token contract on sepolia/);
      expect(res.stdout + res.stderr).not.toMatch(/could not decode/);
    } finally {
      t.cleanup();
    }
  });

  it.each([['0'], ['1']])(
    'a 500 that echoes the key shows no key (FHEW_DEBUG=%s), details only when asked',
    async (debug) => {
      const t = tempHome();
      try {
        const res = await runCliAsync(['token', 'add', TOKEN, '-n', 'sepolia'], t.home, {
          SEPOLIA_RPC_URL: keyUrl(echoBase),
          FHEW_DEBUG: debug,
        });
        const out = res.stdout + res.stderr;
        expect(res.code).toBe(1);
        expect(out).toMatch(/Could not reach the network/);
        if (debug === '1') expect(out).toMatch(/Technical details: .*500/);
        else expect(out).not.toMatch(/Technical details/);
        expect(out).not.toContain(KEY);
        expect(out).not.toContain(QKEY);
      } finally {
        t.cleanup();
      }
    },
  );

  it('`config --rpc-sepolia` with an endpoint that answers 500 says it returned an error', async () => {
    const t = tempHome();
    try {
      const res = await runCliAsync(['config', '--rpc-sepolia', keyUrl(echoBase)], t.home, {});
      expect(res.code).toBe(1);
      expect(res.stdout).toMatch(/returned an error \(HTTP 500\)/);
      expect(res.stdout).not.toMatch(/did not answer/);
      expect(res.stdout + res.stderr).not.toContain(KEY);
    } finally {
      t.cleanup();
    }
  });
});

// `balance` asks for the wallet password, which needs a terminal: drive it in a pty.
const PTY = resolve(__dirname, 'pty-run.py');
const hasPython = process.platform !== 'win32' && spawnSync('python3', ['--version']).status === 0;
const PASSWORD = 'pty-password-123';

/** A home with one wallet (cheap scrypt) and one tracked Sepolia token. */
function homeWithWallet(): { home: string; cleanup: () => void } {
  const t = tempHome();
  const dataDir = join(t.home, '.fhevm-wallet');
  mkdirSync(join(dataDir, 'wallets'), { recursive: true });
  const wallet = Wallet.createRandom();
  writeFileSync(
    join(dataDir, 'wallets', 'w.json'),
    wallet.encryptSync(PASSWORD, { scrypt: { N: 1024 } } as never),
  );
  writeFileSync(
    join(dataDir, 'wallets', 'w.meta.json'),
    JSON.stringify({ name: 'w', address: wallet.address, createdAt: '2026-01-01' }),
  );
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
  return t;
}

/** Run `fhew balance` in a pty, typing the password; resolves with output and exit code. */
function balanceInPty(home: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string; ms: number }>((done) => {
    const started = Date.now();
    const child = spawn(
      'python3',
      [PTY, PASSWORD, '45', process.execPath, CLI, 'balance', '-w', 'w', '-n', 'sepolia'],
      {
        env: { PATH: process.env.PATH ?? '', HOME: home, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => done({ code, out, ms: Date.now() - started }));
  });
}

describe.skipIf(!hasPython)('`fhew balance` in a terminal against RPC errors', () => {
  it.each([['0'], ['1']])(
    'a 500 that echoes the request path shows no key (FHEW_DEBUG=%s)',
    async (debug) => {
      const t = homeWithWallet();
      try {
        const res = await balanceInPty(t.home, {
          SEPOLIA_RPC_URL: keyUrl(echoBase),
          FHEW_DEBUG: debug,
        });
        expect(res.code).toBe(1);
        expect(res.out).toMatch(/Wallet loaded/); // the password prompt was answered
        expect(res.out).toMatch(/Could not reach the network/);
        if (debug === '1') expect(res.out).toMatch(/Technical details: .*500/);
        expect(res.out).not.toContain(KEY);
        expect(res.out).not.toContain(QKEY);
        if (debug === '0') expect(res.out).not.toMatch(/server response 500/);
      } finally {
        t.cleanup();
      }
    },
  );

  it('an RPC that never answers ends with plain words and exit 1, promptly', async () => {
    const t = homeWithWallet();
    try {
      const res = await balanceInPty(t.home, { SEPOLIA_RPC_URL: keyUrl(stallBase) });
      expect(res.ms).toBeLessThan(40_000);
      expect(res.code).toBe(1);
      expect(res.out).toMatch(/Could not reach the network/);
      expect(res.out).not.toContain(KEY);
    } finally {
      t.cleanup();
    }
  });
});

// The sweep past the password prompt: every way a provider echoes the request back, for
// the commands that load the wallet. None of the output may contain the path key or the
// query key, with or without FHEW_DEBUG.
type EchoMode = '500' | 'chain-then-500' | 'rpc-error' | '429';
let echoAny: Server;
let echoAnyBase = '';
let mode: EchoMode = '500';

beforeAll(async () => {
  echoAny = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msgs = [JSON.parse(body || '{}')].flat() as { id: number; method: string }[];
      const echo = `internal error for ${req.url} key=${KEY}`;
      res.setHeader('content-type', 'application/json');
      if (mode === 'chain-then-500' && msgs.every((m) => m.method === 'eth_chainId')) {
        const reply = (m: { id: number }) => ({ jsonrpc: '2.0', id: m.id, result: '0xaa36a7' });
        res.end(JSON.stringify(msgs.length === 1 ? reply(msgs[0]) : msgs.map(reply)));
        return;
      }
      if (mode === 'rpc-error') {
        const reply = (m: { id: number; method: string }) =>
          m.method === 'eth_chainId'
            ? { jsonrpc: '2.0', id: m.id, result: '0xaa36a7' }
            : {
                jsonrpc: '2.0',
                id: m.id,
                error: { code: -32000, message: `invalid api key ${echo}` },
              };
        res.end(JSON.stringify(msgs.length === 1 ? reply(msgs[0]) : msgs.map(reply)));
        return;
      }
      res.statusCode = mode === '429' ? 429 : 500;
      if (mode === '429') res.setHeader('retry-after', '0');
      res.end(JSON.stringify({ error: echo }));
    });
  });
  await new Promise<void>((r) => echoAny.listen(0, '127.0.0.1', () => r()));
  echoAnyBase = `http://127.0.0.1:${port(echoAny)}`;
});
afterAll(() => echoAny.close());

/** Run any CLI command in a pty, typing the password when asked. */
function inPty(home: string, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn('python3', [PTY, PASSWORD, '45', process.execPath, CLI, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: home, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => done({ code, out }));
  });
}

describe.skipIf(!hasPython)('secrets sweep past the password prompt', () => {
  const modes: EchoMode[] = ['500', 'chain-then-500', 'rpc-error', '429'];
  it.each(modes)(
    'balance and send against an RPC that echoes the key (%s)',
    async (m) => {
      mode = m;
      const t = homeWithWallet();
      try {
        for (const debug of ['0', '1']) {
          const env = { SEPOLIA_RPC_URL: keyUrl(echoAnyBase), FHEW_DEBUG: debug };
          const runs = [
            await inPty(t.home, ['balance', '-w', 'w', '-n', 'sepolia'], env),
            await inPty(
              t.home,
              ['send', '0x000000000000000000000000000000000000dEaD', '1', '-t', TOKEN, '-w', 'w'],
              env,
            ),
          ];
          for (const res of runs) {
            expect(res.out).toMatch(/Wallet loaded/); // got past the password prompt
            expect(res.code).toBe(1);
            expect(res.out).not.toContain(KEY);
            expect(res.out).not.toContain(QKEY);
          }
        }
      } finally {
        t.cleanup();
      }
    },
    150_000,
  );
});
