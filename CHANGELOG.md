# Changelog

## Unreleased

### New
- Wrap / Unwrap for ERC-20 wrapper tokens (OpenZeppelin `ERC7984ERC20Wrapper`, e.g.
  cZAMA ⇄ ZAMA on Sepolia): `fhew wrap <amount> [token]`, `fhew unwrap <amount> [token]`,
  `fhew unwrap --list | --resume | --forget`, and in the terminal UI Balances/Tokens ›
  Wrap or unwrap, Home › Finish unwrap, `:wrap` / `:unwrap`. Wrap amounts are in the
  public token's units, unwrap amounts in the confidential token's.

### Safety
- A wrap that would mint 0 (smaller than one confidential unit, e.g. 1e8 base units of an
  18-decimal token at rate 1e12) is refused before signing; the dust that cannot be
  wrapped is shown and stays in the wallet.
- Approvals are for exactly the amount wrapped, never unlimited.
- Unwraps are recorded when signed and checked against the chain before any step is sent
  again; a second unwrap of a token waits until an unconfirmed one is checked.
- A JSON-RPC batch the RPC dropped ("missing response") is never read as "not a
  wrapper".

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
