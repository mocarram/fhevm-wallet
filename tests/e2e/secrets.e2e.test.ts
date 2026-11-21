import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { Wallet } from 'ethers';
import { join, sep } from 'path';
import { CLI, runCliAsync, tempHome } from './helpers.js';
import { spawn, spawnSync } from 'child_process';

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

  it('`fhew config --show` shows the RPC URL in effect and where it comes from', async () => {
    const t = tempHome();
    try {
      const project = join(t.home, 'project');
      mkdirSync(project);
      writeFileSync(
        join(project, '.env'),
        `SEPOLIA_RPC_URL=https://rpc.cwd.example/v3/${KEY}\nMAINNET_RPC_URL=http://remote.example/${KEY}\n`,
      );
      const res = await runCliAsync(['config', '--show'], t.home, {}, 30_000, project);
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(
        /Sepolia: https:\/\/rpc\.cwd\.example\/… \(custom, from \.\/\.env\)/,
      );
      // Plain http to a remote host is refused, so mainnet stays on the default.
      expect(res.stderr).toMatch(/Ignored MAINNET_RPC_URL in \.\/\.env: .*https/);
      expect(res.stdout).toMatch(/Mainnet: .* \(default\)/);
      expect(res.stdout + res.stderr).not.toContain(KEY);
    } finally {
      t.cleanup();
    }
  });

  it('a plain-http remote RPC URL from the environment is ignored, and --show says so', async () => {
    const t = tempHome();
    try {
      const res = await runCliAsync(['config', '--show'], t.home, {
        SEPOLIA_RPC_URL: `http://remote.example/v2/${KEY}`,
      });
      expect(res.code).toBe(0);
      expect(res.stderr).toMatch(/Ignored SEPOLIA_RPC_URL: Use an https:\/\/ URL/);
      expect(res.stdout).toMatch(
        /Sepolia: \S+ \(default; SEPOLIA_RPC_URL from the environment ignored: Use an https/,
      );
      expect(res.stdout).not.toMatch(/custom/);
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

  // The sweep: run a batch of commands with every kind of secret in play (a private key in
  // a keystore, its password, API keys, a key-bearing RPC URL that fails), then check that
  // none of them appears in anything the CLI printed or in any file it wrote. The key is
  // only in the keystore, encrypted; API keys only in the owner-only .env.
  // Without a terminal, balance and send stop at the password prompt here; the pty sweep
  // in rpc-errors.e2e.test.ts drives them past it against servers that echo the key.
  it('no command prints or stores a private key, password or API key in plain text', async () => {
    const t = tempHome();
    try {
      const PK = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const PASSWORD = 'sweep-password-0987';
      const ETHERSCAN = 'SWEEPETHERSCANKEY0123';
      const RPCKEY = 'SWEEPRPCKEY0123456789';
      const dataDir = join(t.home, '.fhevm-wallet');
      const wallet = new Wallet(PK);
      mkdirSync(join(dataDir, 'wallets'), { recursive: true });
      // Lowest scrypt cost: the test only needs a real keystore, not a strong one.
      writeFileSync(
        join(dataDir, 'wallets', 'sweep.json'),
        wallet.encryptSync(PASSWORD, { scrypt: { N: 1024 } } as never),
      );
      writeFileSync(
        join(dataDir, 'wallets', 'sweep.meta.json'),
        JSON.stringify({ name: 'sweep', address: wallet.address, createdAt: '2026-01-01' }),
      );
      writeFileSync(
        join(dataDir, 'tokens.json'),
        JSON.stringify({
          tokens: [
            {
              address: '0xde709f2102306220921060314715629080e2fb77',
              name: 'Test',
              symbol: 'TST',
              decimals: 6,
              network: 'sepolia',
              addedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      );
      const rpcEnv = { SEPOLIA_RPC_URL: `${base}/v2/${RPCKEY}?apikey=${RPCKEY}` };
      const runs: [string[], Record<string, string>][] = [
        [['wallet', 'list', '--full'], rpcEnv],
        [['wallet', 'export', 'sweep', '--keystore', join(t.home, 'backup.json')], rpcEnv],
        [['token', 'add', '0x000000000000000000000000000000000000bEEF', '-n', 'sepolia'], rpcEnv],
        [['balance', '-w', 'sweep', '-n', 'sepolia'], rpcEnv],
        [['send', '0x000000000000000000000000000000000000dEaD', '1', '-w', 'sweep'], rpcEnv],
        [['history', '-a', wallet.address, '-n', 'sepolia'], rpcEnv],
        [['config', '--rpc-sepolia', rpcEnv.SEPOLIA_RPC_URL], {}],
        [['config', '--etherscan-key', ETHERSCAN], {}],
        [['config', '--show'], {}],
        [['token', 'list'], {}],
      ];
      let printed = '';
      for (const [args, env] of runs) {
        const res = await runCliAsync(args, t.home, env, 40_000);
        printed += `\n$ fhew ${args[0]} ${args[1]}\n${res.stdout}${res.stderr}`;
      }
      // Only the subcommand goes into the transcript: some arguments are secrets.
      expect(printed).toContain(wallet.address); // the runs did something
      const secrets = [PK, PK.slice(2), PASSWORD, ETHERSCAN, RPCKEY];
      for (const secret of secrets) expect(printed).not.toContain(secret);

      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
        );
      for (const file of [...walk(dataDir), join(t.home, 'backup.json')]) {
        const text = readFileSync(file, 'utf-8');
        // The owner-only .env is where saved API keys and RPC URLs belong.
        const allowed = file.endsWith(`${sep}.env`) ? [ETHERSCAN, RPCKEY] : [];
        for (const secret of secrets.filter((x) => !allowed.includes(x))) {
          expect(text, file).not.toContain(secret);
        }
      }
    } finally {
      t.cleanup();
    }
  });

  it('`--rpc-sepolia -` reads the URL from stdin and never prints it', async () => {
    const t = tempHome();
    try {
      // Async spawn: the local server in this process must be able to answer.
      const res = await new Promise<{ code: number | null; out: string; stdout: string }>(
        (done) => {
          const child = spawn(process.execPath, [CLI, 'config', '--rpc-sepolia', '-'], {
            env: { PATH: process.env.PATH ?? '', HOME: t.home, NO_COLOR: '1' },
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (c) => (stdout += c));
          child.stderr.on('data', (c) => (stderr += c));
          child.on('close', (code) => done({ code, out: stdout + stderr, stdout }));
          child.stdin.end(`${base}/v2/${KEY}?apikey=${KEY}\n`);
        },
      );
      expect(res.code).toBe(1); // the local server answers 500
      expect(res.stdout).toMatch(/returned an error \(HTTP 500\)/);
      expect(res.out).not.toContain(KEY);
    } finally {
      t.cleanup();
    }
  });

  it('two piped options in one run fail clearly for the second', () => {
    const t = tempHome();
    try {
      const res = spawnSync(
        process.execPath,
        [CLI, 'config', '--etherscan-key', '-', '--zama-key', '-'],
        {
          env: { PATH: process.env.PATH ?? '', HOME: t.home, NO_COLOR: '1' },
          input: 'ONLYONEKEY12345\n',
          encoding: 'utf-8',
          timeout: 30_000,
        },
      );
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/Etherscan API key saved/);
      expect(res.stdout).toMatch(/Only one value can be piped in per run/);
    } finally {
      t.cleanup();
    }
  });
});
