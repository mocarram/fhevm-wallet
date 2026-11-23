# Changelog

## Unreleased

### Changed

- Home shortens balances from a million up (`12.34B`, `18.44T`, rounded down) so
  several tokens fit on one row. Every other screen keeps the exact amount, and the
  Balances and History columns grow with the widest value so nothing goes out of line.

### Fixed

- Fees below 0.000001 ETH (common on Sepolia) read `0.000001 ETH` instead of
  `0.000000000046 ETH`.
- History named `0x0000…0000` as the other side of a wrap or unwrap: it now says
  `from ZAMA` / `to ZAMA`.
- Doctor printed `· ·` before the block number and relayer timing, and the full RPC URL
  made the row too wide; it now shows the RPC host and one separator. In `doctor --json`
  the `detail` text no longer starts with `· `.

### Tests

- Wraps of ERC-20s with 2 and 0 decimals (rate 1): exact both ways, no dust.

## 2.0.0 — 2026-11-23

Requires Node.js 24.11 or later.

### Breaking changes (from 1.1.0)

- Node.js 24.11 or later is required (1.x ran on Node 22).
- `fhew config --network <net>` is now `fhew config --default-network <net>`; the old
  form stops with the exact new command to run.
- `fhew` with no command opens the new full-screen terminal UI instead of the old
  question-by-question menu.
- The data folder must be private: a folder that other users can write to, or one in a
  shared place, is refused at start-up with the command that fixes it. Files the wallet
  owns are tightened to owner-only automatically.
- A `.env` in the current folder only supplies RPC URLs and API keys
  (`SEPOLIA_RPC_URL`, `MAINNET_RPC_URL`, `ETHERSCAN_API_KEY`, `ZAMA_MAINNET_API_KEY`).

Data folders from 1.x keep working: wallets, contacts, tokens and saved settings are
read as they are (checked with a folder made by 1.1.0). Every 1.x command and option
still exists, except `config --network`.

### New

- Full-screen terminal UI: status bar with coloured pills (network, wallet, lock state,
  ETH), Esc back, Ctrl+C home, `?` help, `:` command bar, `L` lock, `.` repeat last
  send, first-run setup, look-alike and first-time recipient checks, cancellable
  countdown, non-blocking sends, low-gas nudge, bracketed paste, scrolling lists and
  exact token amounts.
- `fhew send bob 25 cusdc` with contacts, token symbols and amounts like `1k`, `half`,
  `max`.
- Wrap / Unwrap for ERC-20 wrapper tokens (OpenZeppelin `ERC7984ERC20Wrapper`, e.g.
  cZAMA ⇄ ZAMA on Sepolia): `fhew wrap <amount> [token]`, `fhew unwrap <amount> [token]`,
  `fhew unwrap --list | --resume | --forget`, and in the terminal UI Balances/Tokens ›
  Wrap or unwrap, Home › Finish unwrap, `:wrap` / `:unwrap`. Wrap amounts are in the
  public token's units, unwrap amounts in the confidential token's.
- `fhew doctor`, an ERC-7984 check when adding tokens, Find tokens (history scan and a
  verified Sepolia token list, multi-select bulk add), a receive QR code and `/` list
  filters.
- One signature decrypts all balances; decrypted amounts in history; operators (grant
  with expiry, revoke); two-step amount disclosure.
- `--json` on every non-interactive command: one document, the wallet as
  `{"name", "address"}`, a `mock` flag, and precise error codes (`INVALID_AMOUNT`,
  `TOKEN_NOT_TRACKED`, `WRONG_PASSWORD`, `CONFLICTING_TOKENS`,
  `PASSWORD_STDIN_REQUIRED`, …).
- `fhew config --default-network <net>`; `fhew -n <net>` alone starts the terminal UI
  on that network. `--password-stdin` for scripts (send, balance, history, operator,
  disclose, wrap, unwrap, wallet create/import) and `--yes` to skip confirmations.
- Sends, wraps and unwrap requests that were broadcast but not confirmed in time stay in
  History, marked unconfirmed, until a sync finds them.
- Offline mock backend (`FHEW_BACKEND=mock`) for demos and tests, in its own data folder.

### Fixed

- Sending on Sepolia failed during gas estimation: the wallet called `$_transfer`, a
  function that only exists on OpenZeppelin's test mocks. Sends now use the standard
  ERC-7984 `confidentialTransfer`, are simulated before you confirm, and are signed
  locally so a broadcast never loses its transaction hash.
- Sends that the RPC confirmed but ethers' `wait()` tripped over are confirmed by polling
  the receipt instead of being reported as failed; the fee you review is the fee that
  is signed.
- Read-only calls fail over to the next endpoint on rate, plan, pruned and range
  replies; an endpoint that refuses with HTTP 4xx is skipped for the rest of the run;
  JSON-RPC batches are capped at 10 calls. Sepolia defaults are publicnode, then nodies.
- `--version` reported 1.0.0; dotenv printed a banner to stdout; `-n/--network` typed
  after a subcommand was ignored. No escape codes in pipes or files.

### Security

- Wallet data is owner-only (0700/0600) with atomic writes; shared, planted or
  other-writable data folders are refused at startup with the exact fix to run; damaged
  store files are moved aside instead of overwritten.
- RPC API keys never appear in output, logs or errors; keys and recovery phrases are
  shown on a screen that is wiped when you leave it; encrypted keystore export.
- A decrypted-balance check before every send and a re-check after confirmation
  (ERC-7984 moves 0 instead of failing when the balance is short); the token contract
  itself is refused as a recipient.
- Nothing is sent twice: a transaction that may still be mined is never resent. Unwrap
  requests are recorded when signed, and `unwrap --forget` or a disclosure resend
  happens only once its nonce is taken at a finalized block.
- Wraps never mint 0 (the dust is shown), and approvals are for exactly the amount
  wrapped, never unlimited.
- Mainnet transactions without a prompt need both `-n mainnet` and `--mainnet`.
- CI: actions pinned by commit, base image pinned by digest, installs skip install
  scripts, and npm audit signatures are checked.

### Performance

- `fhew --version` takes about 55 ms instead of about 360 ms: the relayer SDK loads on
  first use and Node's compile cache is kept in a private folder.
- History sync reads all tokens in one request per window and skips pruned history on
  a first sync: a first sync of 4 tokens on Sepolia takes about 1.5 s instead of
  several minutes. A resumed sync never skips blocks and names any range it has not
  searched yet.

### Known limitations

- Nothing was sent on Mainnet during testing.
- The USDT-style approval reset (approve 0 first) and wrappers built on OpenZeppelin
  0.3.x are covered by tests only.
- On the free default Sepolia endpoints, logs older than about 10,000 blocks are pruned.
  A first sync starts from that window (and says so); catching up after a break of more
  than a day or two can take a few minutes or a second run. A full-history RPC URL or an
  Etherscan API key avoids this.

### Verified on Sepolia

- A confidential send (balance checked by decrypting on both wallets), wrap and unwrap
  from the terminal UI and the CLI (including `fhew unwrap --resume` after killing the
  process), operator grant and revoke, a disclosure, the common failure messages,
  upgrading a 1.x data folder, history sync and Find tokens. Transaction hashes are in
  `docs/ROADMAP.md`.
