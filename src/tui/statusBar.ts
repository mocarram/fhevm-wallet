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

/**
 * Render the status bar to exactly `cols` columns (or fewer when cols is tiny).
 *
 * Each part is a "pill" with its own background (docs/ui-design.md): brand, breadcrumb on
 * the plain bar, pending, network, wallet (name bold, address softer), lock state (green
 * unlocked, brown locked) and ETH (indigo; yellow when low). Without colour (NO_COLOR) it
 * is plain text, so nothing depends on colour alone.
 */
export function statusBar(s: AppState, cols: number): Line {
  const brand = seg(' fhEVM Wallet ', 'brand');
  const crumb = breadcrumb(s);
  const right: Seg[] = [];
  if (s.pending.length)
    right.push(seg(` ${spinner(s.now)} ${s.pending.length} pending `, 'pending'));
  right.push(s.network === 'mainnet' ? seg(' MAINNET ', 'mainnet') : seg(' Sepolia ', 'net'));

  // The wallet pill is the name (bold) plus, when it fits, the short address in a softer
  // shade on the same background.
  let walletSegs: Seg[] = [];
  let nameOnly: Seg[] = [];
  let lockSeg: Seg | null = null;
  let ethSeg: Seg | null = null;
  if (!s.wallet) {
    walletSegs = nameOnly = [seg(' no wallet yet ', 'wallet')];
  } else {
    walletSegs = [
      seg(` ${s.wallet.name} `, 'wallet'),
      seg(`${shortAddress(s.wallet.address)} `, 'walletAddr'),
    ];
    nameOnly = [seg(` ${s.wallet.name} `, 'wallet')];
    if (isUnlocked(s)) {
      // Minutes left, rounded up (15m for the whole first minute after a 15-minute
      // unlock) but never above the setting: the expiry is set a moment after the frame's
      // clock, which made it read 16m. "<1m" in the last minute.
      const left = s.unlockedUntil! - s.now;
      const mins = Math.ceil(left / 60_000);
      const cap = s.data.prefs.unlockMinutes > 0 ? s.data.prefs.unlockMinutes : mins;
      lockSeg = seg(
        left < 60_000 ? ' unlocked <1m ' : ` unlocked ${Math.min(mins, cap)}m `,
        'unlocked',
      );
    } else {
      lockSeg = seg(' locked ', 'locked');
    }
    ethSeg = s.eth
      ? seg(` ${formatEth(s.eth.wei)} ETH `, isLowGas(s) ? 'low' : 'eth')
      : seg(' … ETH ', 'eth dim');
  }

  // The mock badge sits right after the brand, on the left, so it survives any shrinking
  // or clipping: nobody should mistake the simulation for real funds (or the reverse).
  const mockLong = seg(' MOCK · simulated, no real funds ', 'mock');
  const mockShort = seg(' MOCK ', 'mock');

  const build = (crumbText: string, withAddr: boolean, longMock = true): Line => {
    const head: Seg[] = [brand];
    if (s.backendKind === 'mock') head.push(longMock ? mockLong : mockShort);
    const parts: Seg[] = [...right];
    parts.push(...(withAddr ? walletSegs : nameOnly));
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
