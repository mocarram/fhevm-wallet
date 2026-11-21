# Changelog

## Unreleased

Requires Node.js 24.11 or later.

### Fixed
- Sending on Sepolia failed during gas estimation: the wallet called `$_transfer`, a
  function that only exists on OpenZeppelin's test mocks. Sends now use the standard
  ERC-7984 `confidentialTransfer`, are simulated before you confirm, and are signed
  locally so a broadcast never loses its transaction hash.
- `--version` reported 1.0.0; dotenv printed a banner to stdout; `-n/--network` typed
  after a subcommand was ignored.

### Security
- Wallet data is owner-only (0700/0600) with atomic writes; shared, planted or
  other-writable data folders are refused at startup with the exact fix to run.
- RPC API keys never appear in output, logs or errors; keys and recovery phrases are
  shown on a screen that is wiped on the next key press; encrypted keystore export.
- RPC timeouts, failover, per-endpoint chain checks, safe redirects and a rate-limit cap;
  commands always exit with a plain-English message.
- Decrypted-balance check before every send and a re-check after confirmation (ERC-7984
  moves 0 instead of failing when the balance is short).
- Mainnet sends without a prompt need both `-n mainnet` and `--mainnet`.

### New
- Full-screen terminal UI: status bar, Esc back, Ctrl+C home, `?` help, `:` command bar,
  `L` lock, `.` repeat last send, first-run setup, look-alike and first-time recipient
  checks, cancellable countdown, non-blocking sends, low-gas nudge.
- `fhew send bob 25 cusdc` with contacts, token symbols and amounts like `1k`, `half`, `max`.
- `fhew doctor`, ERC-7984 check when adding tokens, Find tokens (history scan and token
  lists, multi-select bulk add), receive QR code, `/` list filters, `--json` everywhere.
- One signature decrypts all balances; decrypted amounts in history; operators (grant
  with expiry, revoke); two-step amount disclosure.
- Offline mock backend (`FHEW_BACKEND=mock`) for demos and tests, in its own data folder.

### Not yet verified on-chain
See "Not yet done (needs the user)" in `docs/ROADMAP.md`.
