/**
 * Disclose a transfer amount (OpenZeppelin ERC7984): pick a history entry, then
 * step 1 `requestDiscloseEncryptedAmount` makes it publicly decryptable and step 2
 * `discloseEncryptedAmount` publishes the value with the relayer's KMS proof.
 */

import { matchesFilter } from '../components/list.js';
import { normaliseHandle } from '../../core/fhe/DecryptSession.js';
import { describeError } from '../errors.js';
import { effect, type Effect } from '../effects.js';
import { startDisclose } from '../flows/tx.js';
import { spinner } from '../format.js';
import { open } from '../nav.js';
import type { Item, ScreenDef } from '../screen.js';
import { top, type AppState } from '../state.js';
import { dimLine, line, seg, type Line } from '../text.js';
import { backItem, BLANK } from './common.js';

/** Look up where the selected amount is in the disclosure flow. */
export function loadDiscloseStage(s: AppState): Effect[] {
  const { handle, token } = top(s).params;
  if (!handle || !token) return [];
  const network = s.network;
  s.disclose = { handle, token, loading: true };
  return [
    effect('disclose-stage', async (deps) => {
      try {
        const stage = await deps.backend.discloseStage(token, handle, network);
        return (st) => {
          if (st.disclose?.handle === handle)
            st.disclose = { handle, token, stage, loading: false };
        };
      } catch (err) {
        const msg = describeError(err, { action: 'disclosure check' }).title;
        return (st) => {
          if (st.disclose?.handle === handle) {
            st.disclose = { handle, token, loading: false, error: `Couldn't check: ${msg}` };
          }
        };
      }
    }),
  ];
}

const DISCLOSE_FILTER = 'filter.disclose';

export const disclosePickScreen: ScreenDef = {
  crumb: ['History', 'Disclose'],
  view: (s) => {
    // Every confidential transfer in History (the menu scrolls; / filters), not only the
    // 20 most recent as before.
    const rows = (s.history?.rows ?? []).filter(
      (r) =>
        r.handle &&
        r.tokenAddress &&
        matchesFilter(
          `${r.kind} ${r.token} ${r.counterparty} ${r.amount} ${r.txHash}`,
          s.inputs[DISCLOSE_FILTER],
        ),
    );
    return {
      body: [
        line('  Which transfer amount should become public?'),
        dimLine('  You can disclose transfers you sent or received.'),
      ],
      filter: DISCLOSE_FILTER,
      items: [
        ...rows.map((r): Item => ({
          label: `${r.when}  ${r.kind}  ${r.amount} ${r.token}  ${r.counterparty}`,
          value: r.disclosed ? 'public' : undefined,
          valueStyle: 'dim',
          act: (st) =>
            open(st, 'disclose', {
              handle: normaliseHandle(r.handle!),
              token: r.tokenAddress!,
              txHash: r.txHash,
            }),
        })),
        backItem(),
      ],
      hint: '↑↓ move · enter select · / filter · esc back',
    };
  },
};

export const discloseScreen: ScreenDef = {
  crumb: ['History', 'Disclose'],
  onEnter: loadDiscloseStage,
  view: (s) => {
    const d = s.disclose;
    const { txHash } = top(s).params;
    const body: Line[] = [
      line('  Transaction  ', seg(txHash ?? '', 'dim')),
      BLANK,
      line(
        '  ',
        seg(
          'Disclosing publishes this amount on-chain for everyone. It cannot be undone.',
          'yellow bold',
        ),
      ),
      dimLine(
        '  Two transactions: request (makes it publicly decryptable), then publish (with the proof).',
      ),
      BLANK,
    ];
    const items: Item[] = [];
    if (!d || d.loading) body.push(line('  ', seg(`${spinner(s.now)} Checking…`, 'cyan')));
    else if (d.error) body.push(line('  ', seg(d.error, 'yellow')));
    else if (d.stage === 'private') {
      body.push(line('  Status  ', seg('private', 'bold')));
      items.push({
        label: 'Step 1: request disclosure',
        act: (st) => startDisclose(st, d.token, d.handle, 'private'),
      });
    } else if (d.stage === 'requested') {
      body.push(
        line('  Status  ', seg('step 1 done · pending public decryption', 'bold')),
        dimLine('  Step 2 asks the Zama relayer for the value and its proof, then publishes both.'),
      );
      items.push({
        label: 'Step 2: publish the amount',
        act: (st) => startDisclose(st, d.token, d.handle, 'requested'),
      });
    } else if (d.stage === 'disclosed') {
      body.push(line('  Status  ', seg('public: you disclosed this amount', 'green')));
    }
    items.push({ label: 'Check again', act: loadDiscloseStage }, backItem());
    return { body, items, hint: '↑↓ move · enter select · esc back' };
  },
};
