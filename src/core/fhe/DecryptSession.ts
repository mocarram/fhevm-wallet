/**
 * One signature decrypts everything: a session-scoped user-decrypt authorisation.
 *
 * Zama's "user decrypt" needs an ML-KEM keypair and an EIP-712 signature by the wallet
 * over (public key, contract list, start, duration). Signing per balance meant one
 * keypair and one signature per token on every refresh. A `DecryptSession` signs once
 * for every tracked contract and reuses that authorisation for balances and transfer
 * amounts until the token set changes or the signature is about to expire.
 *
 * It lives in memory only and belongs to one unlocked wallet on one network. Whoever
 * holds the unlocked wallet also holds the session and must `clear()` it on lock,
 * auto-lock, wallet switch and exit. Nothing here is ever written to disk.
 *
 * Relayer SDK limits (read from @zama-fhe/relayer-sdk 0.4.5, lib/node.cjs):
 * - `contractAddresses` per signature/request: at most 10 (MAX_USER_DECRYPT_CONTRACT_ADDRESSES)
 * - encrypted bits per userDecrypt request: at most 2048 (check2048EncryptedBits), i.e.
 *   32 euint64 handles
 * - durationDays: 1..365, and startTimestamp must not be in the future
 * So contracts are signed in groups of 10 and handles are sent in batches of ≤ 2048 bits.
 */

import type { HDNodeWallet, Wallet } from 'ethers';
import type { NetworkName } from '../network/NetworkConfig.js';

/** Most contract addresses one user-decrypt signature may cover (SDK limit). */
export const MAX_CONTRACTS_PER_SIGNATURE = 10;
/** Most encrypted bits one userDecrypt request may carry (SDK limit). */
export const MAX_BITS_PER_REQUEST = 2048;
/** Default validity of the signature. Short: the session is dropped on lock anyway. */
export const DEFAULT_DECRYPT_DAYS = 1;
/** Re-sign this long before the signature expires, so a request never races the expiry. */
const EXPIRY_MARGIN_S = 10 * 60;

/** Bits per FHE type id (the handle's byte 30), as the SDK counts them. */
const TYPE_BITS: Record<number, number> = {
  0: 2,
  2: 8,
  3: 16,
  4: 32,
  5: 64,
  6: 128,
  7: 160,
  8: 256,
};

/** A ciphertext handle (bytes32 hex) and the contract that holds it. */
export interface HandlePair {
  handle: string;
  contractAddress: string;
}

/** A signed user-decrypt authorisation for up to 10 contracts. */
export interface DecryptAuth {
  publicKey: string;
  /** ML-KEM private key for this session only; not the wallet key. Memory only. */
  privateKey: string;
  signature: string;
  /** Checksummed or lowercase as given; compared lowercase. */
  contracts: string[];
  userAddress: string;
  startTimestamp: number;
  durationDays: number;
}

/**
 * What a session needs from the outside world. The real one talks to the Zama relayer
 * SDK (`RealBackend`); the mock one simulates it (`MockBackend`).
 */
export interface DecryptAuthority {
  /** Fresh keypair + EIP-712 for `contracts`, signed by `signer`. */
  authorize(
    signer: Wallet | HDNodeWallet,
    contracts: string[],
    startTimestamp: number,
    durationDays: number,
  ): Promise<DecryptAuth>;
  /** One userDecrypt request. Every pair's contract is in `auth.contracts`. */
  userDecrypt(auth: DecryptAuth, pairs: HandlePair[]): Promise<Record<string, bigint>>;
}

/** Result of `DecryptSession.decrypt`: values and errors by lowercase handle. */
export interface DecryptOutcome {
  values: Map<string, bigint>;
  errors: Map<string, unknown>;
}

/**
 * Longest validity `FHEW_DECRYPT_DAYS` may ask for. The signed authorisation lets anyone
 * holding it (and the session keypair) decrypt this wallet's balances until it expires,
 * so a leaked one should not stay useful for a year.
 */
export const MAX_DECRYPT_DAYS = 30;

/** Validity in days from `FHEW_DECRYPT_DAYS` (1-30), else the default. */
export function decryptDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FHEW_DECRYPT_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DECRYPT_DAYS ? n : DEFAULT_DECRYPT_DAYS;
}

/** Encrypted bits of a handle, from its type byte. Unknown types count as 256. */
export function handleBits(handle: string): number {
  const h = handle.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const type = parseInt(h.slice(60, 62), 16);
  return TYPE_BITS[type] ?? 256;
}

/** Split pairs into requests of at most `maxBits` encrypted bits each, keeping order. */
export function chunkByBits(pairs: HandlePair[], maxBits = MAX_BITS_PER_REQUEST): HandlePair[][] {
  const out: HandlePair[][] = [];
  let cur: HandlePair[] = [];
  let bits = 0;
  for (const p of pairs) {
    const b = handleBits(p.handle);
    if (cur.length && bits + b > maxBits) {
      out.push(cur);
      cur = [];
      bits = 0;
    }
    cur.push(p);
    bits += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Sorted, de-duplicated lowercase addresses. */
function normalise(addresses: string[]): string[] {
  return [...new Set(addresses.map((a) => a.toLowerCase()))].sort();
}

/** Lowercase 0x-prefixed 32-byte handle. */
export function normaliseHandle(handle: string | bigint): string {
  const hex = typeof handle === 'bigint' ? handle.toString(16) : handle.replace(/^0x/i, '');
  return '0x' + hex.toLowerCase().padStart(64, '0');
}

/** A user-decrypt authorisation held for one unlocked wallet on one network. */
export class DecryptSession {
  readonly address: string;
  readonly network: NetworkName;
  private signer: Wallet | HDNodeWallet | null;
  private auths: DecryptAuth[] = [];
  /** The contract set the current signatures were made for (sorted, lowercase). */
  private signedFor: string[] = [];
  private pendingSign: Promise<void> | null = null;
  private cleared = false;
  /** How many EIP-712 signatures this session asked the wallet for (tests, debug). */
  signatures = 0;

  constructor(
    signer: Wallet | HDNodeWallet,
    network: NetworkName,
    private readonly authority: DecryptAuthority,
    private readonly opts: { durationDays?: number; now?: () => number } = {},
  ) {
    this.signer = signer;
    this.address = signer.address;
    this.network = network;
  }

  /** False once cleared: the session must not be used again. */
  get active(): boolean {
    return !this.cleared;
  }

  private nowS(): number {
    return Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
  }

  /** True when the signatures cover every contract in `wanted` and are not about to expire. */
  private covers(wanted: string[]): boolean {
    if (!this.auths.length) return false;
    const now = this.nowS();
    const fresh = this.auths.every(
      (a) => a.startTimestamp + a.durationDays * 86_400 - EXPIRY_MARGIN_S > now,
    );
    return fresh && wanted.every((c) => this.signedFor.includes(c));
  }

  /**
   * Make sure the session is signed for `contracts` (the full tracked set). Re-signs only
   * when a contract is missing or the signature is near expiry; then it signs for the new
   * set, in groups of 10 contracts (one wallet signature per group).
   */
  async ensureSigned(contracts: string[]): Promise<void> {
    const wanted = normalise(contracts);
    if (this.covers(wanted)) return;
    // Two refreshes at once (Home and History) must not ask for two signatures.
    if (this.pendingSign) {
      await this.pendingSign;
      if (this.covers(wanted)) return;
    }
    const run = this.sign(normalise([...wanted, ...this.signedFor]));
    this.pendingSign = run;
    try {
      await run;
    } finally {
      if (this.pendingSign === run) this.pendingSign = null;
    }
  }

  private async sign(all: string[]): Promise<void> {
    if (this.cleared || !this.signer) throw new Error('The wallet is locked.');
    const days = this.opts.durationDays ?? DEFAULT_DECRYPT_DAYS;
    const start = this.nowS();
    const auths: DecryptAuth[] = [];
    for (let i = 0; i < all.length; i += MAX_CONTRACTS_PER_SIGNATURE) {
      const group = all.slice(i, i + MAX_CONTRACTS_PER_SIGNATURE);
      auths.push(await this.authority.authorize(this.signer, group, start, days));
      this.signatures += 1;
    }
    if (this.cleared) return; // locked while signing: keep nothing
    this.auths = auths;
    this.signedFor = all;
  }

  /**
   * Decrypt `pairs` with as few requests as the SDK limits allow. `contracts` is the full
   * set to sign for (normally every tracked token), so a later call for another token
   * does not need a new signature. A failed request marks its handles in `errors`; other
   * requests still run.
   */
  async decrypt(pairs: HandlePair[], contracts: string[] = []): Promise<DecryptOutcome> {
    const values = new Map<string, bigint>();
    const errors = new Map<string, unknown>();
    if (!pairs.length) return { values, errors };
    const unique = new Map<string, HandlePair>();
    for (const p of pairs) {
      const handle = normaliseHandle(p.handle);
      unique.set(handle, { handle, contractAddress: p.contractAddress });
    }
    const list = [...unique.values()];
    await this.ensureSigned([...contracts, ...list.map((p) => p.contractAddress)]);

    // Requests are per signature (its contract group), then per 2048-bit batch.
    const byAuth = new Map<DecryptAuth, HandlePair[]>();
    for (const p of list) {
      const c = p.contractAddress.toLowerCase();
      const auth = this.auths.find((a) => a.contracts.some((x) => x.toLowerCase() === c));
      if (!auth) {
        errors.set(p.handle, new Error('No decrypt authorisation for this contract.'));
        continue;
      }
      byAuth.set(auth, [...(byAuth.get(auth) ?? []), p]);
    }
    for (const [auth, group] of byAuth) {
      for (const batch of chunkByBits(group)) {
        if (this.cleared) throw new Error('The wallet is locked.');
        try {
          const res = await this.authority.userDecrypt(auth, batch);
          const lower = new Map(Object.entries(res).map(([k, v]) => [k.toLowerCase(), v]));
          for (const p of batch) {
            const v = lower.get(p.handle);
            if (v === undefined) errors.set(p.handle, new Error('No result for this handle.'));
            else values.set(p.handle, v);
          }
        } catch (err) {
          for (const p of batch) errors.set(p.handle, err);
        }
      }
    }
    return { values, errors };
  }

  /** Forget the keypair and signatures. Called on lock, auto-lock, wallet switch and exit. */
  clear(): void {
    this.cleared = true;
    this.signer = null;
    for (const a of this.auths) {
      a.privateKey = '';
      a.signature = '';
    }
    this.auths = [];
    this.signedFor = [];
  }
}
