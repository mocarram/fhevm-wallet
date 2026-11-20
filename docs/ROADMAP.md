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

- [ ] S1 Data dir 0700, files 0600, atomic writes, loose permissions tightened on start
- [ ] S2 `FHEVM_WALLET_HOME`; Docker non-root and persists the data dir
- [ ] S3 Decrypted-balance check before sending; balance re-check after confirmation
- [ ] S4 uint64 bound (shared with Phase 1)
- [ ] S5 Keys and phrases shown on a wipe-on-keypress screen; encrypted keystore export
- [ ] S6 `.env` writer rejects newlines and quotes values
- [ ] S7 Custom RPC chain ID verified when set and at startup
- [ ] S8 Timeouts on all network calls; RPC fallback list
- [ ] S9 Tests for all of the above
- [ ] S10 Password strength hint (soft warning)
- [ ] Secrets redacted in errors and the audit log

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
