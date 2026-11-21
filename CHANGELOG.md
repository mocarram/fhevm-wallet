# Changelog

## Unreleased

### New
- Wrap / Unwrap for ERC-20 wrapper tokens (OpenZeppelin `ERC7984ERC20Wrapper`, e.g.
  cZAMA ⇄ ZAMA on Sepolia): `fhew wrap <amount> [token]`, `fhew unwrap <amount> [token]`,
  `fhew unwrap --list | --resume | --forget`, and in the terminal UI Balances/Tokens ›
  Wrap or unwrap, Home › Finish unwrap, `:wrap` / `:unwrap`. Wrap amounts are in the
  public token's units, unwrap amounts in the confidential token's.
- `fhew config --default-network <net>` sets the default network (`-n` on `config` is
  refused); `fhew -n <net>` alone starts the terminal UI on that network.
- `wallet create` and `wallet import` take `--password-stdin`; `wallet remove` and
  `token remove` take `--yes` (and a token symbol).
- Sends, wraps and unwrap requests that were broadcast but not confirmed in time stay in
  History, marked unconfirmed, until a sync finds them.

### Changed
- `--json`: every result names its wallet as `{"name", "address"}` and says `mock`;
  `receive`, `balance`, `send`, `history` and `token find` changed shape (see README).
  Errors use precise codes (`INVALID_AMOUNT`, `TOKEN_NOT_TRACKED`, `WRONG_PASSWORD`,
  `CONFLICTING_TOKENS`, `PASSWORD_STDIN_REQUIRED`, …).
- No escape codes in pipes or files (tables, spinners); marks are ✔ ! ✗ everywhere.
- The terminal UI reads keys and pastes raw (bracketed paste), redraws only what
  changed, scrolls long lists, and shows every token amount exactly.

### Safety
- A wrap that would mint 0 (smaller than one confidential unit, e.g. 1e8 base units of an
  18-decimal token at rate 1e12) is refused before signing; the dust that cannot be
  wrapped is shown and stays in the wallet.
- Approvals are for exactly the amount wrapped, never unlimited.
- Unwraps are recorded when signed and checked against the chain before any step is sent
  again; a second unwrap of a token waits until an unconfirmed one is checked.
- A JSON-RPC batch the RPC dropped ("missing response") is never read as "not a
  wrapper".

### Fixed
- `fhew unwrap --forget` no longer drops a request the RPC cannot see yet but that may
  still be mined; the nonce of each request is recorded and must be taken first.
- A mined unwrap request without its UnwrapRequested log is "check the explorer", never
  "reverted, nothing burnt".
- `fhew unwrap --resume --json` with a wrong password prints exactly one document.
- Terminal UI: unwrap step 2 is not signed once the wallet locked; Home's Finish unwrap
  cannot start a second finish while one runs; wrap/unwrap notices link the explorer.
- Wrap: truthful hint after a reset-only approval; a wrap re-priced above the reviewed
  fee stops (`WRAP_APPROVED_ONLY`); a warning before wrapping again while an earlier
  wrap is unconfirmed.
- Disclosure step 2 is refused when the earlier one cannot be checked (RPC error), and
  is not sent again while an earlier one the RPC cannot see may still be mined (its
  nonce must be taken at a settled block first, as for unwrap requests).
- History: unconfirmed entries are listed first (a limit never hides them); an unwrap
  finished by `--resume` gets its burn in history; counterparties are checksummed.
- History sync on the default endpoints: one request per direction for all tokens, a
  10,000-block first window, and a first sync's pruned start moves forward instead of
  50-block chunks (minutes → seconds on Sepolia). A resumed sync never skips blocks: it
  keeps its cursor contiguous and says which range is still unsearched ("! Synced up
  to block N", never "✔ Synced"; `history --json` adds `sync.unsearched {from, to}`).
- The first wallet created or imported becomes the default; with no default the only
  wallet is used.
- Smaller things: "did not unlock" only for a wrong password (TUI), wrap notes under
  their token rows, wrap breadcrumbs, aligned balance columns and CLI summaries, fees
  with significant digits instead of "0.0000" or 18 decimals, the lock badge minutes,
  Ctrl+C without "Cancelled" when nothing was in progress, no emoji in `fhew history`,
  clearer invalid-address and wallet-address-as-token messages.

### Verified on Sepolia
- Wrap ZAMA → cZAMA (approve + wrap), unwrap cZAMA → ZAMA end to end (request, public
  decryption, finish), and `fhew unwrap --resume` after killing the process after step 1
  and during step 2. See the transaction hashes in `docs/ROADMAP.md` Phase 5.


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
