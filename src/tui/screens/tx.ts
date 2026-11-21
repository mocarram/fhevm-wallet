/**
 * Review, Sign and countdown screens for operator changes and disclosure steps
 * (flows/tx.ts). They mirror the send wizard's: checks need the key, Confirm is explicit,
 * and the countdown can be stopped with Esc before anything is broadcast.
 */

import { afterTxUnlock, confirmTx, stopTxCountdown } from '../flows/tx.js';
import { unlock } from '../flows/wallet.js';
import { formatEth, spinner } from '../format.js';
import type { InputSpec, Item, ScreenDef } from '../screen.js';
import { goHome, isUnlocked, type AppState } from '../state.js';
import { dimLine, line, seg, type Line } from '../text.js';
import { unlockMinutesText } from './balances.js';
import { backItem, BLANK, inputLine } from './common.js';

/** Where the action came from: Tokens › Operators, or History › Disclose. */
function txCrumb(s: AppState, ...rest: string[]): string[] {
  const from = s.txAction?.kind === 'operator' ? ['Tokens', 'Operators'] : ['History', 'Disclose'];
  return [...from, ...rest];
}

export const txReviewScreen: ScreenDef = {
  crumb: (s) => txCrumb(s, 'Review'),
  view: (s) => {
    const a = s.txAction;
    if (!a)
      return { body: [dimLine('  Nothing to review.')], items: [backItem()], hint: 'esc back' };
    const t = s.data.tokens.find((x) => x.address.toLowerCase() === a.token.toLowerCase());
    const body: Line[] = [line('  ', seg(a.title, 'bold')), BLANK];
    if (a.warning) {
      for (const w of a.warning) body.push(line('  ', seg(w, 'yellow bold')));
      body.push(BLANK);
    }
    body.push(
      line('  Token     ', seg(t ? `${t.symbol} · ${t.name}` : a.token, '')),
      line('  Network   ', seg(s.network === 'mainnet' ? 'Mainnet · real funds' : 'Sepolia', '')),
    );
    if (a.operator) body.push(line('  Operator  ', seg(a.operator, 'bold')));
    if (a.details) body.push(...a.details(a.prepared));
    if (a.prepared) {
      body.push(
        // The same wording as the send Review.
        line(
          `  Fee       ≈ ${formatEth(a.prepared.feeWei)} ETH`,
          seg(`   you have ${formatEth(a.prepared.ethBalanceWei)} ETH`, 'dim'),
        ),
        BLANK,
        line(
          '  ',
          seg('✔ Simulation passed', 'green'),
          seg(' · nothing is signed until you confirm', 'dim'),
        ),
      );
    } else if (a.checking) {
      body.push(BLANK, line('  ', seg(`${spinner(s.now)} Simulating…`, 'cyan')));
    } else if (!isUnlocked(s)) {
      body.push(BLANK, dimLine('  Unlock to simulate it and see the fee. Nothing is signed yet.'));
    }
    const items: Item[] = [
      {
        label: isUnlocked(s) ? 'Confirm' : 'Unlock and check',
        act: confirmTx,
      },
      backItem(),
      { label: 'Cancel', act: (st) => goHome(st, [dimLine('  Cancelled. Nothing was sent.')]) },
    ];
    return {
      body,
      items,
      hint: '↑↓ move · enter select · esc back',
      help: [['enter', 'Confirm starts a countdown you can stop with Esc']],
    };
  },
};

const SIGN_SPEC: InputSpec = { field: 'unlock', secret: true, placeholder: 'your wallet password' };

export const txSignScreen: ScreenDef = {
  crumb: (s) => txCrumb(s, 'Sign'),
  view: (s) => ({
    body: [
      line('  Password for ', seg(s.wallet?.name ?? '', 'bold')),
      BLANK,
      inputLine(s, SIGN_SPEC),
      BLANK,
      dimLine(`  ${unlockMinutesText(s)} You will see the fee before anything is sent.`),
    ],
    input: SIGN_SPEC,
    items: [
      { label: 'Unlock and check', act: (st) => unlock(st, 'review', afterTxUnlock) },
      backItem(),
    ],
    hint: 'type password · enter unlock · esc back',
  }),
};

export const txCountScreen: ScreenDef = {
  crumb: (s) =>
    txCrumb(
      s,
      s.txAction?.kind !== 'operator' ? 'Disclosing' : s.txAction.until ? 'Granting' : 'Revoking',
    ),
  view: (s) => {
    const cd = s.countdown;
    const left = cd ? Math.max(0, Math.ceil((cd.endsAt - s.now) / 1000)) : 0;
    const total = cd?.total ?? 0;
    return {
      body: [
        BLANK,
        line('      ', seg(`${s.txAction?.title ?? 'Sending'} in ${left}…`, 'big')),
        BLANK,
        line('      ', seg('■'.repeat(left) + '□'.repeat(Math.max(0, total - left)), 'yellow')),
        BLANK,
        dimLine('      Esc stops it. Nothing has been broadcast yet.'),
      ],
      items: [],
      bare: true,
      hint: 'esc stop · ctrl+c stop and go Home',
      onKey: (st, key) => {
        if (key === 'escape') {
          stopTxCountdown(st, false);
          return { handled: true };
        }
        if (key === 'ctrl-c') {
          stopTxCountdown(st, true);
          return { handled: true };
        }
        return { handled: true };
      },
    };
  },
};
