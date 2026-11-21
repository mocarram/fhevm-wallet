/**
 * Tokens: list, add by address (name and symbol read from the contract and sanitised),
 * remove.
 */

import { shortAddress } from '../../core/send/recipient.js';
import { describeNonCompliant } from '../../core/token/erc7984Check.js';
import { addTokenFromInput, removeTrackedTokens, trackChecked } from '../flows/manage.js';
import { abandonFind, addFound, selectableCandidates, startFind, stopFind } from '../flows/find.js';
import { sourceLabel } from '../../core/token/findTokens.js';
import { spinner } from '../format.js';
import {
  filterOptions,
  matchesFilter,
  MULTI_SELECT_HELP,
  multiSelectKey,
  renderMultiSelect,
  type MultiOption,
} from '../components/list.js';
import { open } from '../nav.js';
import type { Item, ScreenDef } from '../screen.js';
import { back, top, type AppState } from '../state.js';
import { dimLine, line, pad, seg, type Line } from '../text.js';
import { backItem, BLANK, inputLine } from './common.js';

const TOKENS_FILTER = 'filter.tokens';
const FIND_FILTER = 'filter.find';

export const tokensScreen: ScreenDef = {
  crumb: ['Tokens'],
  view: (s) => {
    const q = s.inputs[TOKENS_FILTER];
    const shown = s.data.tokens.filter((t) =>
      matchesFilter(`${t.symbol} ${t.name} ${t.address}`, q),
    );
    const body = shown.length
      ? shown.map((t) =>
          line(
            '  ',
            seg(pad(t.symbol, 8), 'bold'),
            ' ',
            pad(t.name, 24),
            ' ',
            seg(shortAddress(t.address), 'dim'),
          ),
        )
      : [
          dimLine(
            q
              ? '  No tracked token matches the filter.'
              : `  No tokens tracked on ${s.network} yet.`,
          ),
        ];
    return {
      body,
      filter: TOKENS_FILTER,
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
          note: 'known lists and your history',
          act: (st) => open(st, 'token-find'),
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
  accept: /^[0-9a-zA-Z]$/,
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

/** "This is not an ERC-7984 token. Add anyway?" after a failed check. */
export const tokenAddConfirmScreen: ScreenDef = {
  crumb: ['Tokens', 'Add', 'Check'],
  view: (s) => {
    const check = s.tokenCheck;
    const then = top(s).params.then === 'setup' ? 'setup' : 'tokens';
    const body: Line[] = check
      ? [
          line('  ', seg(`✗ ${describeNonCompliant(check, s.network).title}`, 'red')),
          BLANK,
          ...(check.info
            ? check.problems.map((p) => dimLine(`  · ${p}`))
            : [dimLine(`  ${describeNonCompliant(check, s.network).hint}`)]),
          BLANK,
          dimLine('  Balances and sends would fail for a token that is not ERC-7984.'),
          dimLine('  Only add it if you know this contract and trust it.'),
        ]
      : [dimLine('  Nothing to confirm. Press Esc.')];
    const items: Item[] = [{ label: "Don't add it", act: (st) => back(st) }];
    if (check?.info) {
      items.push({
        label: 'Add anyway',
        valueStyle: 'red',
        act: (st) => (st.tokenCheck ? trackChecked(st, st.tokenCheck, then) : []),
      });
    }
    return { body, items, hint: 'enter select · esc back' };
  },
};

function findOptions(s: AppState): MultiOption[] {
  return selectableCandidates(s).map((c) => ({
    id: c.address,
    label: `${pad(c.symbol, 8)} ${pad(c.name, 20)} ${shortAddress(c.address)}`,
    note: c.status === 'unverified' ? `${sourceLabel(c)} · unverified` : sourceLabel(c),
    noteStyle: c.status === 'unverified' ? 'yellow' : 'dim',
  }));
}

/** Tokens › Find tokens: progress, then one multi-select list of candidates. */
export const tokenFindScreen: ScreenDef = {
  crumb: ['Tokens', 'Find'],
  onEnter: startFind,
  view: (s) => {
    const f = s.find;
    const body: Line[] = [];
    if (!f || f.phase !== 'done') {
      const p = f?.progress;
      if (f?.phase === 'checking') {
        body.push(line('  ', seg(`${spinner(s.now)} Checking each token for ERC-7984…`, 'cyan')));
      } else if (p) {
        const total = Math.max(1, p.toBlock - p.fromBlock + 1);
        const pct = Math.floor(((p.current - p.fromBlock + 1) / total) * 100);
        body.push(
          line(
            '  ',
            seg(
              `${spinner(s.now)} Scanning your history: block ${p.current} of ${p.toBlock} (${pct}%)`,
              'cyan',
            ),
            seg(` · ${p.found} found`, 'dim'),
          ),
        );
      } else {
        body.push(line('  ', seg(`${spinner(s.now)} Reading the known token lists…`, 'cyan')));
      }
      body.push(BLANK, dimLine('  Esc stops the scan. What was scanned so far is saved.'));
      return {
        body,
        items: [],
        hint: 'esc stop scan',
        onKey: (st, key) => {
          if (key === 'escape') {
            stopFind(st);
            return { handled: true };
          }
          if (key === 'ctrl-c') abandonFind();
          return { handled: false };
        },
      };
    }

    const r = f.result;
    if (f.error || !r) {
      body.push(line('  ', seg(`✗ ${f.error ?? 'Nothing to show.'}`, 'red')));
    } else {
      const sc = r.scan;
      if (sc?.cancelled)
        body.push(
          line(
            '  ',
            seg(
              `! Scan stopped at block ${sc.scannedTo}. Find tokens again to continue.`,
              'yellow',
            ),
          ),
        );
      else if (sc?.error)
        body.push(
          line('  ', seg(`! The scan stopped early: ${sc.error.message}`, 'yellow')),
          dimLine('    What was found so far is listed. Find tokens again to continue.'),
        );
      else if (sc)
        body.push(
          dimLine(
            sc.upToDate
              ? `  Your history is scanned up to block ${sc.toBlock}.`
              : `  Scanned blocks ${sc.fromBlock} to ${sc.toBlock} of ${s.network}.`,
          ),
        );
      if (r.listError) body.push(line('  ', seg(`! Your token list: ${r.listError}`, 'yellow')));
      body.push(BLANK);
      const options = findOptions(s);
      if (options.length) body.push(...renderMultiSelect(top(s), filtered(s, options)));
      else body.push(dimLine('  No new tokens to add.'));
      const notOffered = r.candidates.filter(
        (c) => c.status === 'not-erc7984' || c.status === 'unchecked',
      );
      if (notOffered.length) {
        body.push(BLANK);
        for (const c of notOffered) {
          body.push(
            dimLine(
              `  ${pad(c.symbol, 8)} ${shortAddress(c.address)}  ${c.status === 'unchecked' ? "couldn't check it" : 'not ERC-7984, not offered'}`,
            ),
          );
        }
      }
      const tracked = r.candidates.filter((c) => c.status === 'tracked').length;
      if (tracked) body.push(dimLine(`  ${tracked} already tracked.`));
      if (r.candidates.some((c) => c.status === 'unverified')) {
        body.push(
          BLANK,
          dimLine('  Unverified: sent to you, but on no known list. Anyone can send you a token;'),
          dimLine('  only add ones you recognise.'),
        );
      }
    }
    return {
      body,
      items: [],
      hint: 'space select · a all · enter add · r scan again · / filter · esc back',
      filter: FIND_FILTER,
      help: [...MULTI_SELECT_HELP, ['r', 'Scan again (continues from where it stopped)']],
      onKey: (st, key) => {
        if (key === 'escape' || key === 'ctrl-c') {
          abandonFind();
          return { handled: false };
        }
        if (key === 'r') return { handled: true, effects: startFind(st) };
        const res = multiSelectKey(top(st), filtered(st, findOptions(st)), key);
        if (res.kind === 'ignored') return { handled: false };
        st.fieldError = null;
        if (res.kind !== 'confirm') return { handled: true };
        if (!res.ids.length) {
          st.fieldError = [
            'Nothing selected.',
            'Press Space on a token to select it, or a for all.',
          ];
          return { handled: true };
        }
        return { handled: true, effects: addFound(st, res.ids) };
      },
    };
  },
};

/** Options matching the list filter (`/`), if one is set. */
function filtered(s: AppState, options: MultiOption[]): MultiOption[] {
  return filterOptions(top(s), options, s.inputs[FIND_FILTER]);
}

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
