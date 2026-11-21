/**
 * Find tokens (Tokens › Find tokens): run `findTokens` through the backend with live
 * progress, let the user stop the scan with Esc, then bulk-add the picked candidates.
 */

import { findTokens, type TokenCandidate } from '../../core/token/findTokens.js';
import { addTokenWithInfo } from '../../core/token/TokenRegistry.js';
import { effect, type Effect } from '../effects.js';
import { popTo } from '../nav.js';
import { top, type AppState } from '../state.js';
import { dimLine, line, seg } from '../text.js';
import { decryptAll, reload } from './data.js';

/**
 * The running scan's controller. Only one Find runs at a time; an AbortController is
 * not plain data, so it lives here rather than in AppState.
 */
let running: AbortController | null = null;

/** Candidates the list offers: everything that can be added. */
export function selectableCandidates(s: AppState): TokenCandidate[] {
  return (s.find?.result?.candidates ?? []).filter(
    (c) => c.status === 'verified' || c.status === 'unverified',
  );
}

/** Start (or restart) Find tokens for the current wallet and network. */
export function startFind(s: AppState): Effect[] {
  const wallet = s.wallet;
  const network = s.network;
  running?.abort();
  if (!wallet) {
    s.find = { phase: 'done', error: 'Create or pick a wallet first.' };
    return [];
  }
  const ac = new AbortController();
  running = ac;
  s.find = { phase: 'scanning' };
  return [
    effect('find-tokens', async (deps) => {
      try {
        const result = await findTokens(deps.backend, wallet.address, network, {
          signal: ac.signal,
          onProgress: (p) =>
            deps.dispatch((st) => {
              if (st.find && running === ac) st.find.progress = p;
            }),
          onChecking: () =>
            deps.dispatch((st) => {
              if (st.find && running === ac) st.find.phase = 'checking';
            }),
        });
        return (st) => {
          if (running !== ac) return;
          running = null;
          st.find = { phase: 'done', result };
          // Pre-select verified candidates (known list + check passed), never others.
          const f = st.stack.find((fr) => fr.id === 'token-find');
          if (f) {
            f.params.picked = result.candidates
              .filter((c) => c.status === 'verified')
              .map((c) => c.address)
              .join(',');
            f.cur = 0;
          }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return (st) => {
          if (running !== ac) return;
          running = null;
          st.find = { phase: 'done', error: `Couldn't look for tokens: ${message}` };
        };
      }
    }),
  ];
}

/** Stop a running scan (Esc). Progress so far is saved and its finds are listed. */
export function stopFind(s: AppState): void {
  if (running && s.find && s.find.phase === 'scanning') {
    running.abort();
    s.flash = [dimLine('  Stopping the scan. What was scanned so far is saved.')];
  }
}

/** Leaving the screen stops the scan too. */
export function abandonFind(): void {
  running?.abort();
  running = null;
}

/** Add the picked candidates (Enter on the Find tokens list). */
export function addFound(s: AppState, ids: string[]): Effect[] {
  const network = s.network;
  const picks = selectableCandidates(s).filter((c) => ids.includes(c.address));
  return [
    effect('add-found-tokens', async () => {
      const added: string[] = [];
      const failed: string[] = [];
      for (const c of picks) {
        try {
          if (!c.check?.info) throw new Error('no token info');
          addTokenWithInfo(c.check.info, network);
          added.push(c.symbol);
        } catch {
          failed.push(c.symbol);
        }
      }
      return (st) => {
        st.find = null;
        popTo(st, 'tokens');
        st.flash = [
          ...(added.length ? [line('  ', seg(`✔ Added ${added.join(', ')}.`, 'green'))] : []),
          ...(failed.length
            ? [line('  ', seg(`✗ Could not add ${failed.join(', ')}.`, 'red'))]
            : []),
        ];
        return [reload(st), ...decryptAll(st)];
      };
    }),
  ];
}

/** True while the Find tokens screen is busy (the shell animates the spinner). */
export function findBusy(s: AppState): boolean {
  return top(s).id === 'token-find' && s.find !== null && s.find.phase !== 'done';
}
