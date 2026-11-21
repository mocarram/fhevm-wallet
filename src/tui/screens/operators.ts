/**
 * Operators: view, grant with expiry, revoke. Every change goes through Review
 * (simulation + fee), an explicit Confirm and the send countdown (screens/tx.ts).
 */

import { describeExpiry, EXPIRY_CHOICES } from '../../core/send/operatorExpiry.js';
import {
  chooseExpiry,
  confirmForever,
  loadOperators,
  submitOperatorAddress,
  useOperatorContactInstead,
  usePastedOperatorLookalike,
} from '../flows/operators.js';
import { startOperatorRevoke } from '../flows/tx.js';
import { spinner } from '../format.js';
import { open } from '../nav.js';
import type { InputSpec, Item, MenuEntry, ScreenDef } from '../screen.js';
import { popTo } from '../nav.js';
import { top, type AppState } from '../state.js';
import { dimLine, line, pad, seg, type Line } from '../text.js';
import { backItem, BLANK, inputLine, pasteAddressInto, SEP } from './common.js';
import { comparedAddress } from './send.js';

function tokenSymbol(s: AppState): string {
  const t = s.data.tokens.find((x) => x.address.toLowerCase() === s.operators?.token.toLowerCase());
  return t?.symbol ?? '';
}

export const operatorsScreen: ScreenDef = {
  crumb: ['Operators'],
  onEnter: (s) => loadOperators(s),
  view: (s) => {
    if (!s.data.tokens.length) {
      return {
        body: [dimLine('  No tokens tracked yet. Add one in Tokens first.')],
        items: [backItem()],
        hint: 'esc back',
      };
    }
    const o = s.operators;
    const body: Line[] = [
      line('  Who may move your ', seg(tokenSymbol(s), 'bold'), ' (ERC-7984 operators)'),
      dimLine(
        '  An operator can move ALL of this token until its expiry. There is no amount limit.',
      ),
      BLANK,
    ];
    if (o?.loading) body.push(line('  ', seg(`${spinner(s.now)} Checking…`, 'cyan')));
    else if (o?.error) body.push(line('  ', seg(o.error, 'yellow')));
    else if (!o?.rows.length) body.push(dimLine('  No contacts or recent addresses to check.'));
    const list: Line[] = [];
    for (const r of o?.rows ?? []) {
      list.push(
        line(
          '  ',
          pad(r.label, 16),
          ' ',
          seg(pad(r.address, 44), 'dim'),
          r.isOperator ? seg('operator', 'yellow bold') : seg('not an operator', 'dim'),
          r.isOperator
            ? r.until !== undefined
              ? seg(` ${describeExpiry(r.until)}`, 'yellow')
              : seg(' · expiry unknown', 'dim')
            : seg(''),
        ),
      );
    }
    const after = [BLANK, dimLine('  Checked: your contacts and addresses in recent history.')];
    const items: MenuEntry[] = [
      {
        label: 'Grant an operator',
        act: (st) => {
          delete st.inputs.operatorAddr;
          return open(st, 'operator-addr', { mode: 'grant' });
        },
      },
      { label: 'Revoke an operator', act: (st) => open(st, 'operator-revoke') },
      { label: 'Refresh', act: (st) => loadOperators(st) },
    ];
    if (s.data.tokens.length > 1) {
      items.push({
        label: 'Switch token',
        value: tokenSymbol(s),
        act: (st) => open(st, 'operator-token'),
      });
    }
    items.push(SEP, backItem());
    return {
      body,
      list,
      after,
      items,
      hint: '↑↓ move · enter select · esc back',
      onPaste: pasteAddressInto('operatorAddr', 'operator-addr', { mode: 'grant' }),
      help: [['enter', 'Grant, revoke, refresh or switch token']],
    };
  },
};

export const operatorTokenScreen: ScreenDef = {
  crumb: ['Operators', 'Token'],
  view: (s) => ({
    body: [line('  Show operators for:')],
    items: [
      ...s.data.tokens.map((t): Item => ({
        label: `${t.symbol}  ${t.name}`,
        act: (st) => {
          popTo(st, 'operators');
          return loadOperators(st, t.address);
        },
      })),
      backItem(),
    ],
    hint: '↑↓ move · enter select · esc back',
  }),
};

const ADDR_SPEC: InputSpec = {
  field: 'operatorAddr',
  placeholder: '0x… address or a contact name',
  maxLength: 42,
};

export const operatorAddrScreen: ScreenDef = {
  crumb: ['Operators', 'Address'],
  view: (s) => {
    const revoke = s.stack[s.stack.length - 1].params.mode === 'revoke';
    return {
      body: [
        line(
          revoke ? '  Address to revoke:' : `  Who should be able to move your ${tokenSymbol(s)}?`,
        ),
        BLANK,
        inputLine(s, ADDR_SPEC),
        BLANK,
        dimLine(
          revoke
            ? '  Revoking sets its expiry to now. It needs a transaction and a little ETH.'
            : '  Usually a contract (an exchange, a payroll or escrow contract), not a person.',
        ),
      ],
      input: ADDR_SPEC,
      items: [{ label: 'Next', act: submitOperatorAddress }, backItem()],
      hint: 'type or paste · enter next · esc back',
    };
  },
};

/** Look-alike stop before a grant: the same check as Send, since an operator takes all. */
export const operatorCheckScreen: ScreenDef = {
  crumb: ['Operators', 'Address'],
  view: (s) => {
    const { address = '', contact = '' } = top(s).params;
    const saved = s.data.contacts.find((c) => c.name === contact);
    const body: Line[] = [
      line(
        '  ',
        seg(
          `✗ Careful: this looks like your contact ${contact}, but it is a different address.`,
          'red bold',
        ),
      ),
      BLANK,
    ];
    if (saved) {
      body.push([
        seg(`  ${pad(`${contact} (saved)`, 16)}`),
        ...comparedAddress(saved.address, 'dim'),
      ]);
    }
    body.push([seg(`  ${pad('pasted', 16)}`), ...comparedAddress(address, 'red')]);
    body.push(
      BLANK,
      dimLine('  Scammers send tiny transfers from look-alike addresses so you copy'),
      dimLine('  the wrong one. An operator could move ALL of your tokens.'),
    );
    return {
      body,
      items: [
        {
          label: `Grant to ${contact} instead`,
          act: (st) => useOperatorContactInstead(st, contact),
        },
        {
          label: 'I checked it, use the pasted address',
          act: (st) => usePastedOperatorLookalike(st, address),
        },
        backItem(),
      ],
      hint: 'enter select · esc back',
    };
  },
};

export const operatorExpiryScreen: ScreenDef = {
  crumb: ['Operators', 'Expiry'],
  view: (s) => ({
    body: [
      line(`  How long may it move your ${tokenSymbol(s)}?`),
      dimLine('  Shorter is safer. You can revoke at any time.'),
      ...(top(s).params.isNew
        ? [
            BLANK,
            line('  ', seg('! First time using this address. Check it with its owner.', 'yellow')),
          ]
        : []),
    ],
    items: [
      ...EXPIRY_CHOICES.map((c): Item => ({
        label: c.label,
        act: (st) => chooseExpiry(st, c.text),
      })),
      {
        label: 'Custom date or duration…',
        act: (st) => {
          delete st.inputs.operatorExpiry;
          return open(st, 'operator-expiry-custom', { ...st.stack[st.stack.length - 1].params });
        },
      },
      {
        label: 'No expiry…',
        valueStyle: 'yellow',
        value: 'asks you to type "forever"',
        act: (st) => chooseExpiry(st, 'forever'),
      },
      SEP,
      backItem(),
    ],
    hint: '↑↓ move · enter select · esc back',
  }),
};

const EXPIRY_SPEC: InputSpec = {
  field: 'operatorExpiry',
  placeholder: '30m, 12h, 3d, 2w or 2026-12-01',
  maxLength: 20,
};

export const operatorExpiryCustomScreen: ScreenDef = {
  crumb: ['Operators', 'Expiry'],
  view: (s) => ({
    body: [
      line('  Expiry:'),
      BLANK,
      inputLine(s, EXPIRY_SPEC),
      BLANK,
      dimLine('  A date means the end of that day, local time.'),
    ],
    input: EXPIRY_SPEC,
    items: [
      { label: 'Next', act: (st) => chooseExpiry(st, st.inputs.operatorExpiry ?? '') },
      backItem(),
    ],
    hint: 'type · enter next · esc back',
  }),
};

const FOREVER_SPEC: InputSpec = { field: 'operatorForever', placeholder: 'forever', maxLength: 10 };

export const operatorForeverScreen: ScreenDef = {
  crumb: ['Operators', 'No expiry'],
  view: (s) => ({
    body: [
      line(
        '  ',
        seg(
          `! No expiry: the operator can move ALL your ${tokenSymbol(s)}, for good,`,
          'yellow bold',
        ),
      ),
      line('  ', seg('  until you revoke it. Type forever to continue.', 'yellow bold')),
      BLANK,
      inputLine(s, FOREVER_SPEC),
    ],
    input: FOREVER_SPEC,
    items: [{ label: 'Continue to review', act: confirmForever }, backItem()],
    hint: 'type forever · enter continue · esc back',
  }),
};

export const operatorRevokeScreen: ScreenDef = {
  crumb: ['Operators', 'Revoke'],
  view: (s) => {
    const active = (s.operators?.rows ?? []).filter((r) => r.isOperator);
    return {
      body: [
        line('  Revoke which operator?'),
        ...(active.length ? [] : [dimLine('  None of the checked addresses is an operator.')]),
      ],
      items: [
        ...active.map((r): Item => ({
          label: `${r.label}  ${r.address}`,
          act: (st) => startOperatorRevoke(st, st.operators!.token, r.address),
        })),
        {
          label: 'Another address…',
          act: (st) => {
            delete st.inputs.operatorAddr;
            return open(st, 'operator-addr', { mode: 'revoke' });
          },
        },
        backItem(),
      ],
      hint: '↑↓ move · enter select · esc back',
      onPaste: pasteAddressInto('operatorAddr', 'operator-addr', { mode: 'revoke' }),
    };
  },
};
