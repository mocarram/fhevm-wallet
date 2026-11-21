/**
 * Effects that read data: the local snapshot, cached balances, ETH, decrypted balances.
 */

import { peekCachedBalance } from '../../core/token/BalanceCache.js';
import { describeError } from '../errors.js';
import type { UnlockedSigner } from '../../core/backend/types.js';
import type { DecryptSession } from '../../core/fhe/DecryptSession.js';
import type { NetworkName } from '../../core/network/NetworkConfig.js';
import { effect, type Deps, type Effect } from '../effects.js';
import { loadSnapshot } from '../snapshot.js';
import {
  isUnlocked,
  lockWallet,
  sendInProgress,
  type AppState,
  type BalanceEntry,
} from '../state.js';
import { line, seg } from '../text.js';

/** Re-read wallets, contacts, tokens, prefs and cached balances from disk. */
export function reload(s: AppState): Effect {
  const network = s.network;
  const address = s.wallet?.address;
  return effect('reload', async () => {
    const data = loadSnapshot(network, address);
    const cached: Record<string, BalanceEntry> = {};
    if (address) {
      for (const t of data.tokens) {
        const peek = peekCachedBalance(address, t.address, network);
        if (peek) {
          cached[t.address.toLowerCase()] = {
            value: peek.value,
            at: peek.updatedAt?.getTime(),
            source: 'cache',
          };
        }
      }
    }
    return (st) => {
      if (st.network !== network) return; // the user switched network meanwhile
      st.data = data;
      if (st.wallet?.address !== address) return;
      // Never let an older cache value overwrite one decrypted in this session.
      for (const [k, v] of Object.entries(cached)) {
        if (!st.balances[k] || st.balances[k].source === 'cache') st.balances[k] = v;
      }
    };
  });
}

/** Fetch the ETH balance (needs no unlock). Failures leave the old value in place. */
export function refreshEth(s: AppState): Effect {
  const network = s.network;
  const address = s.wallet?.address;
  return effect('eth', async (deps) => {
    if (!address) return;
    try {
      const wei = await deps.backend.getEthBalance(address, network);
      return (st) => {
        if (st.network === network && st.wallet?.address === address) {
          st.eth = { wei, at: deps.now() };
        }
      };
    } catch {
      return; // the status bar keeps showing the last known value (or "…")
    }
  });
}

/**
 * The decrypt session for the unlocked wallet, created on first use. Runs inside an
 * effect: `dispatch` applies at once, so two effects racing here share one session (and
 * one signature). Null when the wallet was locked or switched meanwhile.
 */
export function sessionOf(
  deps: Deps,
  signer: UnlockedSigner,
  network: NetworkName,
): DecryptSession | null {
  let session: DecryptSession | null = null;
  deps.dispatch((st) => {
    if (st.signer !== signer || st.network !== network) return;
    const cur = st.decryptSession;
    if (!cur || !cur.active || cur.network !== network || cur.address !== signer.address) {
      cur?.clear();
      st.decryptSession = deps.backend.newDecryptSession(signer, network);
    }
    session = st.decryptSession;
  });
  return session;
}

/**
 * Decrypt every tracked token's balance in the background (and refresh ETH): one
 * signature for all of them and one batched relayer request. Needs the wallet unlocked;
 * returns no effects otherwise. Old values stay on screen with a spinner per row while
 * this runs, so it never blocks input. `force` skips the handle-based cache.
 */
export function decryptAll(s: AppState, force = false): Effect[] {
  if (!isUnlocked(s) || !s.wallet) return [];
  const network = s.network;
  const signer = s.signer!;
  const tokens = s.data.tokens.map((t) => ({ address: t.address, symbol: t.symbol }));
  const lockAfter = s.data.prefs.unlockMinutes === 0;
  if (tokens.length === 0) return [refreshEth(s)];
  s.decrypting = true;
  for (const t of tokens) s.refreshing[t.address.toLowerCase()] = true;
  return [
    refreshEth(s),
    effect('decrypt', async (deps) => {
      const readiness = deps.backend.readinessProblem(network);
      let results: Record<string, bigint> = {};
      const failures: string[] = [];
      if (!readiness) {
        const session = sessionOf(deps, signer, network);
        if (session) {
          const batch = await deps.backend.decryptBalances(
            session,
            tokens.map((t) => t.address),
            { forceRefresh: force },
          );
          results = batch.values;
          for (const t of tokens) {
            const err = batch.errors[t.address.toLowerCase()];
            if (err !== undefined) {
              failures.push(`${t.symbol}: ${describeError(err, { action: 'decrypt' }).title}`);
            }
          }
        }
      }
      const at = deps.now();
      return (st) => {
        st.decrypting = false;
        for (const t of tokens) delete st.refreshing[t.address.toLowerCase()];
        if (st.network !== network) return;
        for (const [k, value] of Object.entries(results)) {
          st.balances[k] = { value, at, source: 'session' };
        }
        if (readiness) {
          st.flash = [line('  ', seg(readiness, 'yellow'))];
        } else if (failures.length) {
          st.flash = [
            line('  ', seg("! Couldn't decrypt every balance:", 'yellow')),
            ...failures.map((f) => line(seg(`    ${f}`, 'dim'))),
          ];
        }
        // "Every action": lock once done, unless a send is being reviewed or signed with
        // this unlock (the send locks itself once it is broadcast or cancelled).
        if (lockAfter && st.signer === signer && st.countdown === null && !sendInProgress(st)) {
          lockWallet(st);
        }
      };
    }),
  ];
}

/** Lock now (the `L` key): drop the decrypted wallet and anything signed with it. */
export function lockNow(s: AppState, reason = 'Locked.'): void {
  if (!s.wallet) return;
  // Also drops any prepared transfer, so nothing can be sent without the password again.
  lockWallet(s);
  s.flash = [
    line('  ', seg(`${reason} Your password is needed for the next send or decrypt.`, 'yellow')),
  ];
}
