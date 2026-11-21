/**
 * The send wizard's logic: Token → Recipient → Amount → Review → Sign, the countdown,
 * the non-blocking broadcast and the outcome. Screens call into here; this module never
 * draws anything.
 *
 * Safety rules carried over from the CLI (see AGENTS.md): checks (chain, balance,
 * simulation, gas) run before anything is signed; once a transaction is handed to the
 * network every failure keeps its hash and is never presented as "try again".
 */

import { recordTransferTransaction } from '../../core/token/TokenService.js';
import { WalletTxError } from '../../core/token/txErrors.js';
import { describeError } from '../errors.js';
import { formatExactAmount, parseFriendlyAmount } from '../../core/send/amount.js';
import { findLookAlike, parseAddressInput, shortAddress } from '../../core/send/recipient.js';
import { resolveRecipient, resolveToken } from '../../core/send/resolve.js';
import { formatTokenAmount } from '../../utils/formatting.js';
import { loadUiPrefs, saveUiPrefs } from '../../storage/UiPrefsStore.js';
import type { TokenEntry } from '../../core/token/TokenRegistry.js';
import { effect, type Effect } from '../effects.js';
import { formatAmount, formatEth, shortHash } from '../format.js';
import { open, openInstead, popTo } from '../nav.js';
import {
  clearSecrets,
  frame,
  goHome,
  isUnlocked,
  lockWallet,
  type AppState,
  type ErrorView,
  type Recipient,
} from '../state.js';
import { dimLine, line, seg, type Line } from '../text.js';
import { decryptAll, refreshEth, reload, sessionOf } from './data.js';

/** Codes that mean the transaction was handed to the network and may be on-chain. */
export const AFTER_BROADCAST = new Set<string>(['SENT_UNCONFIRMED', 'TX_REVERTED', 'TX_REPLACED']);

/** Minimum countdown on mainnet, even when the countdown is switched off. */
export const MAINNET_MIN_COUNTDOWN = 5;

/** The token of the current draft, if it is still tracked. */
export function draftToken(s: AppState): TokenEntry | undefined {
  const addr = s.send.token?.toLowerCase();
  return s.data.tokens.find((t) => t.address.toLowerCase() === addr);
}

/** Best known balance for a token: decrypted this session, else cached. */
export function knownBalance(s: AppState, tokenAddress: string) {
  return s.balances[tokenAddress.toLowerCase()];
}

/** Label for a recipient: contact name or short address. */
export function recipientLabel(to: Recipient): string {
  return to.name ?? shortAddress(to.address);
}

/** A key for the draft; a prepared transfer is only valid for the draft it was made for. */
function draftKey(s: AppState): string {
  return [s.network, s.wallet?.address, s.send.token, s.send.to?.address, s.send.value].join('|');
}

/** True when the draft has been checked and can be sent as is. */
export function isPrepared(s: AppState): boolean {
  return Boolean(s.send.prepared) && s.send.preparedFor === draftKey(s);
}

/** Why sending cannot start right now, or null. */
function cannotSend(s: AppState): string | null {
  if (!s.wallet) return 'Create or import a wallet first.';
  if (s.data.tokens.length === 0) return 'Add a token first: Tokens › Add token by address.';
  return null;
}

function stickyFor(s: AppState) {
  return s.data.prefs.networks[s.network];
}

/** Start a fresh send (Home › Send). The last token used on this network is preselected. */
export function startSend(s: AppState): Effect[] {
  const problem = cannotSend(s);
  if (problem) {
    s.flash = [line('  ', seg(problem, 'yellow'))];
    return [];
  }
  const sticky = stickyFor(s).lastToken?.toLowerCase();
  const idx = Math.max(
    0,
    s.data.tokens.findIndex((t) => t.address.toLowerCase() === sticky),
  );
  s.send = { token: s.data.tokens[idx].address, origin: 'wizard' };
  delete s.inputs.amount;
  delete s.inputs.paste;
  const effects = open(s, 'send-token');
  s.stack[s.stack.length - 1].cur = idx;
  return effects;
}

/** Token step: choose a token and continue to Recipient. */
export function chooseToken(s: AppState, address: string): Effect[] {
  if (s.send.token?.toLowerCase() !== address.toLowerCase()) delete s.inputs.amount;
  s.send.token = address;
  const effects = open(s, 'send-to');
  // Preselect the last recipient used on this network.
  const last = stickyFor(s).lastRecipient?.toLowerCase();
  const ci = s.data.contacts.findIndex((c) => c.address.toLowerCase() === last);
  if (ci >= 0) s.stack[s.stack.length - 1].cur = ci;
  return effects;
}

/** Recipient step: a saved contact. */
export function chooseContact(s: AppState, contact: { name: string; address: string }): Effect[] {
  s.send.to = {
    address: contact.address,
    name: contact.name,
    isNew: isNewAddress(s, contact.address),
  };
  return open(s, 'send-amount');
}

/**
 * True when this wallet never sent to `address` on this network: the first-time note.
 * Saved contacts get it too (a contact can be saved with a wrong address), like `fhew
 * send`.
 */
function isNewAddress(s: AppState, address: string): boolean {
  return !s.data.knownRecipients.includes(address.toLowerCase());
}

/**
 * Recipient step: a pasted address. Checks the checksum, stops on a look-alike of a
 * contact, and marks first-time addresses.
 */
export function submitPastedAddress(s: AppState): Effect[] {
  const parsed = parseAddressInput(s.inputs.paste ?? '');
  if (!parsed.ok) {
    s.fieldError = [parsed.error, 'Paste the full address, starting with 0x.'];
    return [];
  }
  return useAddress(s, parsed.address, 'push');
}

function useAddress(s: AppState, address: string, how: 'push' | 'replace'): Effect[] {
  const go = how === 'push' ? open : openInstead;
  const contact = s.data.contacts.find((c) => c.address.toLowerCase() === address.toLowerCase());
  if (contact) {
    s.send.to = {
      address: contact.address,
      name: contact.name,
      isNew: isNewAddress(s, contact.address),
    };
    return go(s, 'send-amount');
  }
  const lookalike = findLookAlike(address, s.data.contacts);
  if (lookalike) return go(s, 'send-check', { address, contact: lookalike.name });
  s.send.to = { address, isNew: isNewAddress(s, address) };
  return go(s, 'send-amount');
}

/** Look-alike stop: send to the saved contact instead. */
export function useContactInstead(s: AppState, contactName: string): Effect[] {
  const c = s.data.contacts.find((x) => x.name === contactName);
  if (!c) return [];
  s.send.to = { address: c.address, name: c.name, isNew: isNewAddress(s, c.address) };
  return openInstead(s, 'send-amount');
}

/** Look-alike stop: the user checked and wants the pasted address anyway. */
export function usePastedLookalike(s: AppState, address: string): Effect[] {
  s.send.to = { address, isNew: true, lookalike: true };
  return openInstead(s, 'send-amount');
}

/** Parse the amount field against the best known balance. */
export function parseDraftAmount(s: AppState) {
  const t = draftToken(s);
  if (!t) return null;
  const bal = knownBalance(s, t.address);
  return parseFriendlyAmount(s.inputs.amount ?? '', { decimals: t.decimals, balance: bal?.value });
}

/** Amount step: accept the amount and continue to Review. */
export function submitAmount(s: AppState): Effect[] {
  const r = parseDraftAmount(s);
  if (!r) return [];
  if (!r.ok) {
    s.fieldError = [r.error, r.hint];
    return [];
  }
  s.send.value = r.value;
  return [...open(s, 'send-review'), ...reviewChecks(s)];
}

/** Run the pre-send checks for the review screen if the wallet is unlocked. */
export function reviewChecks(s: AppState): Effect[] {
  if (!isUnlocked(s) || isPrepared(s) || s.send.checking) return [];
  const t = draftToken(s);
  const to = s.send.to;
  const value = s.send.value;
  if (!t || !to || value === undefined) return [];
  const key = draftKey(s);
  const signer = s.signer!;
  const network = s.network;
  s.send.prepared = undefined;
  s.send.checking = true;
  return [
    effect('prepare', async (deps) => {
      const problem = deps.backend.readinessProblem(network);
      try {
        if (problem) {
          throw new WalletTxError(
            'UNKNOWN',
            'Sending is not set up for this network.',
            problem,
            'Open Settings to add what is missing.',
          );
        }
        // The session's signature also covers the balance checks before and after.
        const session = sessionOf(deps, signer, network) ?? undefined;
        const prepared = await deps.backend.prepareTransfer(
          signer,
          t.address,
          to.address,
          value,
          network,
          { session },
        );
        const at = deps.now();
        return (st) => {
          st.send.checking = false;
          // Locked meanwhile: the prepared transfer holds the wallet, so it is dropped.
          if (st.signer !== signer || !isUnlocked(st)) return;
          // The draft changed meanwhile: these checks are stale. Check the new draft if
          // its Review is showing, so it never waits on "Simulating…" forever.
          if (draftKey(st) !== key) return onReview(st) ? reviewChecks(st) : undefined;
          st.send.prepared = prepared;
          st.send.preparedFor = key;
          if (st.flash === STILL_CHECKING) st.flash = null;
          st.eth = { wei: prepared.ethBalanceWei, at };
          st.balances[t.address.toLowerCase()] = {
            value: prepared.tokenBalance,
            at,
            source: 'session',
          };
        };
      } catch (err) {
        const error = describeError(err, { action: 'send' });
        return (st) => {
          st.send.checking = false;
          if (st.flash === STILL_CHECKING) st.flash = null;
          if (draftKey(st) !== key) return onReview(st) ? reviewChecks(st) : undefined;
          st.errorView = { error, afterBroadcast: false, showRaw: false };
          if (st.stack[st.stack.length - 1].id === 'send-review') return open(st, 'send-error');
        };
      }
    }),
  ];
}

/** The note for Enter on Review while the checks run; cleared when they finish. */
export const STILL_CHECKING: Line[] = [
  dimLine('  Still checking the transfer. Confirm once the fee and the checks show.'),
];

function onReview(s: AppState): boolean {
  return s.stack[s.stack.length - 1].id === 'send-review';
}

/** After unlocking on the Sign step: back on Review, now with fee and checks. */
export function afterSignUnlock(s: AppState): Effect[] {
  popTo(s, 'send-review');
  return [...reviewChecks(s), ...decryptAll(s)];
}

/** Review: "Confirm and send". Mainnet asks to retype the amount first. */
export function confirmSend(s: AppState): Effect[] {
  if (!isUnlocked(s)) return open(s, 'send-sign');
  if (!isPrepared(s)) {
    // Nothing is queued: the user confirms once the fee and the checks are on screen.
    s.flash = STILL_CHECKING;
    return reviewChecks(s);
  }
  if (s.network === 'mainnet') {
    delete s.inputs.retype;
    return open(s, 'send-retype');
  }
  return startCountdown(s);
}

/** Mainnet guard: the retyped amount must equal the reviewed one exactly. */
export function submitRetype(s: AppState): Effect[] {
  const t = draftToken(s);
  if (!t || s.send.value === undefined) return [];
  const r = parseFriendlyAmount(s.inputs.retype ?? '', { decimals: t.decimals });
  if (!r.ok || r.value !== s.send.value) {
    s.fieldError = [
      "That doesn't match the amount on the review screen.",
      `Type ${formatExactAmount(s.send.value, t.decimals)} to confirm, or press Esc.`,
    ];
    return [];
  }
  return startCountdown(s);
}

/** Countdown length for this send. */
export function countdownSeconds(s: AppState): number {
  const secs = s.data.prefs.countdownSeconds;
  return s.network === 'mainnet' ? Math.max(secs, MAINNET_MIN_COUNTDOWN) : secs;
}

/** Start the cancellable countdown (or broadcast at once when it is off). */
export function startCountdown(s: AppState): Effect[] {
  const secs = countdownSeconds(s);
  if (secs <= 0) return broadcast(s);
  s.countdown = { endsAt: s.now + secs * 1000, total: secs };
  return open(s, 'send-count');
}

/** Esc during the countdown: back to Review, nothing sent. Ctrl+C: Home. */
export function stopCountdown(s: AppState, toHome: boolean): void {
  s.countdown = null;
  if (toHome) {
    goHome(s, [dimLine('  Stopped. Nothing was sent.')]);
    return;
  }
  popTo(s, 'send-review');
  s.flash = [line('  ', seg('✔ Stopped. Nothing was sent.', 'green'))];
}

/** The `fhew send …` command that repeats this send from a shell. */
export function nextTimeCommand(s: AppState, t: TokenEntry, to: Recipient, value: bigint): string {
  const who = to.name && !/\s/.test(to.name) ? to.name : to.address;
  const sameSymbol = s.data.tokens.filter((x) => x.symbol.toLowerCase() === t.symbol.toLowerCase());
  const tok = sameSymbol.length === 1 && !/\s/.test(t.symbol) ? t.symbol.toLowerCase() : t.address;
  // Always name the network: the shell's default network may differ from the TUI's.
  return `fhew send ${who} ${formatTokenAmount(value, t.decimals, t.decimals)} ${tok} -n ${s.network}`;
}

/**
 * Countdown finished: broadcast without blocking. The user is back on Home at once with
 * "1 pending" in the status bar; the outcome arrives as a notice.
 */
export function broadcast(s: AppState): Effect[] {
  const prepared = s.send.prepared;
  const t = draftToken(s);
  const to = s.send.to;
  const value = s.send.value;
  s.countdown = null;
  if (!prepared || !isPrepared(s) || !t || !to || value === undefined || !s.wallet) {
    goHome(s, [
      line(
        '  ',
        seg('Nothing was sent: the checks are out of date. Start the send again.', 'yellow'),
      ),
    ]);
    return [];
  }
  // A prepared transfer is single-use: never broadcast the same one twice.
  s.send.prepared = undefined;
  s.send.preparedFor = undefined;
  const id = s.nextPendingId++;
  const amountText = `${formatAmount(value, t.decimals)} ${t.symbol}`;
  s.pending.push({ id, amountText, toLabel: recipientLabel(to) });
  const network = s.network;
  const from = s.wallet.address;
  const hint = nextTimeCommand(s, t, to, value);
  const lockAfter = s.data.prefs.unlockMinutes === 0;
  goHome(s, [dimLine('  Sending. Keep working; the status bar shows when it confirms.')]);
  // "Every action": the send holds what it needs, so the key goes as soon as it starts.
  if (lockAfter) lockWallet(s);

  return [
    effect('broadcast', async (deps) => {
      // Remember token and recipient for next time, whatever the outcome.
      saveSticky(network, { lastToken: t.address, lastRecipient: to.address });
      try {
        const result = await prepared.send({
          onBroadcast: (txHash) =>
            deps.dispatch((st) => {
              const p = st.pending.find((x) => x.id === id);
              if (p) p.txHash = txHash;
            }),
        });
        // Local bookkeeping must never turn a confirmed transfer into an error, and one
        // failing (history) must not skip the other (repeat-last-send).
        try {
          recordTransferTransaction({
            tokenAddress: t.address,
            tokenSymbol: t.symbol,
            from,
            to: to.address,
            amount: formatTokenAmount(value, t.decimals, t.decimals),
            txHash: result.txHash,
            network,
            blockNumber: result.blockNumber,
          });
        } catch {
          // ignored: history is a convenience
        }
        saveSticky(network, {
          lastSend: { token: t.address, to: to.address, amount: value.toString() },
        });
        const at = deps.now();
        return (st) => {
          st.pending = st.pending.filter((p) => p.id !== id);
          if (st.network === network && result.balanceAfter !== undefined) {
            st.balances[t.address.toLowerCase()] = {
              value: result.balanceAfter,
              at,
              source: 'session',
            };
          }
          const notice: Line[] = [
            line('  ', seg(`✔ Sent ${amountText} to ${recipientLabel(to)}`, 'green bold')),
            dimLine(
              `    tx ${shortHash(result.txHash)} · fee up to ${formatEth(prepared.feeWei)} ETH · ${balanceCheckText(result.balanceCheck, t.symbol)}`,
            ),
            line(seg('    Next time: ', 'dim'), seg(hint, 'cyan')),
          ];
          if (
            to.isNew &&
            !st.data.contacts.some((c) => c.address.toLowerCase() === to.address.toLowerCase())
          ) {
            st.offerSave = to.address;
            notice.push(line(seg('    New address. Press a to save it as a contact.', 'yellow')));
          }
          st.notice = notice;
          if (st.stack.length === 1) st.flash = null; // the "Sending…" line is now outdated
          // Re-decrypt every balance in the background (incoming transfers may have
          // landed too); a no-op when the send locked the wallet again.
          return [reload(st), refreshEth(st), ...decryptAll(st)];
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
          const view: ErrorView = { error, afterBroadcast, showRaw: false, explorerUrl };
          st.lastSendError = view;
          if (st.stack.length === 1) st.flash = null;
          st.notice = [
            line(
              '  ',
              seg(
                `${afterBroadcast ? '!' : '✗'} ${error.title}`,
                afterBroadcast ? 'yellow bold' : 'red bold',
              ),
            ),
            ...(error.txHash ? [dimLine(`    tx ${error.txHash}`)] : []),
            ...(explorerUrl ? [dimLine(`    ${explorerUrl}`)] : []),
            afterBroadcast
              ? line(
                  seg(
                    '    Do not send again until you have checked it. Press e for details.',
                    'yellow',
                  ),
                )
              : dimLine('    Nothing was sent. Press e for details.'),
          ];
          return [reload(st), refreshEth(st)];
        };
      }
    }),
  ];
}

/** Wording of the post-send balance check. */
function balanceCheckText(check: string | undefined, symbol: string): string {
  switch (check) {
    case 'moved':
      return `your ${symbol} balance moved as expected`;
    case 'unchanged':
      return `! your ${symbol} balance did not change; the token may have moved 0`;
    case 'changed':
      return `your ${symbol} balance changed by a different amount (other activity?)`;
    default:
      return "couldn't re-check the balance";
  }
}

/** Merge sticky defaults for a network into the saved preferences. */
function saveSticky(network: AppState['network'], patch: Record<string, unknown>): void {
  try {
    const prefs = loadUiPrefs();
    prefs.networks[network] = { ...prefs.networks[network], ...patch };
    saveUiPrefs(prefs);
  } catch {
    // Sticky defaults are a convenience; never fail a send over them.
  }
}

/**
 * Put a complete draft on the stack as if the user had stepped through the wizard, so Esc
 * walks back through Amount, Recipient and Token with everything filled in.
 */
function prefilledReview(
  s: AppState,
  t: TokenEntry,
  to: Recipient,
  value: bigint,
  amountText: string,
  origin: 'command' | 'repeat',
  flash: Line[],
): Effect[] {
  clearSecrets(s);
  const ti = s.data.tokens.findIndex((x) => x.address === t.address);
  const ci = s.data.contacts.findIndex((c) => c.address.toLowerCase() === to.address.toLowerCase());
  s.send = { token: t.address, to, value, origin };
  s.inputs.amount = amountText;
  s.stack = [
    frame('home'),
    frame('send-token', {}, Math.max(0, ti)),
    frame('send-to', {}, Math.max(0, ci)),
    frame('send-amount'),
    frame('send-review'),
  ];
  s.notice = null;
  s.flash = flash;
  s.fieldError = null;
  return reviewChecks(s);
}

/** `.` on Home: repeat the last send on this network, stopping on Review. */
export function repeatLastSend(s: AppState): Effect[] {
  const last = stickyFor(s).lastSend;
  if (!last || cannotSend(s)) return [];
  const t = s.data.tokens.find((x) => x.address.toLowerCase() === last.token.toLowerCase());
  if (!t) {
    s.flash = [line('  ', seg('The token of your last send is no longer tracked.', 'yellow'))];
    return [];
  }
  const contact = s.data.contacts.find((c) => c.address.toLowerCase() === last.to.toLowerCase());
  const value = BigInt(last.amount);
  const amountText = formatTokenAmount(value, t.decimals, t.decimals);
  // Not a contact (any more): the same look-alike and first-time checks as a paste.
  if (!contact) {
    const fx = prefilledFromAddress(s, t, last.to, value, amountText, 'repeat');
    s.flash = [dimLine('  Repeating your last send. Check it and confirm.')];
    return fx;
  }
  return prefilledReview(
    s,
    t,
    { address: contact.address, name: contact.name, isNew: isNewAddress(s, contact.address) },
    value,
    amountText,
    'repeat',
    [dimLine('  Repeating your last send. Check it and confirm.')],
  );
}

/**
 * Prefill a send to a raw address. It goes through the same look-alike stop and
 * first-time note as a pasted one, then on to Review.
 */
function prefilledFromAddress(
  s: AppState,
  t: TokenEntry,
  address: string,
  value: bigint,
  amountText: string,
  origin: 'command' | 'repeat',
): Effect[] {
  clearSecrets(s);
  s.send = { token: t.address, value, origin };
  s.inputs.amount = amountText;
  s.inputs.paste = address;
  s.stack = [frame('home'), frame('send-token'), frame('send-to'), frame('send-paste')];
  s.notice = null;
  s.fieldError = null;
  const effects = useAddress(s, address, 'push');
  if (s.stack[s.stack.length - 1].id === 'send-amount') {
    return [...effects, ...open(s, 'send-review'), ...reviewChecks(s)];
  }
  return effects;
}

/** The last send on this network, for the Home shortcut. */
export function lastSendSummary(s: AppState): string | null {
  const last = stickyFor(s).lastSend;
  if (!last) return null;
  const t = s.data.tokens.find((x) => x.address.toLowerCase() === last.token.toLowerCase());
  if (!t) return null;
  const contact = s.data.contacts.find((c) => c.address.toLowerCase() === last.to.toLowerCase());
  return `↻ ${formatAmount(BigInt(last.amount), t.decimals)} ${t.symbol} → ${contact?.name ?? shortAddress(last.to)}`;
}

/** `:send <to> <amount> [token]` from the command bar. */
export function commandSend(
  s: AppState,
  args: { to?: string; amount?: string; token?: string },
): Effect[] {
  const problem = cannotSend(s);
  if (problem) {
    s.flash = [line('  ', seg(problem, 'yellow'))];
    return [];
  }
  if (!args.to || !args.amount) return startSend(s);
  const fail = (msg: string) => {
    s.flash = [line('  ', seg(msg, 'red'))];
    return [];
  };

  const sticky = stickyFor(s).lastToken;
  const tokenText = args.token ?? sticky ?? s.data.tokens[0].address;
  const tr = resolveToken(tokenText, s.data.tokens);
  if (!tr.ok) return fail(`  ${tr.error}`);
  const t = tr.token;

  const rr = resolveRecipient(args.to, s.data.contacts);
  if (!rr.ok) return fail(`  ${rr.error}`);

  const bal = knownBalance(s, t.address);
  const ar = parseFriendlyAmount(args.amount, { decimals: t.decimals, balance: bal?.value });
  if (!ar.ok) return fail(`  ${ar.error} ${ar.hint}`);

  if (!rr.contact) return prefilledFromAddress(s, t, rr.address, ar.value, args.amount, 'command');
  return prefilledReview(
    s,
    t,
    { address: rr.address, name: rr.contact.name, isNew: isNewAddress(s, rr.address) },
    ar.value,
    args.amount,
    'command',
    [dimLine('  From the command bar. Check it and confirm. Esc steps back through the wizard.')],
  );
}

/** Text describing a token balance for the amount step. */
export function balanceLine(s: AppState, t: TokenEntry): string {
  const b = knownBalance(s, t.address);
  if (!b) return 'Balance not decrypted yet. Unlock on Balances to use half or max.';
  const tag = b.source === 'cache' ? ' (cached)' : '';
  return `You have ${formatExactAmount(b.value, t.decimals)} ${t.symbol}${tag} · 64-bit limit applies`;
}
