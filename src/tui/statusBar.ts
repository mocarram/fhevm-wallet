/**
 * The status bar on top of every screen:
 * brand, breadcrumb, [MOCK], pending spinner, network badge, wallet, lock state, ETH.
 */

import { shortAddress } from '../core/send/recipient.js';
import { inSetup, isUnlocked, top, type AppState } from './state.js';
import { lineWidth, seg, type Line, type Seg } from './text.js';
import { SCREENS } from './screens/registry.js';
import { formatEth, isLowGas, spinner } from './format.js';

/** The breadcrumb for the current screen, e.g. "Home › Send › Review". */
export function breadcrumb(s: AppState): string {
  const def = SCREENS[top(s).id];
  const root = inSetup(s) ? [] : ['Home'];
  const parts = [...root, ...(def?.crumb ?? [])];
  return parts.length ? parts.join(' › ') : 'Home';
}

/** Render the status bar to exactly `cols` columns (or fewer when cols is tiny). */
export function statusBar(s: AppState, cols: number): Line {
  const brand = seg(' fhEVM Wallet ', 'bar bold');
  const crumb = breadcrumb(s);
  const right: Seg[] = [];
  if (s.backendKind === 'mock') right.push(seg(' MOCK ', 'mock'));
  if (s.pending.length)
    right.push(seg(` ${spinner(s.now)} ${s.pending.length} pending `, 'pending'));
  right.push(s.network === 'mainnet' ? seg(' MAINNET ', 'mainnet') : seg(' Sepolia ', 'net'));

  let walletSeg: Seg | null = null;
  let addrText = '';
  let lockSeg: Seg | null = null;
  let ethSeg: Seg | null = null;
  if (!s.wallet) {
    walletSeg = seg(' no wallet yet ', 'bar');
  } else {
    addrText = ` ${shortAddress(s.wallet.address)}`;
    walletSeg = seg(` ${s.wallet.name}${addrText} `, 'bar');
    if (isUnlocked(s)) {
      const mins = Math.max(1, Math.ceil((s.unlockedUntil! - s.now) / 60_000));
      lockSeg = seg(`unlocked ${mins}m `, 'bar dim');
    } else {
      lockSeg = seg('locked ', 'bar dim');
    }
    ethSeg = s.eth
      ? seg(` ${formatEth(s.eth.wei)} ETH `, isLowGas(s) ? 'low' : 'bar')
      : seg(' … ETH ', 'bar dim');
  }

  const build = (crumbText: string, withAddr: boolean): Line => {
    const parts: Seg[] = [...right];
    if (walletSeg) {
      parts.push(withAddr || !s.wallet ? walletSeg : seg(` ${s.wallet.name} `, 'bar'));
    }
    if (lockSeg) parts.push(lockSeg);
    if (ethSeg) parts.push(ethSeg);
    const crumbSeg = seg(` ${crumbText} `, 'bar');
    const used = lineWidth([brand, crumbSeg, ...parts]);
    const gap = Math.max(1, cols - used);
    return [brand, { ...crumbSeg, t: crumbSeg.t + ' '.repeat(gap) }, ...parts];
  };

  // Shrink in steps until it fits: drop the address, then shorten the breadcrumb.
  const last = crumb.split(' › ').slice(-1)[0];
  for (const attempt of [build(crumb, true), build(crumb, false), build(last, false)]) {
    if (lineWidth(attempt) <= cols) return attempt;
  }
  return build(last, false);
}
