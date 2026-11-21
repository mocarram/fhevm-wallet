/**
 * The thin terminal shell around the pure core (app.ts): alternate screen, hidden
 * cursor, raw keypresses, resize, a timer, and running effects.
 *
 * Guarantees:
 * - The terminal is restored (main screen, cursor shown, raw mode off) on quit, on an
 *   uncaught error, on SIGINT/SIGTERM/SIGHUP and on process exit, exactly once.
 * - The decrypted wallet is dropped from memory on lock, timeout and exit; RPC providers
 *   are destroyed on exit (`clearProviderCache`) so no socket keeps the process alive.
 * - No ora spinners or other writers run while the TUI owns the screen: everything is
 *   drawn from state, spinners included.
 * - A terminal that reports 0×0 is drawn at 80×24 instead of producing empty frames.
 * - Bracketed paste is on while the TUI owns the screen and off on every exit path (like
 *   the alternate screen), so a paste arrives as one event (input.ts).
 * - A frame is drawn at most once per input chunk or batch of finished effects, and only
 *   the rows that changed are rewritten: a 42-character paste is one small update, not
 *   42 full redraws.
 */

import { StringDecoder } from 'string_decoder';
import type { ReadStream, WriteStream } from 'tty';
import { clearProviderCache } from '../core/network/ProviderFactory.js';
import type { Backend } from '../core/backend/types.js';
import { showSecretScreen } from '../cli/utils/secretScreen.js';
import { handleKey, handlePaste, isAnimating, render, tick } from './app.js';
import type { Deps, Effect, Updater } from './effects.js';
import { describeError, errorLines } from './errors.js';
import { coalesceBurst, InputParser, isBurst, type InputEvent } from './input.js';
import { lockWallet, type AppState } from './state.js';
import { toAnsi } from './text.js';
import { setSdkConsoleTuiActive } from '../core/fhe/sdkConsole.js';

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';
const CLEAR_LINE_END = '\x1b[K';
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';

/** Streams the shell drives. */
export interface ShellIO {
  input: ReadStream;
  output: WriteStream;
}

/** Options for `runShell`. */
export interface ShellOptions {
  state: AppState;
  backend: Backend;
  io?: ShellIO;
  /** Effects to run once at start (load data, ETH, cached balances). */
  startEffects?: Effect[];
  /** Colour output (off with NO_COLOR or a dumb terminal). */
  color?: boolean;
}

/** How the TUI ended. */
export interface ShellResult {
  /** Process exit code to use: 0 after Quit, 1 after a crash, 128+n after a signal. */
  code: number;
  state: AppState;
}

/** Whether to use colour: honours NO_COLOR and TERM=dumb. */
export function wantsColor(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return env.TERM !== 'dumb';
}

/**
 * Run the TUI until the user quits (or a signal / crash ends it). Resolves after the
 * terminal has been restored.
 */
export function runShell(opts: ShellOptions): Promise<ShellResult> {
  const { state, backend } = opts;
  const { input, output } = opts.io ?? {
    input: process.stdin as ReadStream,
    output: process.stdout as WriteStream,
  };
  const color = opts.color ?? wantsColor();
  // The relayer SDK's console notes must never land inside a frame (sdkConsole.ts).
  setSdkConsoleTuiActive(true);

  return new Promise<ShellResult>((resolve) => {
    // The rows on screen now, to rewrite only those that change; empty = redraw all.
    let lastRows: string[] = [];
    let lastSize = '';
    let drawQueued = false;
    let suspended = false;
    let finished = false;
    let timer: NodeJS.Timeout | null = null;
    let slowTicks = 0;

    const size = () => ({ cols: output.columns ?? 0, rows: output.rows ?? 0 });

    const draw = (force = false) => {
      drawQueued = false;
      if (suspended || finished) return;
      const sz = size();
      const rows = render(state, sz).map((l) => toAnsi(l, color) + CLEAR_LINE_END);
      const key = `${sz.cols}x${sz.rows}`;
      if (force || key !== lastSize || rows.length !== lastRows.length) {
        output.write(HOME + rows.join('\r\n'));
      } else {
        let out = '';
        rows.forEach((r, i) => {
          if (r !== lastRows[i]) out += `\x1b[${i + 1};1H${r}`;
        });
        if (!out) return;
        output.write(out);
      }
      lastRows = rows;
      lastSize = key;
    };

    /** Draw once after the current burst of keys or effects (setImmediate coalesces). */
    const scheduleDraw = () => {
      if (drawQueued) return;
      drawQueued = true;
      setImmediate(() => draw());
    };

    const parser = new InputParser();
    const decoder = new StringDecoder('utf8');
    let flushTimer: NodeJS.Timeout | null = null;

    const enter = () => {
      output.write(ALT_ON + CURSOR_HIDE + PASTE_ON + CLEAR + HOME);
      if (input.isTTY) input.setRawMode(true);
      input.resume();
      lastRows = [];
    };

    const restore = () => {
      try {
        if (input.isTTY) input.setRawMode(false);
      } catch {
        // stdin may already be closed
      }
      input.pause();
      output.write(PASTE_OFF + CURSOR_SHOW + ALT_OFF);
    };

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      if (flushTimer) clearTimeout(flushTimer);
      input.removeListener('data', onData);
      output.removeListener('resize', onResize);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGHUP', onSighup);
      process.removeListener('exit', onExit);
      process.removeListener('uncaughtException', onCrash);
      process.removeListener('unhandledRejection', onCrash);
      // Forget the key, the decrypt signature and anything prepared with them before
      // handing back control.
      lockWallet(state);
      setSdkConsoleTuiActive(false);
      state.send = {};
      restore();
      try {
        clearProviderCache();
      } catch {
        // nothing left to clean
      }
      resolve({ code, state });
    };

    const deps: Deps = {
      backend,
      dispatch: (update) => apply(update),
      showSecret: async (title, lines) => {
        // Hand the terminal to the wipe-on-keypress secret screen, then take it back.
        suspended = true;
        // The secret screen reads keys itself; a paste there is just a key that wipes it.
        output.write(PASTE_OFF);
        try {
          await showSecretScreen(title, lines, { input, output });
        } finally {
          suspended = false;
          parser.flush();
          if (!finished) {
            enter();
            draw(true);
          }
        }
      },
      copyToClipboard: (text) => {
        if (!output.isTTY) return false;
        // OSC 52: most modern terminals put this on the system clipboard.
        output.write(`\x1b]52;c;${Buffer.from(text, 'utf-8').toString('base64')}\x07`);
        return true;
      },
      now: () => Date.now(),
    };

    function apply(update: Updater | void) {
      if (!update || finished) return;
      let more: Effect[] | void = undefined;
      try {
        more = update(state);
      } catch (err) {
        state.flash = errorLines(err);
      }
      if (more) runAll(more);
      afterChange();
    }

    function run(effect: Effect) {
      if (effect.kind === 'quit') {
        state.quit = true;
        finish(0);
        return;
      }
      effect.run(deps).then(apply, (err: unknown) =>
        apply((s) => {
          s.busy = null;
          s.flash = errorLines(err);
        }),
      );
    }

    function runAll(effects: Effect[]) {
      for (const e of effects) run(e);
    }

    function afterChange() {
      if (state.quit) finish(0);
      else scheduleDraw();
    }

    /** Run the keys and pastes of one input chunk, then draw once. */
    function onEvents(events: InputEvent[]) {
      if (suspended || finished || !events.length) return;
      // Several printable keys in one read: a script, a paste without bracketed paste,
      // or very fast typing. Quit then only arms (app.ts), so a pasted "0" cannot quit.
      const burst = isBurst(events);
      state.now = Date.now();
      for (const e of events) {
        if (finished || state.quit) break;
        try {
          runAll(
            e.kind === 'paste' ? handlePaste(state, e.text) : handleKey(state, e.key, { burst }),
          );
        } catch (err) {
          state.flash = errorLines(err);
        }
      }
      afterChange();
    }

    function onData(chunk: Buffer | string) {
      if (suspended || finished) return;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      onEvents(coalesceBurst(parser.feed(text)));
      // A chunk that ended inside an escape sequence or a paste: wait briefly for the
      // rest, then take what is there (a lone Esc is the Esc key).
      if (parser.pending) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          onEvents(parser.flush());
        }, parser.waitMs());
      }
    }

    const onResize = () => draw(true);
    const onSignal = (code: number) => () => finish(code);
    const onSigint = onSignal(130);
    const onSigterm = onSignal(143);
    const onSighup = onSignal(129);
    const onExit = () => {
      // Last resort when something called process.exit(): restore synchronously.
      if (!finished) {
        finished = true;
        restore();
      }
    };
    const onCrash = (err: unknown) => {
      finish(1);
      const d = describeError(err, { fallback: 'The wallet stopped unexpectedly.' });
      process.stderr.write(`fhEVM Wallet stopped unexpectedly: ${d.title}\n`);
    };

    input.on('data', onData);
    output.on('resize', onResize);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.on('SIGHUP', onSighup);
    process.on('exit', onExit);
    process.on('uncaughtException', onCrash);
    process.on('unhandledRejection', onCrash);

    enter();
    state.now = Date.now();
    draw(true);
    runAll(opts.startEffects ?? []);

    // Tick every 120 ms (spinner speed); without animation, redraw at most once a second
    // so ages and the unlock minutes stay current without needless output.
    timer = setInterval(() => {
      if (suspended || finished) return;
      const fx = tick(state, Date.now());
      if (fx.length) runAll(fx);
      slowTicks = (slowTicks + 1) % 8;
      if (fx.length || isAnimating(state) || slowTicks === 0) afterChange();
    }, 120);
  });
}
