/**
 * The status bar on top of every screen:
 * brand, [MOCK badge], breadcrumb, pending spinner, network badge, wallet, lock state, ETH.
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
  const crumb = typeof def?.crumb === 'function' ? def.crumb(s) : (def?.crumb ?? []);
  const parts = [...root, ...crumb];
  return parts.length ? parts.join(' › ') : 'Home';
}

/** Render the status bar to exactly `cols` columns (or fewer when cols is tiny). */
export function statusBar(s: AppState, cols: number): Line {
  const brand = seg(' fhEVM Wallet ', 'bar bold');
  const crumb = breadcrumb(s);
  const right: Seg[] = [];
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
      // Minutes left, rounded up (15m for the whole first minute after a 15-minute
      // unlock) but never above the setting: the expiry is set a moment after the frame's
      // clock, which made it read 16m. "<1m" in the last minute.
      const left = s.unlockedUntil! - s.now;
      const mins = Math.ceil(left / 60_000);
      const cap = s.data.prefs.unlockMinutes > 0 ? s.data.prefs.unlockMinutes : mins;
      lockSeg = seg(
        left < 60_000 ? 'unlocked <1m ' : `unlocked ${Math.min(mins, cap)}m `,
        'bar dim',
      );
    } else {
      lockSeg = seg('locked ', 'bar dim');
    }
    ethSeg = s.eth
      ? seg(` ${formatEth(s.eth.wei)} ETH `, isLowGas(s) ? 'low' : 'bar')
      : seg(' … ETH ', 'bar dim');
  }

  // The mock badge sits right after the brand, on the left, so it survives any shrinking
  // or clipping: nobody should mistake the simulation for real funds (or the reverse).
  const mockLong = seg(' MOCK · simulated, no real funds ', 'mock');
  const mockShort = seg(' MOCK ', 'mock');

  const build = (crumbText: string, withAddr: boolean, longMock = true): Line => {
    const head: Seg[] = [brand];
    if (s.backendKind === 'mock') head.push(longMock ? mockLong : mockShort);
    const parts: Seg[] = [...right];
    if (walletSeg) {
      parts.push(withAddr || !s.wallet ? walletSeg : seg(` ${s.wallet.name} `, 'bar'));
    }
    if (lockSeg) parts.push(lockSeg);
    if (ethSeg) parts.push(ethSeg);
    const crumbSeg = seg(` ${crumbText} `, 'bar');
    const used = lineWidth([...head, crumbSeg, ...parts]);
    const gap = Math.max(1, cols - used);
    return [...head, { ...crumbSeg, t: crumbSeg.t + ' '.repeat(gap) }, ...parts];
  };

  // Shrink in steps until it fits: drop the address, then shorten the breadcrumb.
  const last = crumb.split(' › ').slice(-1)[0];
  const attempts = [
    build(crumb, true),
    build(crumb, false),
    build(last, false),
    build(last, false, false),
  ];
  for (const attempt of attempts) {
    if (lineWidth(attempt) <= cols) return attempt;
  }
  return build(last, false, false);
}
