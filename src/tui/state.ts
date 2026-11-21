/**
 * The TUI's whole state, and navigation helpers (the router and back-stack).
 *
 * State is a plain object owned by the app loop. Key handlers and effect results mutate
 * it in place and never perform I/O themselves; I/O is described as `Effect`s that the
 * terminal shell runs. That keeps every screen's behaviour unit-testable without a TTY.
 */

import type {
  BackendKind,
  DiscloseStage,
  PreparedDisclose,
  PreparedSend,
  PreparedTx,
  UnlockedSigner,
} from '../core/backend/types.js';
import type { DecryptSession } from '../core/fhe/DecryptSession.js';
import type { NetworkName } from '../core/network/NetworkConfig.js';
import type { TokenInfo } from '../core/token/TokenService.js';
import type { TokenCheck } from '../core/token/erc7984Check.js';
import type { FindResult } from '../core/token/findTokens.js';
import type { ScanProgress } from '../core/token/tokenScan.js';
import type { ShownError } from './errors.js';
import type { Snapshot } from './snapshot.js';
import type { Line } from './text.js';

/** One entry on the back-stack: a screen, its cursor and optional parameters. */
export interface Frame {
  id: string;
  cur: number;
  params: Record<string, string>;
  /** First row of the screen's scrolling list in view (PgUp/PgDn). */
  scroll?: number;
  /** Rows the list window showed in the last frame: one PgUp/PgDn step. */
  page?: number;
  /** The menu item the cursor was on when last drawn (components/list.ts stableCursor). */
  curId?: string;
}

/** A recipient chosen in the send wizard. */
export interface Recipient {
  address: string;
  /** Contact name, when the address is a saved contact. */
  name?: string;
  /** Not a contact and never sent to before: show the first-time note. */
  isNew: boolean;
  /** The user chose to send to an address that looks like a contact. */
  lookalike?: boolean;
}

/** The send wizard's draft. Kept across Esc so stepping back never loses input. */
export interface SendDraft {
  token?: string;
  to?: Recipient;
  /** Exact amount in base units, set when the amount step is accepted. */
  value?: bigint;
  /** Prepared (simulated) transfer for the current draft, once checks pass. */
  prepared?: PreparedSend;
  /** Key of the draft `prepared` belongs to; a changed draft must be checked again. */
  preparedFor?: string;
  /** True while the checks run. */
  checking?: boolean;
  /** Where the draft came from, for the notice on the review screen. */
  origin?: 'wizard' | 'command' | 'repeat';
}

/** A broadcast send waiting for its confirmation. */
export interface PendingSend {
  id: number;
  amountText: string;
  toLabel: string;
  txHash?: string;
  /** For operator changes and disclosures: what is pending, instead of "-amount". */
  label?: string;
}

/**
 * A non-transfer transaction being reviewed (operator change, disclosure step). Runs
 * through the same review → countdown → sign-and-broadcast flow as a send.
 */
export interface TxAction {
  kind: 'operator' | 'disclose-request' | 'disclose';
  /** Token contract address. */
  token: string;
  /** What will happen, in one line, e.g. "Let bob move your cUSDC until 22 Nov 14:05". */
  title: string;
  /** Short text for the pending row and notices, e.g. "operator: bob". */
  short: string;
  /** Strong warning lines shown on review (operators). */
  warning?: string[];
  operator?: string;
  until?: number;
  handle?: string;
  prepared?: PreparedTx | PreparedDisclose;
  checking?: boolean;
  /** Screen to return to once broadcast. */
  then: 'operators' | 'history';
}

/** Operator status of one address for the selected token. */
export interface OperatorRow {
  address: string;
  label: string;
  isOperator: boolean;
  /** Expiry (Unix seconds) of a grant made from this computer; undefined = unknown. */
  until?: number;
}

/** A transaction error shown on the error screen. */
export interface ErrorView {
  error: ShownError;
  /** True once a transaction was handed to the network: never offer "try again". */
  afterBroadcast: boolean;
  showRaw: boolean;
  explorerUrl?: string;
}

/** A decrypted or cached token balance. */
export interface BalanceEntry {
  value: bigint;
  /** When it was decrypted (ms since epoch); undefined for old cache entries. */
  at?: number;
  /** 'session' = decrypted while this TUI ran; 'cache' = read from the balance cache. */
  source: 'session' | 'cache';
}

/** One row of the Doctor screen (shared with `fhew doctor`). */
export type { DoctorRow } from '../core/doctor.js';
import type { DoctorRow } from '../core/doctor.js';

/** The complete UI state. */
export interface AppState {
  stack: Frame[];
  /** Current time (ms), advanced by ticks; render uses it for ages and spinners. */
  now: number;
  network: NetworkName;
  backendKind: BackendKind;
  data: Snapshot;
  wallet: { name: string; address: string } | null;
  /** The decrypted wallet. Held in memory only while unlocked; dropped on lock and exit. */
  signer: UnlockedSigner | null;
  unlockedUntil: number | null;
  eth: { wei: bigint; at: number } | null;
  balances: Record<string, BalanceEntry>;
  decrypting: boolean;
  /** Tokens (lowercase address) being re-decrypted right now: Home shows a spinner per row. */
  refreshing: Record<string, true>;
  /**
   * User-decrypt keypair + signature for the unlocked wallet (one signature for every
   * tracked token). Memory only; dropped with the key on lock, auto-lock, switch and exit.
   */
  decryptSession: DecryptSession | null;
  /** Text fields, by field id. Kept when stepping back; secret fields are cleared on leave. */
  inputs: Record<string, string>;
  /** Validation message under the current screen's field: [problem, hint]. */
  fieldError: [string, string] | null;
  /** Result of the last action, shown above the screen body until the next navigation. */
  flash: Line[] | null;
  /** Longer-lived message for Home (e.g. a confirmed send). */
  notice: Line[] | null;
  help: boolean;
  /** The list filter being typed (`/`): its field id, or null. */
  filtering: string | null;
  /** Command bar text, or null when the bar is closed. */
  cmd: string | null;
  quitArmed: boolean;
  /** Text shown with a spinner while an effect runs on the current screen. */
  busy: string | null;
  send: SendDraft;
  /** `tx` counts down a TxAction instead of the send draft. */
  countdown: { endsAt: number; total: number; for?: 'send' | 'tx' } | null;
  txAction: TxAction | null;
  /** The Disclose screen's view of one amount handle. */
  disclose: {
    handle: string;
    token: string;
    stage?: DiscloseStage;
    loading: boolean;
    error?: string;
  } | null;
  operators: { token: string; rows: OperatorRow[]; loading: boolean; error?: string } | null;
  pending: PendingSend[];
  nextPendingId: number;
  errorView: ErrorView | null;
  /** The error of the last send that failed after broadcast, reachable from Home. */
  lastSendError: ErrorView | null;
  /** New address from the last confirmed send, offered for saving on Home. */
  offerSave: string | null;
  history: {
    rows: HistoryRow[];
    loading: boolean;
    error?: string;
    /** Amounts are being decrypted in the background. */
    decrypting?: boolean;
  } | null;
  doctor: DoctorRow[] | null;
  /** Find tokens: progress while scanning, then the candidates. */
  find: {
    phase: 'scanning' | 'checking' | 'done';
    progress?: ScanProgress;
    result?: FindResult;
    error?: string;
  } | null;
  /** The failed ERC-7984 check shown on "Add anyway?" (token-add-confirm). */
  tokenCheck: TokenCheck | null;
  /** Tokens the backend suggests during first-run setup (loaded on the Token step). */
  suggested?: TokenInfo[];
  /** First-run setup is running (no wallet existed at start, or setup is not finished). */
  setup: boolean;
  /** Set by the quit action; the shell restores the terminal and exits. */
  quit: boolean;
  /**
   * When to refresh ETH, balances and history again after a send ended unconfirmed
   * (it may be mined later); null when nothing is waiting.
   */
  recheckAt?: number | null;
  /** Size of the last frame drawn (screens that adapt to it read this). */
  size: { cols: number; rows: number };
}

/** A display row of the History screen. */
export interface HistoryRow {
  when: string;
  /** Amount handle of a confidential transfer (for decrypting and disclosing). */
  handle?: string;
  tokenAddress?: string;
  /** The amount is public on-chain (this wallet disclosed it). */
  disclosed?: boolean;
  /** Broadcast, but not confirmed yet as far as this wallet knows. */
  unconfirmed?: boolean;
  kind: 'sent' | 'received' | 'eth in' | 'eth out' | 'mint' | 'burn';
  amount: string;
  token: string;
  counterparty: string;
  txHash: string;
}

/** Build the starting state. Opens first-run setup when there is no wallet yet. */
export function initialState(opts: {
  network: NetworkName;
  backendKind: BackendKind;
  data: Snapshot;
  now: number;
}): AppState {
  const { data } = opts;
  const wallet = data.wallets.find((w) => w.name === data.defaultWallet) ?? data.wallets[0] ?? null;
  return {
    stack: [frame(wallet ? 'home' : 'setup-welcome')],
    setup: !wallet,
    now: opts.now,
    network: opts.network,
    backendKind: opts.backendKind,
    data,
    wallet,
    signer: null,
    unlockedUntil: null,
    eth: null,
    balances: {},
    decrypting: false,
    refreshing: {},
    decryptSession: null,
    inputs: {},
    fieldError: null,
    flash: null,
    notice: null,
    help: false,
    cmd: null,
    filtering: null,
    quitArmed: false,
    busy: null,
    send: {},
    countdown: null,
    txAction: null,
    disclose: null,
    operators: null,
    pending: [],
    nextPendingId: 1,
    errorView: null,
    lastSendError: null,
    offerSave: null,
    history: null,
    doctor: null,
    tokenCheck: null,
    find: null,
    quit: false,
    size: { cols: 80, rows: 24 },
  };
}

/** Create a frame. */
export function frame(id: string, params: Record<string, string> = {}, cur = 0): Frame {
  return { id, cur, params };
}

/** The screen on top of the stack. */
export function top(s: AppState): Frame {
  return s.stack[s.stack.length - 1];
}

/** True while first-run setup is running (no wallet exists yet). */
export function inSetup(s: AppState): boolean {
  return s.setup;
}

/**
 * Ids of text fields that hold secrets. They survive moving forward (a wizard needs the
 * password on its last step) but are cleared on Esc, Ctrl+C and once used. `rpcUrl` is
 * here because RPC URLs usually embed a provider key.
 */
export const SECRET_FIELDS = new Set([
  'password',
  'password2',
  'importSecret',
  'apiKey',
  'unlock',
  'rpcUrl',
]);

/** Forget every secret text field. */
export function clearSecrets(s: AppState): void {
  for (const f of SECRET_FIELDS) delete s.inputs[f];
}

/** Open a screen on top of the current one. */
export function push(s: AppState, id: string, params: Record<string, string> = {}): void {
  s.filtering = null;
  if (top(s).id === 'home') s.notice = null;
  s.flash = null;
  s.fieldError = null;
  s.quitArmed = false;
  s.busy = null;
  s.stack.push(frame(id, params));
}

/** Replace the current screen (used where Esc should skip it, e.g. the look-alike stop). */
export function replace(s: AppState, id: string, params: Record<string, string> = {}): void {
  s.filtering = null;
  s.flash = null;
  s.fieldError = null;
  s.busy = null;
  s.stack[s.stack.length - 1] = frame(id, params);
}

/** Go back one screen, keeping entered text (except secrets). */
export function back(s: AppState): void {
  s.filtering = null;
  s.fieldError = null;
  s.busy = null;
  s.quitArmed = false;
  clearSecrets(s);
  if (s.stack.length > 1) {
    s.flash = null;
    s.stack.pop();
    // "Every action" mode: backing out of Review ends the send, so lock at once (as
    // goHome does) instead of leaving the key and the prepared send for the grace period.
    if (s.data.prefs.unlockMinutes === 0 && !sendInProgress(s)) lockWallet(s);
  } else if (inSetup(s)) {
    s.flash = [[{ t: '  This is the start of setup. Press 0 or q to quit.', s: ['dim'] }]];
  } else {
    s.flash = [[{ t: "  You're already here. Press 0 or q to quit.", s: ['dim'] }]];
  }
}

/** Return to the root screen (Home, or the current start of setup) with an optional message. */
export function goHome(s: AppState, flash: Line[] | null = null): void {
  s.filtering = null;
  // "Every action" mode: leaving a send that was unlocked for it locks again.
  if (s.data.prefs.unlockMinutes === 0 && sendInProgress(s)) lockWallet(s);
  s.stack = [frame(s.stack[0].id)];
  s.flash = flash;
  s.fieldError = null;
  s.busy = null;
  s.countdown = null;
  clearSecrets(s);
}

/** Drop the decrypted wallet from memory. */
export function lockWallet(s: AppState): void {
  s.signer = null;
  s.unlockedUntil = null;
  // The decrypt signature is as good as the key for reading balances: it goes too.
  s.decryptSession?.clear();
  s.decryptSession = null;
  // A prepared transfer holds the connected wallet: it must not outlive the unlock.
  s.send.prepared = undefined;
  s.send.preparedFor = undefined;
  if (s.txAction) s.txAction.prepared = undefined;
}

/** True while a send draft is being reviewed or signed (the countdown included). */
export function sendInProgress(s: AppState): boolean {
  return s.stack.some((f) => f.id === 'send-review' || f.id === 'tx-review');
}

/** Whether the wallet is unlocked right now. */
export function isUnlocked(s: AppState): boolean {
  return s.signer !== null && s.unlockedUntil !== null && s.unlockedUntil > s.now;
}
