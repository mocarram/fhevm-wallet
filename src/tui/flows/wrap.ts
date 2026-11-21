/**
 * Wrap / Unwrap in the TUI: load which tracked tokens are wrappers and their public
 * ERC-20 balances, open the Wrap screen, and turn its amount into a TxAction for the
 * shared Review → Confirm → countdown → background broadcast (flows/tx.ts).
 *
 * Wrap: one confirmation sends the exact approval (when needed) and the wrap. Unwrap: one
 * confirmation sends the request and, once the amount is publicly decryptable, the finish
 * (step 2). An unwrap that cannot finish right away stays in the unwrap store and shows on
 * Home as "Finish unwrap", which checks the chain before offering step 2 again
 * (core/token/unwrapPending.ts), so no step is ever sent twice.
 */

import type { PreparedTx, UnlockedSigner } from '../../core/backend/types.js';
import type {
  PreparedFinalize,
  PreparedUnwrap,
  PreparedWrap,
} from '../../core/backend/wrapTypes.js';
import { translateTxError, WalletTxError } from '../../core/token/txErrors.js';
import {
  describeUnwrapState,
  prepareFinish,
  reconcileUnwrap,
  sendFinish,
  sendUnwrapRequest,
  unconfirmedRequest,
  unconfirmedRequestError,
} from '../../core/token/unwrapPending.js';
import { describeWrapPlan, type UnwrapPlan, type WrapPlan } from '../../core/token/wrapMath.js';
import { loadWrappers, resolveWrapToken } from '../../core/token/wrapTokens.js';
import type { WrapperInfo } from '../../core/token/wrapper.js';
import { assertUnwrapStoreWritable, type UnwrapEntry } from '../../storage/UnwrapStore.js';
import { describeError } from '../errors.js';
import { sendWrapRecorded } from '../../core/token/wrapHistory.js';
import { effect, type Deps, type Effect } from '../effects.js';
import { formatAmount, formatEth, shortHash } from '../format.js';
import { open, openFromRoot, openInstead } from '../nav.js';
import type { Item } from '../screen.js';
import { type AppState, type TxAction } from '../state.js';
import { dimLine, line, link, seg, type Line } from '../text.js';
import { decryptAll, reload, sessionOf } from './data.js';
import { txChecks } from './tx.js';

/** How often, and how long apart, step 2 is tried after the request confirms. */
const FINISH_TRIES = 6;
const FINISH_WAIT_MS = 10_000;

/** The text field of the Wrap / Unwrap screen. */
export const WRAP_AMOUNT_FIELD = 'wrapAmount';

/** Base units with a symbol, exact. */
export function amt(value: bigint, decimals: number, symbol: string): string {
  return `${formatAmount(value, decimals)} ${symbol}`;
}

/** The wrapper info of a tracked token, when known. */
export function wrapperOf(s: AppState, token: string): WrapperInfo | undefined {
  return s.data.wrappers[token.toLowerCase()];
}

/** Key of the public-state cache: per wallet, since balances are. */
function stateKey(s: AppState, token: string): string {
  return `${s.wallet?.address.toLowerCase() ?? ''}:${token.toLowerCase()}`;
}

/** Public ERC-20 balance and allowance of the current wallet for a wrapper, when loaded. */
export function publicState(s: AppState, token: string) {
  return s.wrap.state[stateKey(s, token)];
}

/**
 * Check which tracked tokens are wrappers (cached for a week, see WrapperCache) and read
 * the public ERC-20 balances of the wrappers. Needs no unlock.
 */
export function loadWrapData(s: AppState, opts: { refresh?: boolean } = {}): Effect[] {
  if (!s.wallet || s.data.tokens.length === 0 || s.wrap.loading) return [];
  const network = s.network;
  const owner = s.wallet.address;
  const tokens = s.data.tokens.map((t) => ({ address: t.address }));
  s.wrap.loading = true;
  return [
    effect('wrap-load', async (deps) => {
      let error: string | undefined;
      const map = await loadWrappers(deps.backend, network, tokens, opts);
      const states: Record<string, Awaited<ReturnType<Deps['backend']['wrapState']>>> = {};
      for (const info of Object.values(map)) {
        if (!info) continue;
        try {
          states[info.address.toLowerCase()] = await deps.backend.wrapState(info, owner, network);
        } catch (err) {
          error = describeError(err, { action: 'balance check' }).title;
        }
      }
      if (tokens.some((t) => !(t.address.toLowerCase() in map))) {
        error = error ?? "Couldn't check every token. Try again in a moment.";
      }
      const at = deps.now();
      return (st) => {
        st.wrap.loading = false;
        if (st.network !== network || st.wallet?.address !== owner) return;
        st.wrap.error = error;
        for (const [k, v] of Object.entries(states)) {
          st.wrap.state[`${owner.toLowerCase()}:${k}`] = { ...v, at };
        }
        for (const [k, v] of Object.entries(map)) {
          if (v) st.data.wrappers[k] = v;
          else delete st.data.wrappers[k];
        }
        // Opened from `:wrap 25 czama` before the token was checked: go on to it now.
        const f = st.stack[st.stack.length - 1];
        if (f.id === 'wrap-pick' && f.params.want !== undefined) {
          const r = resolveWrapToken(f.params.want || undefined, st.data.tokens, map);
          const mode = f.params.mode === 'unwrap' ? 'unwrap' : 'wrap';
          delete f.params.want;
          if (r.ok) return [reload(st), ...openInstead(st, mode, { token: r.token.address })];
        }
        return [reload(st)]; // picks up wrappers.json and unwraps.json
      };
    }),
  ];
}

/**
 * Open Wrap (or Unwrap) for `token`, or the picker when no token is given and more than
 * one (or no known) wrapper is tracked. `amount` pre-fills the field (`:wrap 25 cusdc`).
 */
export function openWrap(
  s: AppState,
  mode: 'wrap' | 'unwrap',
  token?: string,
  amount?: string,
): Effect[] {
  const known = s.data.tokens.filter((t) => wrapperOf(s, t.address));
  const target = token ?? (known.length === 1 ? known[0].address : undefined);
  if (amount !== undefined) s.inputs[WRAP_AMOUNT_FIELD] = amount;
  else delete s.inputs[WRAP_AMOUNT_FIELD];
  if (!target) return open(s, 'wrap-pick', { mode });
  return open(s, mode, { token: target });
}

/** `:wrap 25 cusdc` / `:unwrap 10 cusdc` from the command bar. */
export function commandWrap(
  s: AppState,
  cmd: { mode: 'wrap' | 'unwrap'; amount?: string; token?: string },
): Effect[] {
  if (!s.wallet) {
    s.flash = [dimLine('  Create or import a wallet first.')];
    return [];
  }
  const wrappers = Object.fromEntries(
    s.data.tokens.map((t) => [t.address.toLowerCase(), wrapperOf(s, t.address) ?? null]),
  );
  // Tokens not checked yet are not "not a wrapper": leave them out of the map.
  for (const t of s.data.tokens) {
    if (!wrapperOf(s, t.address)) delete wrappers[t.address.toLowerCase()];
  }
  const r = resolveWrapToken(cmd.token, s.data.tokens, wrappers);
  const fx = openFromRoot(s, 'balances');
  if (!r.ok) {
    // Unknown yet (not checked) or ambiguous: the picker checks and lets the user choose.
    if (cmd.amount !== undefined) s.inputs[WRAP_AMOUNT_FIELD] = cmd.amount;
    else delete s.inputs[WRAP_AMOUNT_FIELD];
    const more = open(s, 'wrap-pick', { mode: cmd.mode, want: cmd.token ?? '' });
    if (!s.wrap.loading || r.code !== 'TOKEN_NOT_TRACKED')
      s.flash = [line('  ', seg(r.error, 'yellow'))];
    return [...fx, ...more];
  }
  return [...fx, ...openWrap(s, cmd.mode, r.token.address, cmd.amount)];
}

/** Notice lines for one finished or waiting unwrap. */
function finishNotice(entry: UnwrapEntry, text: string, style: string, extra: Line[] = []): Line[] {
  return [
    line('  ', seg(text, style)),
    ...extra,
    dimLine(`    request ${shortHash(entry.requestTxHash)}`),
  ];
}

/** A mined request without an unwrap in it: tokens may be burnt, the explorer tells. */
function unclearNotice(deps: Deps, entry: UnwrapEntry, label: string, reason: string): Line[] {
  return [
    line('  ', seg(`! ${label}: ${reason}`, 'yellow bold')),
    line('    ', link(deps.backend.explorerTxUrl(entry.requestTxHash, entry.network), 'dim')),
  ];
}

/**
 * Try step 2 of an unwrap in the background: reconcile, wait for the public decryption
 * (a few tries), then send it. Never throws: the notice says where it stands.
 */
async function finishInBackground(
  deps: Deps,
  signer: UnlockedSigner,
  start: UnwrapEntry,
  tries: number,
): Promise<Line[]> {
  let entry = start;
  const label = `${amt(BigInt(entry.amount), entry.decimals, entry.symbol)} → ${entry.underlying.symbol}`;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await reconcileUnwrap(deps.backend, entry);
      entry = r.entry;
      if (r.next.kind === 'done')
        return finishNotice(entry, `✔ Unwrap finished: ${label}`, 'green bold');
      if (r.next.kind === 'unclear') return unclearNotice(deps, entry, label, r.next.reason);
      if (r.next.kind !== 'finalize') break;
      const prepared = await prepareFinish(deps.backend, signer, entry);
      const done = await sendFinish(prepared, entry);
      return finishNotice(
        done.entry,
        `✔ Unwrapped ${amt(prepared.value, entry.decimals, entry.symbol)}: ${amt(prepared.receive, entry.underlying.decimals, entry.underlying.symbol)} arrived`,
        'green bold',
        done.txHash ? [dimLine(`    step 2 tx ${shortHash(done.txHash)}`)] : [],
      );
    } catch (err) {
      const e = translateTxError(err);
      if (e.code === 'PUBLIC_DECRYPT_PENDING' && i < tries - 1 && deps.backend.kind !== 'mock') {
        await new Promise((r) => setTimeout(r, FINISH_WAIT_MS));
        continue;
      }
      if (e.code === 'UNWRAP_ALREADY_FINISHED') {
        return finishNotice(entry, `✔ Unwrap finished: ${label}`, 'green bold');
      }
      const shown = describeError(e, { action: 'send' });
      return finishNotice(
        entry,
        e.code === 'PUBLIC_DECRYPT_PENDING'
          ? `! Step 1 done: ${label}. Not decryptable yet.`
          : `! Step 1 done: ${label}. Step 2: ${shown.title}`,
        'yellow bold',
        [
          e.txHash
            ? line(
                seg(`    Step 2 tx ${e.txHash}: do not send again until it is checked.`, 'yellow'),
              )
            : dimLine('    Home › Finish unwrap sends step 2 when it is ready.'),
        ],
      );
    }
  }
  return finishNotice(entry, `! Step 1 done: ${label}`, 'yellow bold', [
    dimLine('    Home › Finish unwrap sends step 2 when it is ready.'),
  ]);
}

/** Review lines for a wrap: what goes in, what comes out, the steps and the fee split. */
function wrapDetails(info: WrapperInfo, plan: WrapPlan) {
  const u = info.underlying;
  return (prepared?: PreparedTx): Line[] => {
    const p = prepared as PreparedWrap | undefined;
    const out: Line[] = [
      line(
        '  You give  ',
        seg(amt(plan.pull, u.decimals, u.symbol), 'bold'),
        seg(' (public)', 'dim'),
      ),
      line(
        '  You get   ',
        seg(amt(plan.wrapped, info.decimals, info.symbol), 'bold'),
        seg(' (confidential)', 'dim'),
      ),
    ];
    if (plan.dust > 0n) {
      out.push(
        line(
          '  Stays     ',
          seg(amt(plan.dust, u.decimals, u.symbol), 'yellow'),
          seg(` (below 1 ${info.symbol} unit)`, 'dim'),
        ),
      );
    }
    if (p) {
      let n = 1;
      if (p.steps.includes('reset'))
        out.push(line(`  Step ${n++}    `, 'Reset the old approval to 0 (this token needs it)'));
      if (p.steps.includes('approve')) {
        out.push(
          line(
            `  Step ${n++}    `,
            `Approve ${info.symbol} to take exactly ${amt(plan.pull, u.decimals, u.symbol)} (not unlimited)`,
          ),
        );
      }
      out.push(
        line(
          `  Step ${n}    `,
          p.steps.length > 1
            ? 'Wrap (simulated after the approval)'
            : 'Wrap (the existing approval covers it)',
        ),
      );
      if (p.feeEstimated) out.push(dimLine('  The fee below includes an estimate for the wrap.'));
    }
    return out;
  };
}

/** Start the Review of a checked wrap. */
export function startWrap(s: AppState, info: WrapperInfo, plan: WrapPlan): Effect[] {
  const u = info.underlying;
  const network = s.network;
  let wrapWallet = s.wallet?.address ?? '';
  const action: TxAction = {
    kind: 'wrap',
    token: info.address,
    title: `Wrap ${amt(plan.pull, u.decimals, u.symbol)} into ${amt(plan.wrapped, info.decimals, info.symbol)}`,
    short: `wrap ${formatAmount(plan.pull, u.decimals)} ${u.symbol}`,
    warning: ['The wrapped amount is public on-chain; later balances and transfers are private.'],
    then: 'balances',
    details: wrapDetails(info, plan),
    custom: {
      prepare: async (deps, signer, net) => {
        // Re-read the wrapper right before signing: a cached rate never decides amounts.
        const fresh = await deps.backend.wrapperInfo(info.address, net);
        if (!fresh || fresh.rate !== info.rate || fresh.underlying.address !== u.address) {
          throw new WalletTxError(
            'NOT_A_WRAPPER',
            'The wrapper changed since this screen was opened.',
            'Its rate or underlying token is not what the screen showed.',
            'Open Wrap again to see the current numbers. Nothing was sent.',
          );
        }
        const session = sessionOf(deps, signer, net) ?? undefined;
        wrapWallet = signer.address;
        return deps.backend.prepareWrap(signer, info, plan.pull, net, { session });
      },
      // Recorded in History as it confirms, or as unconfirmed (wrapHistory.ts).
      send: (prepared, hooks) =>
        sendWrapRecorded(
          prepared as PreparedWrap,
          { network, wallet: wrapWallet, info, amount: plan.wrapped },
          hooks,
        ),
      done: async (_deps, result) => {
        const r = result as Awaited<ReturnType<PreparedWrap['send']>>;
        const notice: Line[] = [
          line(
            '  ',
            seg(
              `✔ Wrapped ${amt(plan.pull, u.decimals, u.symbol)} → ${amt(plan.wrapped, info.decimals, info.symbol)}`,
              'green bold',
            ),
          ),
        ];
        if (
          r.balanceCheck === 'moved' &&
          r.balanceBefore !== undefined &&
          r.balanceAfter !== undefined
        ) {
          notice.push(
            dimLine(
              `    ${info.symbol} ${formatAmount(r.balanceBefore, info.decimals)} → ${formatAmount(r.balanceAfter, info.decimals)}`,
            ),
          );
        } else if (r.balanceCheck === 'unchanged') {
          notice.push(
            line(
              seg(
                `    ! Your ${info.symbol} balance did not change. Check the explorer.`,
                'yellow',
              ),
            ),
          );
        } else if (r.balanceCheck === 'unknown') {
          notice.push(dimLine(`    Couldn't re-check the ${info.symbol} balance just now.`));
        }
        if (plan.dust > 0n) notice.push(dimLine(`    ${describeWrapPlan(plan, info).stays}`));
        notice.push(
          dimLine(
            `    tx ${shortHash(r.txHash)}${r.approveTxHash ? ` · approval ${shortHash(r.approveTxHash)}` : ''}`,
          ),
        );
        return {
          notice,
          update: (st) => {
            if (r.balanceAfter !== undefined && st.network === network) {
              st.balances[info.address.toLowerCase()] = {
                value: r.balanceAfter,
                at: st.now,
                source: 'session',
              };
            }
            return loadWrapData(st);
          },
        };
      },
      failNotice: (error) =>
        error.code === 'WRAP_APPROVED_ONLY'
          ? [
              line('  ', seg(`! ${error.title}`, 'yellow bold')),
              dimLine(`    ${error.cause ?? ''}`),
              line(
                seg(
                  '    Wrap again: the approval is in place, so only the wrap is sent.',
                  'yellow',
                ),
              ),
            ]
          : null,
    },
  };
  return begin(s, action);
}

/** Start the Review of an unwrap (step 1, then step 2 in the background). */
export function startUnwrap(s: AppState, info: WrapperInfo, plan: UnwrapPlan): Effect[] {
  const u = info.underlying;
  const network = s.network;
  let usedSigner: UnlockedSigner | null = null;
  const action: TxAction = {
    kind: 'unwrap',
    token: info.address,
    title: `Unwrap ${amt(plan.amount, info.decimals, info.symbol)} into ${amt(plan.receive, u.decimals, u.symbol)}`,
    short: `unwrap ${formatAmount(plan.amount, info.decimals)} ${info.symbol}`,
    warning: [
      'The unwrapped amount becomes public on-chain.',
      'This one confirmation covers both steps.',
    ],
    then: 'balances',
    details: (prepared) => {
      const p = prepared as PreparedUnwrap | undefined;
      return [
        line(
          '  You burn  ',
          seg(amt(plan.amount, info.decimals, info.symbol), 'bold'),
          seg(' (confidential)', 'dim'),
        ),
        line(
          '  You get   ',
          seg(amt(plan.receive, u.decimals, u.symbol), 'bold'),
          seg(' (public)', 'dim'),
        ),
        line(
          '  Step 1    ',
          `Request: burns ${amt(plan.amount, info.decimals, info.symbol)} and asks Zama to decrypt the amount`,
        ),
        line(
          '  Step 2    ',
          `Finish: publish the decrypted amount with its proof; ${u.symbol} arrives`,
        ),
        ...(p
          ? [
              dimLine(
                `  Step 2 costs about ${formatEth(p.finalizeFeeWei)} ETH more, checked when it is sent.`,
              ),
            ]
          : []),
      ];
    },
    custom: {
      prepare: async (deps, signer, net) => {
        const problem = deps.backend.readinessProblem(net);
        if (problem) {
          throw new WalletTxError(
            'UNKNOWN',
            'Unwrapping is not set up for this network.',
            problem,
            'Open Settings to add what is missing.',
          );
        }
        const earlier = unconfirmedRequest(net, signer.address, info.address);
        if (earlier) throw unconfirmedRequestError(earlier);
        assertUnwrapStoreWritable();
        usedSigner = signer;
        const session = sessionOf(deps, signer, net) ?? undefined;
        return deps.backend.prepareUnwrap(signer, info, plan.amount, net, { session });
      },
      send: async (prepared, hooks) => {
        const { result, entry } = await sendUnwrapRequest(
          prepared as PreparedUnwrap,
          { network, wallet: usedSigner!.address, info, amount: plan.amount },
          hooks,
        );
        return { ...result, entry } as typeof result;
      },
      done: async (deps, result) => {
        const entry = (result as { entry?: UnwrapEntry }).entry;
        // The key stays in this closure for step 2 only: the user confirmed both steps.
        const notice =
          entry && usedSigner
            ? await finishInBackground(deps, usedSigner, entry, FINISH_TRIES)
            : [
                line(
                  '  ',
                  seg('! Step 1 confirmed. Home › Finish unwrap sends step 2.', 'yellow bold'),
                ),
              ];
        usedSigner = null;
        return { notice, update: (st) => [reload(st), ...loadWrapData(st), ...decryptAll(st)] };
      },
    },
  };
  return begin(s, action);
}

/** Open the Review for an action and start its checks (when unlocked). */
function begin(s: AppState, action: TxAction): Effect[] {
  s.txAction = action;
  return [...open(s, 'tx-review'), ...txChecks(s)];
}

/**
 * "Finish unwrap": check the chain first, then either say where it stands (finished,
 * waiting for a confirmation) or open the Review for step 2.
 */
export function finishPending(s: AppState, id: string): Effect[] {
  const entry = s.data.unwraps.find((e) => e.id === id);
  if (!entry || s.wrap.finishing) return [];
  s.wrap.finishing = id;
  s.busy = 'Checking the unwrap on-chain';
  const label = `${amt(BigInt(entry.amount), entry.decimals, entry.symbol)} → ${entry.underlying.symbol}`;
  return [
    effect('unwrap-check', async (deps) => {
      let message: Line[] | null = null;
      let ready: UnwrapEntry | null = null;
      try {
        const r = await reconcileUnwrap(deps.backend, entry);
        switch (r.next.kind) {
          case 'done':
            message = [line('  ', seg(`✔ Already finished: ${label}`, 'green'))];
            break;
          case 'failed':
            message = [line('  ', seg(`✗ ${label}: ${r.next.reason}`, 'red'))];
            break;
          case 'unclear':
            message = unclearNotice(deps, r.entry, label, r.next.reason);
            break;
          case 'wait-request':
            message = [
              line(
                '  ',
                seg(
                  `! The request for ${label} is not ${r.next.missing ? 'visible to the network' : 'mined'} yet.`,
                  'yellow',
                ),
              ),
              dimLine(`    tx ${entry.requestTxHash} · not sent again. Try in a minute.`),
            ];
            break;
          case 'wait-finalize':
            message = [
              line('  ', seg(`! Step 2 for ${label} was sent and is not confirmed yet.`, 'yellow')),
              dimLine(
                `    tx ${r.entry.finalizeTxHash} · not sent again. Check it on the explorer.`,
              ),
            ];
            break;
          case 'finalize':
            ready = r.entry;
        }
      } catch (err) {
        message = [
          line('  ', seg(`✗ ${describeError(err, { action: 'unwrap check' }).title}`, 'red')),
        ];
      }
      return (st) => {
        st.wrap.finishing = undefined;
        st.busy = null;
        if (!ready) {
          st.flash = message;
          return [reload(st)];
        }
        return [reload(st), ...startFinish(st, ready)];
      };
    }),
  ];
}

/** The Review for step 2 of a pending unwrap. */
function startFinish(s: AppState, entry: UnwrapEntry): Effect[] {
  const u = entry.underlying;
  const label = `${amt(BigInt(entry.amount), entry.decimals, entry.symbol)} → ${u.symbol}`;
  return begin(s, {
    kind: 'unwrap-finish',
    token: entry.token,
    title: `Finish unwrap: ${label}`,
    short: `unwrap: step 2`,
    warning: ['The unwrapped amount becomes public on-chain.'],
    then: 'balances',
    details: (prepared) => {
      const p = prepared as PreparedFinalize | undefined;
      return [
        ...(p
          ? [
              line(
                '  You get   ',
                seg(amt(p.receive, u.decimals, u.symbol), 'bold'),
                seg(` (public; ${amt(p.value, entry.decimals, entry.symbol)} were burnt)`, 'dim'),
              ),
            ]
          : []),
        dimLine(`  Request   ${entry.requestTxHash}`),
      ];
    },
    custom: {
      prepare: (deps, signer) => prepareFinish(deps.backend, signer, entry),
      send: async (prepared, hooks) => {
        const r = await sendFinish(prepared as PreparedFinalize, entry, hooks);
        return { txHash: r.txHash, blockNumber: r.blockNumber };
      },
      done: async (_deps, result, prepared) => {
        const p = prepared as PreparedFinalize;
        return {
          notice: finishNotice(
            entry,
            p.value === 0n
              ? `! ${label}: the request burnt 0, so nothing arrives.`
              : `✔ Unwrapped ${amt(p.value, entry.decimals, entry.symbol)}: ${amt(p.receive, u.decimals, u.symbol)} arrived`,
            p.value === 0n ? 'yellow bold' : 'green bold',
            result.txHash ? [dimLine(`    step 2 tx ${shortHash(result.txHash)}`)] : [],
          ),
          update: (st) => [reload(st), ...loadWrapData(st)],
        };
      },
    },
  });
}

/** Home / Balances items for unwraps that are not finished (unnumbered; key `u` on the first). */
export function pendingUnwrapItems(s: AppState): Item[] {
  return s.data.unwraps.map((e, i) => ({
    label: `Finish unwrap: ${amt(BigInt(e.amount), e.decimals, e.symbol)} → ${e.underlying.symbol}`,
    key: i === 0 ? 'u' : undefined,
    nonum: true,
    value: s.wrap.finishing === e.id ? 'checking…' : describeUnwrapState(e),
    valueStyle: 'yellow',
    act: (st: AppState) => finishPending(st, e.id),
  }));
}

/** The dim line under a wrapper's row on Balances: `↳ wraps ZAMA · 12.5 ZAMA public`. */
export function wrapRowNote(s: AppState, token: string): Line | null {
  const info = wrapperOf(s, token);
  if (!info) return null;
  const st = publicState(s, token);
  const u = info.underlying;
  return dimLine(
    `             ↳ wraps ${u.symbol}${st ? ` · ${amt(st.balance, u.decimals, u.symbol)} public in this wallet` : ''}`,
  );
}

/** Check the amount on the Wrap / Unwrap screen and open the Review. */
export function continueWrap(
  s: AppState,
  mode: 'wrap' | 'unwrap',
  info: WrapperInfo,
  plan: WrapPlan | UnwrapPlan | { ok: false; error: string; hint: string },
): Effect[] {
  if (!plan.ok) {
    s.fieldError = [plan.error, plan.hint];
    return [];
  }
  // Locked: the Review asks to unlock, then its checks decrypt the balance first.
  return mode === 'wrap'
    ? startWrap(s, info, plan as WrapPlan)
    : startUnwrap(s, info, plan as UnwrapPlan);
}
