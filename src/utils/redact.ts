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

  // 2. Secret-looking query parameters: ?apikey=…, &token=…
  out = out.replace(
    /([?&](?:api[_-]?key|d?key|token|access[_-]?token|secret|auth)=)[^&\s"'<>]+/gi,
    `$1${REDACTED}`,
  );

  // 3. Provider keys in the path: https://…/v2/<key>, https://…/v3/<key>
  out = out.replace(/(\/v[23]\/)[A-Za-z0-9_-]{16,}/g, `$1${REDACTED}`);

  // 3b. Bearer tokens and JSON "apiKey": "…" fields.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1${REDACTED}`);
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
