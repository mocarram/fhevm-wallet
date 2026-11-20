/**
 * Tokens: list, add by address (name and symbol read from the contract and sanitised),
 * remove.
 */

import { shortAddress } from '../../core/send/recipient.js';
import { addTokenFromInput, removeTrackedTokens } from '../flows/manage.js';
import {
  MULTI_SELECT_HELP,
  multiSelectKey,
  renderMultiSelect,
  type MultiOption,
} from '../components/list.js';
import { open } from '../nav.js';
import type { ScreenDef } from '../screen.js';
import { top, type AppState } from '../state.js';
import { dimLine, line, pad, seg } from '../text.js';
import { backItem, BLANK, inputLine } from './common.js';

export const tokensScreen: ScreenDef = {
  crumb: ['Tokens'],
  view: (s) => {
    const body = s.data.tokens.length
      ? s.data.tokens.map((t) =>
          line(
            '  ',
            seg(pad(t.symbol, 8), 'bold'),
            ' ',
            pad(t.name, 24),
            ' ',
            seg(shortAddress(t.address), 'dim'),
          ),
        )
      : [dimLine(`  No tokens tracked on ${s.network} yet.`)];
    return {
      body,
      items: [
        {
          label: 'Add token by address',
          act: (st) => {
            delete st.inputs.tokenAddress;
            return open(st, 'token-add');
          },
        },
        { label: 'Remove tokens', act: (st) => open(st, 'token-remove') },
        {
          label: 'Find tokens',
          value: 'coming soon',
          valueStyle: 'dim',
          disabled: true,
          act: (st) => {
            st.flash = [
              dimLine('  Finding tokens you have received is coming in a later update.'),
              dimLine('  For now, add a token by its contract address.'),
            ];
          },
        },
        backItem(),
      ],
      hint: '↑↓ move · enter select · esc back',
    };
  },
};

const ADDR_SPEC = {
  field: 'tokenAddress',
  placeholder: '0x… token contract address',
  maxLength: 42,
};

export const tokenAddScreen: ScreenDef = {
  crumb: ['Tokens', 'Add'],
  view: (s) => ({
    body: [
      line(`  Token contract address on ${s.network}:`),
      BLANK,
      inputLine(s, ADDR_SPEC),
      BLANK,
      dimLine('  The name, symbol and decimals are read from the contract.'),
    ],
    input: ADDR_SPEC,
    items: [
      {
        label: 'Add token',
        act: (st) => addTokenFromInput(st, top(st).params.setup ? 'setup' : 'tokens'),
      },
      backItem(),
    ],
    hint: 'paste address · enter add · esc back',
  }),
};

function removeOptions(s: AppState): MultiOption[] {
  return s.data.tokens.map((t) => ({
    id: t.address,
    label: `${pad(t.symbol, 8)} ${shortAddress(t.address)}`,
    note: t.name,
  }));
}

export const tokenRemoveScreen: ScreenDef = {
  crumb: ['Tokens', 'Remove'],
  view: (s) => {
    const options = removeOptions(s);
    return {
      body: [
        dimLine('  Pick the tokens to stop tracking. Your balances on-chain are not affected.'),
        BLANK,
        ...(options.length
          ? renderMultiSelect(top(s), options)
          : [dimLine('  No tokens tracked.')]),
      ],
      items: [],
      hint: 'space select · a all · enter remove · esc back',
      help: MULTI_SELECT_HELP,
      onKey: (st, key) => {
        const r = multiSelectKey(top(st), removeOptions(st), key);
        if (r.kind === 'ignored') return { handled: false };
        st.fieldError = null;
        if (r.kind !== 'confirm') return { handled: true };
        if (!r.ids.length) {
          st.fieldError = [
            'Nothing selected.',
            'Press Space on a token to select it, or a for all.',
          ];
          return { handled: true };
        }
        return { handled: true, effects: removeTrackedTokens(st, r.ids) };
      },
    };
  },
};
