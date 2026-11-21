/**
 * Operator changes and disclosure steps: the send-safety flow for transactions that are
 * not transfers. Review (simulation + fee, needs the key) → explicit confirm → the same
 * cancellable countdown as sends (at least 5 s on Mainnet) → sign locally and broadcast
 * without blocking → outcome as a notice on Home. After the broadcast every failure keeps
 * its hash and is shown like a send's (SENT_UNCONFIRMED, TX_REVERTED, TX_REPLACED),
 * never as "try again".
 */

import { rememberOperatorUntil } from '../../storage/UiPrefsStore.js';
import type { DiscloseStage, PreparedDisclose } from '../../core/backend/types.js';
import { describeExpiry, operatorWarning } from '../../core/send/operatorExpiry.js';
import { shortAddress } from '../../core/send/recipient.js';
import { WalletTxError } from '../../core/token/txErrors.js';
import { setCachedAmounts } from '../../storage/AmountCache.js';
import { describeError } from '../errors.js';
import { effect, type Effect } from '../effects.js';
import { formatAmount, formatFee, shortHash } from '../format.js';
import { open, popTo } from '../nav.js';
import { goHome, isUnlocked, lockWallet, type AppState, type TxAction } from '../state.js';
import { dimLine, line, seg, type Line, link } from '../text.js';
import { decryptAll, refreshEth } from './data.js';
import { historyRows } from './history.js';
import { RECHECK_MS } from './send.js';
import { AFTER_BROADCAST, countdownSeconds } from './send.js';

/** The tracked token entry for an action. */
function tokenOf(s: AppState, address: string) {
  return s.data.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

/** Contact name or short address. */
export function addressLabel(s: AppState, address: string): string {
  return (
    s.data.contacts.find((c) => c.address.toLowerCase() === address.toLowerCase())?.name ??
    shortAddress(address)
  );
}

/** Open the review for an action and start its checks (when unlocked). */
function begin(s: AppState, action: TxAction): Effect[] {
  s.txAction = action;
  const fx = open(s, 'tx-review');
  return [...fx, ...txChecks(s)];
}

/** Review granting `operator` on `token` until `until` (unix s). */
export function startOperatorGrant(
  s: AppState,
  token: string,
  operator: string,
  until: number,
  notes: string[] = [],
): Effect[] {
  const t = tokenOf(s, token);
  const who = addressLabel(s, operator);
  return begin(s, {
    kind: 'operator',
    token,
    operator,
    until,
    title: `Let ${who} move your ${t?.symbol ?? 'tokens'} ${describeExpiry(until)}`,
    short: `operator: ${who}`,
    warning: [...notes, ...operatorWarning(t?.symbol ?? 'tokens', until)],
    then: 'operators',
  });
}

/** Review revoking `operator` on `token` (setOperator with until = 0). */
export function startOperatorRevoke(s: AppState, token: string, operator: string): Effect[] {
  const t = tokenOf(s, token);
  const who = addressLabel(s, operator);
  return begin(s, {
    kind: 'operator',
    token,
    operator,
    until: 0,
    title: `Stop ${who} from moving your ${t?.symbol ?? 'tokens'}`,
    short: `revoke: ${who}`,
    then: 'operators',
  });
}

/** Review the next disclosure step for an amount handle. */
export function startDisclose(
  s: AppState,
  token: string,
  handle: string,
  stage: DiscloseStage,
): Effect[] {
  const t = tokenOf(s, token);
  const warning = [
    'Disclosing publishes this amount on-chain. Anyone can read it afterwards,',
    'and it cannot be made private again.',
  ];
  if (stage === 'private') {
    return begin(s, {
      kind: 'disclose-request',
      token,
      handle,
      title: `Step 1 of 2: make this ${t?.symbol ?? ''} amount publicly decryptable`,
      short: 'disclose: step 1',
      warning,
      then: 'history',
    });
  }
  return begin(s, {
    kind: 'disclose',
    token,
    handle,
    title: `Step 2 of 2: publish this ${t?.symbol ?? ''} amount with its decryption proof`,
    short: 'disclose: step 2',
    warning,
    then: 'history',
  });
}

/** Simulate the current action and price it, if the wallet is unlocked. */
export function txChecks(s: AppState): Effect[] {
  const a = s.txAction;
  if (!a || !isUnlocked(s) || a.prepared || a.checking) return [];
  const signer = s.signer!;
  const network = s.network;
  a.checking = true;
  return [
    effect('tx-prepare', async (deps) => {
      try {
        // Custom actions (wrap, unwrap) check what they need themselves.
        const problem =
          a.kind === 'operator' || a.custom ? null : deps.backend.readinessProblem(network);
        if (problem) {
          throw new WalletTxError(
            'UNKNOWN',
            'Disclosure is not set up for this network.',
            problem,
            'Open Settings to add what is missing.',
          );
        }
        const prepared = a.custom
          ? await a.custom.prepare(deps, signer, network)
          : a.kind === 'operator'
            ? await deps.backend.prepareSetOperator(signer, a.token, a.operator!, a.until!, network)
            : a.kind === 'disclose-request'
              ? await deps.backend.prepareDiscloseRequest(signer, a.token, a.handle!, network)
              : await deps.backend.prepareDisclose(signer, a.token, a.handle!, network);
        return (st) => {
          a.checking = false;
          // Locked or replaced meanwhile: the prepared call holds the key, drop it.
          if (st.txAction !== a || st.signer !== signer || !isUnlocked(st)) return;
          a.prepared = prepared;
          st.eth = { wei: prepared.ethBalanceWei, at: deps.now() };
        };
      } catch (err) {
        const error = describeError(err, { action: 'send' });
        return (st) => {
          a.checking = false;
          if (st.txAction !== a) return;
          st.errorView = { error, afterBroadcast: false, showRaw: false };
          if (st.stack[st.stack.length - 1].id === 'tx-review') {
            return open(st, 'send-error', { from: 'action' });
          }
        };
      }
    }),
  ];
}

/** After unlocking on the Sign step: back on Review, now with the checks. */
export function afterTxUnlock(s: AppState): Effect[] {
  popTo(s, 'tx-review');
  return [...txChecks(s), ...decryptAll(s)];
}

/** Review: the explicit confirm. Starts the countdown (or asks to unlock first). */
export function confirmTx(s: AppState): Effect[] {
  const a = s.txAction;
  if (!a) return [];
  if (!isUnlocked(s)) return open(s, 'tx-sign');
  if (!a.prepared) {
    // Never confirm on a result the user has not seen: say to press Enter again.
    s.flash = [dimLine('  Still checking. Press Enter again once the fee and the checks show.')];
    return txChecks(s);
  }
  const secs = countdownSeconds(s);
  if (secs <= 0) return broadcastTx(s);
  s.countdown = { endsAt: s.now + secs * 1000, total: secs, for: 'tx' };
  return open(s, 'tx-count');
}

/** Esc during the countdown: back to Review, nothing sent. Ctrl+C: Home. */
export function stopTxCountdown(s: AppState, toHome: boolean): void {
  s.countdown = null;
  if (toHome) {
    goHome(s, [dimLine('  Stopped. Nothing was sent.')]);
    return;
  }
  popTo(s, 'tx-review');
  s.flash = [line('  ', seg('✔ Stopped. Nothing was sent.', 'green'))];
}

/** Countdown finished: sign and broadcast without blocking; the outcome arrives as a notice. */
export function broadcastTx(s: AppState): Effect[] {
  const a = s.txAction;
  s.countdown = null;
  const prepared = a?.prepared;
  if (!a || !prepared || !s.wallet) {
    goHome(s, [
      line('  ', seg('Nothing was sent: the checks are out of date. Start again.', 'yellow')),
    ]);
    return [];
  }
  // Single-use, like a signed transaction.
  a.prepared = undefined;
  s.txAction = null;
  const id = s.nextPendingId++;
  s.pending.push({ id, amountText: a.short, toLabel: '', label: a.short });
  const network = s.network;
  const holder = s.wallet.address;
  const t = tokenOf(s, a.token);
  const lockAfter = s.data.prefs.unlockMinutes === 0;
  goHome(s, [dimLine('  Sending. Keep working; the status bar shows when it confirms.')]);
  if (lockAfter) lockWallet(s);
  return [
    effect('tx-broadcast', async (deps) => {
      try {
        const hooks = {
          onBroadcast: (txHash: string) =>
            deps.dispatch((st) => {
              const p = st.pending.find((x) => x.id === id);
              if (p) p.txHash = txHash;
            }),
        };
        const result = a.custom?.send
          ? await a.custom.send(prepared, hooks)
          : await prepared.send(hooks);
        if (a.custom) {
          const out = await a.custom.done(deps, result, prepared);
          return (st) => {
            st.pending = st.pending.filter((p) => p.id !== id);
            st.notice = out.notice;
            if (st.stack.length === 1) st.flash = null;
            const more = out.update?.(st) ?? [];
            return [refreshEth(st), ...more];
          };
        }
        let doneText: string;
        if (a.kind === 'operator') {
          try {
            // ERC-7984 has no expiry getter: remember it to show "until …" later.
            rememberOperatorUntil(network, a.token, holder, a.operator!, a.until!);
          } catch {
            // only used for display
          }
          doneText =
            a.until === 0
              ? `✔ Revoked: ${a.short.replace(/^revoke: /, '')} can no longer move your ${t?.symbol ?? 'tokens'}`
              : `✔ ${a.short.replace(/^operator: /, '')} is now an operator ${describeExpiry(a.until!)}`;
        } else if (a.kind === 'disclose-request') {
          doneText = '✔ Step 1 of 2 done: the amount is now publicly decryptable';
        } else {
          const value = (prepared as PreparedDisclose).value;
          try {
            setCachedAmounts(network, [{ handle: a.handle!, value, disclosed: true }]);
          } catch {
            // the on-chain disclosure is what counts
          }
          doneText = `✔ Disclosed ${t ? formatAmount(value, t.decimals) : value} ${t?.symbol ?? ''} publicly`;
        }
        return (st) => {
          st.pending = st.pending.filter((p) => p.id !== id);
          const notice: Line[] = [
            line('  ', seg(doneText, 'green bold')),
            dimLine(
              `    tx ${shortHash(result.txHash)} · fee up to ${formatFee(prepared.feeWei)} ETH`,
            ),
          ];
          if (a.kind === 'disclose-request') {
            notice.push(
              dimLine('    In a minute, open History › Disclose an amount again for step 2.'),
            );
          }
          st.notice = notice;
          if (st.stack.length === 1) st.flash = null;
          if (
            a.kind === 'operator' &&
            st.operators?.token.toLowerCase() === a.token.toLowerCase()
          ) {
            const row = st.operators.rows.find(
              (r) => r.address.toLowerCase() === a.operator!.toLowerCase(),
            );
            if (row) {
              row.isOperator = a.until !== 0;
              row.until = a.until !== 0 ? a.until : undefined;
            }
          }
          if (st.history) st.history.rows = historyRows(st);
          return [refreshEth(st)];
        };
      } catch (err) {
        const error = describeError(err, { action: 'send' });
        const afterBroadcast =
          (error.code !== undefined && AFTER_BROADCAST.has(error.code)) || Boolean(error.txHash);
        const explorerUrl = error.txHash
          ? deps.backend.explorerTxUrl(error.txHash, network)
          : undefined;
        return (st) => {
          st.pending = st.pending.filter((p) => p.id !== id);
          st.lastSendError = { error, afterBroadcast, showRaw: false, explorerUrl };
          if (st.stack.length === 1) st.flash = null;
          // It may still confirm: look again in a while, like an unconfirmed send, and
          // show what History recorded for it (a wrap or unwrap request).
          if (error.code === 'SENT_UNCONFIRMED') st.recheckAt = st.now + RECHECK_MS;
          if (st.history) st.history.rows = historyRows(st);
          const special = a.custom?.failNotice?.(error);
          if (special) {
            st.notice = special;
            return [refreshEth(st)];
          }
          st.notice = [
            line(
              '  ',
              seg(
                `${afterBroadcast ? '!' : '✗'} ${error.title}`,
                afterBroadcast ? 'yellow bold' : 'red bold',
              ),
            ),
            ...(error.txHash ? [dimLine(`    tx ${error.txHash}`)] : []),
            ...(explorerUrl ? [line('    ', link(explorerUrl, 'dim'))] : []),
            afterBroadcast
              ? line(
                  seg(
                    '    Do not send it again until you have checked it. Press e for details.',
                    'yellow',
                  ),
                )
              : dimLine('    Nothing was sent. Press e for details.'),
          ];
          return [refreshEth(st)];
        };
      }
    }),
  ];
}
