/**
 * Keep the relayer SDK's console output away from the user's screen and from stdout.
 *
 * @zama-fhe/relayer-sdk 0.4.5 prints straight to the console: a one-time
 * "`createInstance` is deprecated. Use the `@zama-fhe/sdk` package instead." warning,
 * and "TFHE module already initialized" style notes. In the full-screen TUI any such
 * line lands in the middle of a frame, and in `--json` mode a `console.log` would
 * corrupt the JSON on stdout. So SDK calls run inside `quietSdk`, which captures those
 * lines. With `FHEW_DEBUG=1` they go to stderr, except while the TUI owns the terminal;
 * the last few are kept for debugging either way.
 */

import { withTimeout } from '../../utils/timeout.js';
import { maskUrlsInText, redactDebugText } from '../../utils/redact.js';
import { stripUnsafeChars } from '../../utils/text.js';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'debug' | 'error';
const METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'debug', 'error'];
const KEEP = 20;

let depth = 0;
let saved: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
let tuiActive = false;
const captured: string[] = [];

/** Tell the SDK console filter whether the TUI owns the terminal (never print then). */
export function setSdkConsoleTuiActive(active: boolean): void {
  tuiActive = active;
}

/** The last SDK console lines captured (newest last). */
export function capturedSdkLines(): readonly string[] {
  return captured;
}

function record(method: ConsoleMethod, args: unknown[]): void {
  const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  captured.push(`[sdk ${method}] ${text}`);
  if (captured.length > KEEP) captured.shift();
  if (process.env.FHEW_DEBUG === '1' && !tuiActive) {
    // Same redaction as technical details: the SDK may print URLs, keys or handles.
    process.stderr.write(
      `[relayer-sdk] ${stripUnsafeChars(maskUrlsInText(redactDebugText(text)))}\n`,
    );
  }
}

function acquire(): () => void {
  if (depth === 0) {
    saved = {};
    for (const m of METHODS) {
      saved[m] = console[m];
      console[m] = (...args: unknown[]) => record(m, args);
    }
  }
  depth += 1;
  // Each call releases exactly once, whether its work settled or its timeout fired.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth -= 1;
    if (depth === 0) {
      for (const m of METHODS) if (saved[m]) console[m] = saved[m]!;
      saved = {};
    }
  };
}

/**
 * Run `fn` (a relayer SDK call) with console output captured instead of printed.
 * Re-entrant: nested and overlapping calls share one capture window.
 *
 * With `timeout`, the call rejects with `TimeoutError` after `timeout.ms` and gives the
 * console back at that moment. The SDK takes no AbortSignal, so a timed-out promise may
 * never settle; if the capture waited for it, the console would stay swallowed and every
 * later error message would vanish. Always pass the timeout here rather than wrapping
 * `quietSdk` in `withTimeout`.
 */
export async function quietSdk<T>(
  fn: () => Promise<T> | T,
  timeout?: { ms: number; what: string },
): Promise<T> {
  const release = acquire();
  try {
    const work = Promise.resolve().then(fn);
    if (!timeout) return await work;
    return await withTimeout(work, timeout.ms, timeout.what);
  } finally {
    release();
  }
}
