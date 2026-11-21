/**
 * Wrap / Unwrap screens (docs/ui-design.md "Wrap / Unwrap"): the token picker and one
 * screen per direction with both balances, the rate, the amount field and a live preview
 * of the exact result and dust. Continue opens the shared Review (screens/tx.ts).
 * Rendering is pure: balances come from `s.balances` / `s.wrap`, loaded by effects.
 */

import { formatBalance, formatExactAmount } from '../../core/send/amount.js';
import {
  describeRate,
  describeWrapPlan,
  planUnwrap,
  planWrap,
  smallestWrap,
} from '../../core/token/wrapMath.js';
import {
  amt,
  continueWrap,
  loadWrapData,
  pendingUnwrapItems,
  publicState,
  WRAP_AMOUNT_FIELD,
  wrapperOf,
} from '../flows/wrap.js';
import { decryptAll } from '../flows/data.js';
import { spinner } from '../format.js';
import { open, openInstead } from '../nav.js';
import type { InputSpec, MenuEntry, ScreenDef, ScreenView } from '../screen.js';
import { isUnlocked, top, type AppState } from '../state.js';
import { dimLine, line, pad, seg, type Line } from '../text.js';
import { backItem, BLANK, inputLine, SEP } from './common.js';

const HELP: Array<[string, string]> = [
  ['tab', 'Switch between Wrap and Unwrap'],
  ['units', 'Wrap amounts are in the public token, unwrap amounts in the confidential one'],
  [':wrap 25 cusdc', 'Wrap from anywhere (:unwrap 10 cusdc)'],
];

export const wrapPickScreen: ScreenDef = {
  crumb: ['Wrap or unwrap'],
  onEnter: (s) => loadWrapData(s),
  view: (s) => {
    const mode = top(s).params.mode === 'unwrap' ? 'unwrap' : 'wrap';
    const body: Line[] = [
      line('  ', seg('ERC-20 ⇄ confidential: pick a wrapper token.', 'bold')),
      BLANK,
    ];
    const items: MenuEntry[] = [];
    for (const t of s.data.tokens) {
      const info = wrapperOf(s, t.address);
      if (info) {
        items.push({
          label: `${t.symbol} ⇄ ${info.underlying.symbol}`,
          value: describeRate(info).split(' · ')[0],
          valueStyle: 'dim',
          act: (st) => open(st, mode, { token: t.address }),
        });
      } else if (!s.wrap.loading) {
        body.push(dimLine(`  ${pad(t.symbol, 10)} not a wrapper (no ERC-20 behind it)`));
      }
    }
    if (s.wrap.loading)
      body.push(line('  ', seg(`${spinner(s.now)} Checking your tokens…`, 'cyan')));
    else if (s.wrap.error) body.push(line('  ', seg(`! ${s.wrap.error}`, 'yellow')));
    if (!s.data.tokens.length)
      body.push(dimLine('  No tokens tracked. Add a wrapper (e.g. cZAMA) in Tokens.'));
    const pending = pendingUnwrapItems(s);
    if (pending.length) items.push(SEP, ...pending);
    items.push(
      SEP,
      { label: 'Check again', act: (st) => loadWrapData(st, { refresh: true }) },
      backItem(),
    );
    return { body, items, hint: '↑↓ move · enter select · esc back', help: HELP };
  },
};

const AMOUNT_SPEC = (label: string): InputSpec => ({
  field: WRAP_AMOUNT_FIELD,
  label,
  placeholder: '25, 1k, half or max',
  accept: /^[0-9.,a-zA-Z]$/,
  maxLength: 40,
});

/** A value column that never runs into the label after it. */
function col(text: string): string {
  return pad(text, Math.max(18, Array.from(text).length + 2));
}

/** The Wrap or Unwrap screen for `top(s).params.token`. */
function wrapView(s: AppState, mode: 'wrap' | 'unwrap'): ScreenView {
  const token = top(s).params.token ?? '';
  const t = s.data.tokens.find((x) => x.address.toLowerCase() === token.toLowerCase());
  const info = wrapperOf(s, token);
  if (!t || !info) {
    return {
      body: [
        s.wrap.loading
          ? line('  ', seg(`${spinner(s.now)} Checking the token…`, 'cyan'))
          : dimLine('  This token is not a known wrapper. Esc goes back.'),
      ],
      // While loading, the cursor rests on a placeholder for Continue: otherwise it would
      // sit on Back and follow it (stableCursor) once the real items arrive.
      items: s.wrap.loading
        ? [
            { label: 'Checking…', disabled: true, note: 'wrapper details first', act: () => [] },
            backItem(),
          ]
        : [backItem()],
      hint: 'esc back',
    };
  }
  const u = info.underlying;
  const pub = publicState(s, token);
  const conf = s.balances[token.toLowerCase()];
  const body: Line[] = [
    line(
      '  ',
      seg(
        mode === 'wrap'
          ? `Wrap ${u.symbol} into ${info.symbol}`
          : `Unwrap ${info.symbol} into ${u.symbol}`,
        'bold',
      ),
    ),
    line(
      '  ',
      seg(pad(u.symbol, 11), 'bold'),
      seg(col(pub ? formatExactAmount(pub.balance, u.decimals) : s.wrap.loading ? '…' : '?'), ''),
      seg('public, in this wallet', 'dim'),
    ),
    line(
      '  ',
      seg(pad(info.symbol, 11), 'bold'),
      seg(
        col(
          conf ? formatBalance(conf.value, info.decimals) : s.decrypting ? 'decrypting…' : 'locked',
        ),
        conf?.source === 'session' ? 'green' : 'dim',
      ),
      seg('confidential', 'dim'),
    ),
    dimLine(`  ${describeRate(info)}`),
    BLANK,
  ];
  const spec = AMOUNT_SPEC(mode === 'wrap' ? `${u.symbol} to wrap ` : `${info.symbol} to unwrap `);
  const typed = s.inputs[WRAP_AMOUNT_FIELD] ?? '';
  body.push(inputLine(s, spec));
  const plan =
    mode === 'wrap'
      ? planWrap(typed, info, { balance: pub?.balance, supplyRoom: pub?.supplyRoom })
      : planUnwrap(typed, info, { balance: conf?.value });
  if (typed.trim() && !s.fieldError) {
    if (!plan.ok) {
      body.push(line('  ', seg(plan.error, 'red')), dimLine(`  ${plan.hint}`));
    } else if ('wrapped' in plan) {
      const d = describeWrapPlan(plan, info);
      body.push(line('  ', seg(d.get, 'green')));
      if (d.stays) body.push(line('  ', seg(d.stays, 'yellow')));
    } else {
      body.push(
        line('  ', seg(`You get ${amt(plan.receive, u.decimals, u.symbol)} (public).`, 'green')),
      );
    }
  } else if (!typed.trim()) {
    body.push(
      dimLine(
        mode === 'wrap'
          ? `  The smallest wrap is ${amt(smallestWrap(info), u.decimals, u.symbol)}; smaller parts stay in your wallet.`
          : `  ${isUnlocked(s) ? 'A burn above your balance burns 0, so it is checked first.' : 'Unlock to see your balance; it is checked before anything is signed.'}`,
      ),
    );
  }
  const other = mode === 'wrap' ? 'unwrap' : 'wrap';
  const switchTo = (st: AppState) => {
    st.fieldError = null;
    return openInstead(st, other, { token });
  };
  return {
    body,
    input: spec,
    items: [
      { label: 'Continue', act: (st) => continueWrap(st, mode, info, plan) },
      {
        label: mode === 'wrap' ? `Unwrap ${info.symbol} instead` : `Wrap ${u.symbol} instead`,
        note: 'tab',
        act: switchTo,
      },
      backItem(),
    ],
    hint: 'type amount · enter continue · tab switch · esc back',
    help: HELP,
    onKey: (st, key) =>
      key === 'tab' ? { handled: true, effects: switchTo(st) } : { handled: false },
  };
}

/** Load what the Wrap screen shows: public balance, and the decrypted one when unlocked. */
function enterWrap(s: AppState) {
  return [...loadWrapData(s), ...decryptAll(s)];
}

export const wrapScreen: ScreenDef = {
  crumb: ['Wrap'],
  onEnter: enterWrap,
  view: (s) => wrapView(s, 'wrap'),
};

export const unwrapScreen: ScreenDef = {
  crumb: ['Unwrap'],
  onEnter: enterWrap,
  view: (s) => wrapView(s, 'unwrap'),
};
