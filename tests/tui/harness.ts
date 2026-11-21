/**
 * Test harness for the TUI's pure core: a real AppState, the offline MockBackend with no
 * delays, and an effect runner that awaits every effect (and the effects they return)
 * so a test can press keys and then look at the rendered screen as plain text.
 */

import { Wallet } from 'ethers';
import { MockBackend, type MockOptions } from '../../src/core/backend/MockBackend.js';
import { addTokenWithInfo } from '../../src/core/token/TokenRegistry.js';
import { addAddress } from '../../src/storage/AddressBook.js';
import { handleKey, render, tick } from '../../src/tui/app.js';
import type { Deps, Effect, Updater } from '../../src/tui/effects.js';
import { normalizeKey } from '../../src/tui/keys.js';
import { loadSnapshot } from '../../src/tui/snapshot.js';
import { initialState, type AppState } from '../../src/tui/state.js';
import { plain } from '../../src/tui/text.js';

export const BOB = '0x91Be4C2a6d0f83B1e7c5a9d2f4E8b0C6D3d207AF';
/** Same first and last 4 hex characters as BOB, different address. */
export const BOB_LOOKALIKE = '0x91bE9f71c0aE2B58d4a3f6C0B9e1D7a5f33207Af';
export const STRANGER = '0x6e1d3a0B7C25F9e84d1a6b3c0e7F52a9d8c194fa';

/** Seed the (test) data dir with bob and the mock cUSDC token. */
export function seedData(backend: MockBackend): void {
  addAddress('bob', BOB);
  addTokenWithInfo(backend.catalogue('sepolia')[0], 'sepolia');
}

export interface HarnessOptions {
  mock?: Partial<MockOptions>;
  /** Start with this wallet in state (no keystore on disk); default: a random one. */
  unlocked?: boolean;
  noWallet?: boolean;
  seed?: boolean;
}

/** Drives one AppState like the shell does, without a terminal. */
export class Harness {
  readonly backend: MockBackend;
  readonly s: AppState;
  readonly signer = Wallet.createRandom();
  now = 1_000_000;
  queue: Effect[] = [];
  /** Effect kinds run so far, in order. */
  ran: string[] = [];
  secrets: Array<{ title: string; lines: string[] }> = [];
  quitCalled = false;
  readonly deps: Deps;

  constructor(opts: HarnessOptions = {}) {
    this.backend = new MockBackend({ latencyMs: 0, confirmMs: 0, sleep: async () => {}, ...opts.mock });
    if (opts.seed !== false) seedData(this.backend);
    const data = loadSnapshot('sepolia');
    this.s = initialState({ network: 'sepolia', backendKind: 'mock', data, now: this.now });
    if (!opts.noWallet) {
      this.s.wallet = { name: 'alice', address: this.signer.address };
      this.s.stack = [{ id: 'home', cur: 0, params: {} }];
      this.s.setup = false;
      if (opts.unlocked) this.unlock();
    }
    this.deps = {
      backend: this.backend,
      dispatch: (u) => this.apply(u),
      showSecret: async (title, lines) => {
        this.secrets.push({ title, lines });
      },
      copyToClipboard: () => true,
      now: () => this.now,
    };
  }

  /** Put the decrypted key in memory as a successful unlock would. */
  unlock(minutes = 15): void {
    this.s.signer = this.signer;
    this.s.unlockedUntil = this.now + minutes * 60_000;
  }

  apply(u: Updater | void): void {
    if (!u) return;
    const more = u(this.s);
    if (more) this.queue.push(...more);
  }

  /** Press keys. Strings of several characters are typed one character at a time,
   *  except names in braces: {enter} {escape} {up} {down} {ctrl-c} {backspace} {space}. */
  press(...keys: string[]): this {
    for (const k of keys) {
      const parts = k.match(/\{[a-z-]+\}|[\s\S]/gu) ?? [];
      for (const p of parts) {
        const key = p.startsWith('{') ? (p === '{space}' ? ' ' : p.slice(1, -1)) : p;
        this.s.now = this.now;
        this.queue.push(...handleKey(this.s, key));
      }
    }
    return this;
  }

  /** Run queued effects (and their follow-ups) to completion. */
  async settle(): Promise<this> {
    for (let guard = 0; this.queue.length && guard < 500; guard++) {
      const e = this.queue.shift()!;
      this.ran.push(e.kind);
      if (e.kind === 'quit') {
        this.quitCalled = true;
        this.s.quit = true;
        continue;
      }
      this.apply(await e.run(this.deps));
    }
    return this;
  }

  /** Press keys, then settle. */
  async keys(...keys: string[]): Promise<this> {
    this.press(...keys);
    return this.settle();
  }

  /** Advance the clock and tick. */
  async advance(ms: number): Promise<this> {
    this.now += ms;
    this.queue.push(...tick(this.s, this.now));
    return this.settle();
  }

  /** The screen as plain text. */
  text(cols = 100, rows = 40): string {
    return render(this.s, { cols, rows }).map(plain).join('\n');
  }

  get screen(): string {
    return this.s.stack[this.s.stack.length - 1].id;
  }
}

export { normalizeKey };
