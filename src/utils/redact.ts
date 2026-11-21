/**
 * Remove secrets from text before it is logged or shown in an error.
 *
 * RPC URLs often embed API keys (Infura `/v3/<key>`, `?apikey=`), and ethers includes
 * the request URL in some error messages. Transaction hashes and FHE handles are also
 * 64 hex characters, so we cannot blindly mask every 64-hex string; private keys are
 * only masked when labelled as such. Known secret settings are masked by exact value.
 */

/** Settings whose values are secrets wherever they appear. */
const SECRET_ENV_VARS = [
  'ZAMA_MAINNET_API_KEY',
  'ETHERSCAN_API_KEY',
  // Custom RPC URLs often embed a provider key in a form the patterns below can't know
  // (Ankr, QuickNode path tokens). Mask the whole configured URL wherever it appears.
  'MAINNET_RPC_URL',
  'SEPOLIA_RPC_URL',
];

const REDACTED = '[redacted]';

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** RPC URL settings whose path, query and credentials may hold a provider key. */
const RPC_URL_ENV_VARS = ['MAINNET_RPC_URL', 'SEPOLIA_RPC_URL'];

/** Shortest path segment treated as a possible key: `v2`, `rpc`, `sepolia` stay readable. */
const MIN_PATH_SECRET = 8;
/** Shortest query value or credential treated as a possible key. */
const MIN_VALUE_SECRET = 6;

/**
 * The parts of the configured RPC URLs that could be a key: each path segment of at least
 * 8 characters, each query value and the user:password, as written and percent-decoded.
 * Longest first, so a fragment that contains another is masked whole.
 */
export function rpcUrlSecretFragments(env: NodeJS.ProcessEnv = process.env): string[] {
  const fragments = new Set<string>();
  const add = (value: string, min: number) => {
    for (const v of [value, safeDecode(value)]) if (v.length >= min) fragments.add(v);
  };
  for (const name of RPC_URL_ENV_VARS) {
    const value = env[name];
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      continue; // not a URL: step 1 still masks the value as a whole
    }
    for (const segment of url.pathname.split('/')) add(segment, MIN_PATH_SECRET);
    for (const [, v] of url.searchParams) add(v, MIN_VALUE_SECRET);
    for (const part of url.search.slice(1).split('&')) {
      const raw = part.slice(part.indexOf('=') + 1);
      if (part.includes('=')) add(raw, MIN_VALUE_SECRET);
    }
    if (url.hash.length > 1) add(url.hash.slice(1), MIN_VALUE_SECRET);
    add(url.username, MIN_VALUE_SECRET);
    add(url.password, MIN_VALUE_SECRET);
  }
  return [...fragments].sort((a, b) => b.length - a.length);
}

/** decodeURIComponent that returns the input on malformed escapes. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Return `text` with API keys, URL credentials and labelled private keys masked. */
export function redactSecrets(text: string): string {
  let out = text;

  // 1. Exact values of known secret settings (only if long enough to be meaningful).
  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value && value.length >= 6) {
      out = out.replace(new RegExp(escapeRegExp(value), 'g'), REDACTED);
    }
  }

  // 1b. Pieces of the configured RPC URLs, wherever they appear on their own. ethers
  // echoes the request path in `responseBody` and `requestUrl`, often without the host
  // (`internal error for /v2/<key>`), so masking the whole URL is not enough.
  for (const fragment of rpcUrlSecretFragments()) {
    out = out.split(fragment).join(REDACTED);
  }

  // 2. Secret-looking query parameters: ?apikey=…, &token=…
  out = out.replace(
    /([?&](?:api[_-]?key|d?key|token|access[_-]?token|secret|auth)=)[^&\s"'<>]+/gi,
    `$1${REDACTED}`,
  );

  // 3. Provider keys in the path: https://…/v2/<key>, https://…/v3/<key>
  out = out.replace(/(\/v[23]\/)[A-Za-z0-9_-]{16,}/g, `$1${REDACTED}`);

  // 3b. Bearer tokens and JSON "apiKey": "…" fields.
  out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`);
  out = out.replace(/("api[_-]?key"\s*:\s*")[^"]+"/gi, `$1${REDACTED}"`);

  // 4. user:password@ in URLs.
  out = out.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`);

  // 5. Labelled private keys ("privateKey": "0x…", private key: …).
  out = out.replace(
    /(private[\s_-]?key["'\s:=]+)(0x)?[0-9a-fA-F]{64}/gi,
    (_m, label: string) => `${label}${REDACTED}`,
  );

  return out;
}

/**
 * Show only where a URL points, not its credentials: `https://host/…` keeps scheme, host
 * and port but hides path, query, fragment and user:password. Provider keys live in any
 * of those (Infura `/v3/<key>`, QuickNode path tokens, `?apikey=`), and there is no
 * reliable pattern for all of them, so for display we hide them all.
 */
export function maskUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return REDACTED;
  }
  const hidden =
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== '';
  return `${parsed.protocol}//${parsed.host}${hidden ? '/…' : ''}`;
}

/** Mask every http(s) URL inside `text` with `maskUrl`, for one-line user messages. */
export function maskUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+/gi, (url) => maskUrl(url));
}
