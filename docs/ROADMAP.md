# Roadmap

Living plan for fhEVM Wallet. Agents: pick the first unchecked item in the lowest open phase,
follow the quality loop in `AGENTS.md`, and tick the box in the same merge.

Background: the assessment that produced this plan (root cause of the failed Sepolia send,
dependency audit, security findings) is summarised in each phase below.

---

## Phase 0: Foundations

- [x] Feature branch from `staging`; `main` and `staging` in sync
- [x] Vitest harness with tests across all layers (from the earlier test branch)
- [x] Agent setup: `AGENTS.md`, `CLAUDE.md`, `.claude/agents/{reviewer,security-reviewer,verifier}.md`
- [x] Roadmap and UI design docs

## Phase 1: Fix sending, Node 24, dependencies

Root cause of the failed send: the wallet called `$_transfer(from, to, …)`, a function that
only exists on OpenZeppelin's hardhat-exposed mock. Real ERC-7984 tokens revert during gas
estimation.

- [x] Transfers use `confidentialTransfer(to, handle, proof)`
- [x] `confidentialApprove` replaced by operator helpers (`setOperator`, `isOperator`)
- [x] Minimal ABI lists the real `ConfidentialTransfer` event
- [x] Pre-send simulation (`estimateGas`) with plain-English error translation
- [x] ETH-for-gas check before sending
- [x] Amount bounded to `uint64` after applying decimals; excess precision rejected
- [x] Node 24 in `engines` (`>=24.11`), `.nvmrc`, Dockerfile, CI
- [x] In-range dependency upgrades; `npm audit` clean
- [x] Replace `ts-node` with `tsx` for `npm run dev`

Done: merged to staging after 4 review rounds and independent validation. On-chain check on
Sepolia still to be done by the user (see bottom of this file).

Acceptance: unit tests prove the transfer call encodes `confidentialTransfer`; a simulated
revert produces the translated message; `npm audit` reports 0 vulnerabilities.

## Phase 2: Security hardening

- [x] S1 Data dir 0700, files 0600, atomic writes, loose permissions tightened on start
- [x] S2 `FHEVM_WALLET_HOME`; Docker non-root and persists the data dir
- [x] S3 Decrypted-balance check before sending; balance re-check after confirmation
- [x] S4 uint64 bound (shared with Phase 1)
- [x] S5 Keys and phrases shown on a wipe-on-keypress screen; encrypted keystore export
- [x] S6 `.env` writer rejects newlines and quotes values
- [x] S7 Custom RPC chain ID verified when set and at startup
- [x] S8 Timeouts on all network calls; RPC fallback list
- [x] S9 Tests for all of the above
- [x] S10 Password strength hint (soft warning)
- [x] Secrets redacted in errors and the audit log

Notes on how these landed:

- S6: rather than quoting, the writer only accepts values dotenv reads back verbatim (no
  whitespace, quotes, backslash, `#` or line breaks), so no quoting or escaping is needed.
  Hand-edited quoted values are still read correctly.
- S7: "at startup" is the first RPC request of every process (the provider checks
  `eth_chainId` before anything else), plus a fresh check right before signing a transfer.
- S8: the fallback list is only used while no custom RPC is set; a custom URL is the user's
  choice and is never silently replaced. Raw transactions are never resent to another node.
  Relayer SDK calls take no AbortSignal, so their timeouts stop the wait, not the request.
- Token names and symbols from contracts are sanitised before they are stored or shown.
- Review round (blocking B1, B2, V1 and non-blocking N1-N12, V2-V5), all fixed:
  - Startup tightening only touches the data dir and the files the wallet creates, only
    clears group/other bits (an executable stays executable) and refuses to act when
    `FHEVM_WALLET_HOME` is home, the current folder or `/`.
  - Every CLI error goes through `describeError`: no raw ethers text, custom RPC URLs
    shown with path and query masked (`config --show`, interactive menu, prompts). An e2e
    sweep checks that no private key, password or API key reaches stdout, stderr or any
    data file outside the keystore and the owner-only `.env`.
  - An RPC that accepts the connection and never answers no longer hangs a command:
    sockets are closed on timeout, the error is translated and the exit code is 1.
    Failing commands exit 1; prompts without a terminal end with one sentence.
  - The chain check runs per RPC URL (again after a fail-over; transport errors are not
    cached). The relayer SDK's EIP-1193 view answers `eth_chainId` locally and keeps
    JSON-RPC error data.
  - Pre-send decrypt failures are `BALANCE_CHECK_FAILED`; relayer timeouts are not
    worded as RPC problems. The post-send re-check reads at the receipt's block.
  - `./.env` only supplies RPC URLs and API keys; API key flags take `-` or no value for
    hidden input; the terminal is restored if the process is killed while a secret
    screen is open; `make env` and `docker` create owner-only files.

Acceptance: tests assert file modes; a wrong-chain RPC is refused; no test output or log
contains a private key, phrase or API key.

## Phase 3: Terminal navigation

Matches `docs/ui-design.md`.

- [ ] `@inquirer/prompts` replaces `inquirer`
- [ ] Router with a back-stack; Esc = back one step, Ctrl+C = home, second Ctrl+C on Home quits
- [ ] Status bar: breadcrumb, network badge (red on mainnet), wallet, lock state, ETH, pending
- [ ] Results shown inline above the menu; no "Press Enter to continue"
- [ ] Send wizard (Token → Recipient → Amount → Review → Sign) with step-back that keeps input
- [ ] Number keys 1-9, `0` quits, letter shortcuts on Home, stable numbering
- [ ] Sticky defaults (last token / recipient per network)
- [ ] `?` help for the current screen
- [ ] `:` command bar (`send bob 25 cusdc`, `balances`, `doctor`, `lock`, …)
- [ ] `interactive.ts` split into one module per screen; shared flows with subcommands

Acceptance: e2e test drives Home → Send → Esc back through each step → Ctrl+C → Home in a
pseudo-terminal against the mock backend.

## Phase 4: fhEVM features and smoothness

- [ ] `fhew doctor` (Node, RPC + chain, relayer, ETH, ERC-7984 support per token, data perms)
- [ ] ERC-7984 interface check when adding a token
- [ ] Find tokens: scan ConfidentialTransfer events where the wallet is the recipient and a curated known-token list per network; one checkbox list (Space toggle, a all, Enter bulk-add); unverified tokens unselected and labelled
- [ ] One signature decrypts all tracked balances (session-scoped keypair + signature)
- [ ] Decrypted amounts in history where the user is allowed to decrypt
- [ ] Operators screen (view, grant with expiry, revoke)
- [ ] Disclose a transfer amount
- [ ] `--json` output on non-interactive commands
- [ ] Receive screen with terminal QR code
- [ ] First-run setup (wallet → network → token → gas)
- [ ] Repeat last send (`.`), friendlier amounts (`max`, `half`, `1k`, `1,250.50`)
- [ ] "Next time: fhew send …" hint after interactive sends
- [ ] Cached balances on Home with age; background re-decrypt
- [ ] Non-blocking sends with pending indicator
- [ ] Recipient checks: first-time note, look-alike stop, save-contact offer
- [ ] Cancellable send countdown (configurable; always on for mainnet)
- [ ] Low-gas nudge
- [ ] Lock now (`L`) and auto-lock timer

Acceptance: e2e covers first-run, a full send with countdown cancel and resend, look-alike
warning, lock/unlock, doctor output and `--json`.

## Release

- [ ] Full e2e on `staging`, independent review and validation
- [ ] `staging` merged into `main`
- [ ] README and docs updated; version bumped to 2.0.0

## Not yet done (needs the user)

- On-chain verification on Sepolia with a real ERC-7984 token and funded wallet.
