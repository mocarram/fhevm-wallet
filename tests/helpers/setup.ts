import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll } from 'vitest';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'fhevm-wallet-tests-'));

process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

delete process.env.MAINNET_RPC_URL;
delete process.env.SEPOLIA_RPC_URL;
delete process.env.ETHERSCAN_API_KEY;
delete process.env.ZAMA_MAINNET_API_KEY;
delete process.env.OVERRIDE_NETWORK;

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});
