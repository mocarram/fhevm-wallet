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
    process.stderr.write(`[relayer-sdk] ${text}\n`);
  }
}

/**
 * Run `fn` (a relayer SDK call) with console output captured instead of printed.
 * Re-entrant: nested and overlapping calls share one capture window.
 */
export async function quietSdk<T>(fn: () => Promise<T> | T): Promise<T> {
  if (depth === 0) {
    saved = {};
    for (const m of METHODS) {
      saved[m] = console[m];
      console[m] = (...args: unknown[]) => record(m, args);
    }
  }
  depth += 1;
  try {
    return await fn();
  } finally {
    depth -= 1;
    if (depth === 0) {
      for (const m of METHODS) if (saved[m]) console[m] = saved[m]!;
      saved = {};
    }
  }
}
