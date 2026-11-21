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
- Review round 2 (verifier, code review, security review), all fixed:
  - `balance` printed ethers' response body, which echoed the RPC path key. Every
    command now uses `describeError`. Redaction masks pieces of the configured RPC URLs
    wherever they appear. A pty e2e sweep runs balance and send past the password
    prompt against servers that echo the key: 500, chain-then-500, a JSON-RPC error
    and 429, with and without `FHEW_DEBUG`.
  - Clear wording for:
    - an address with no token there ("not a token contract on <network>");
    - relayer failures (`RELAYER_UNAVAILABLE`);
    - an RPC that returned an error rather than not answering.
  - `FHEW_DEBUG=1` adds redacted details everywhere.
  - The data dir is only chmodded when it is the wallet's own, never a shared or sticky
    folder. One that others can write to is refused before anything is loaded from it.
  - RPC URLs from ./.env and the environment are validated, and `config --show` says
    which value is in effect and where it comes from. Typed URLs are masked once
    entered, and `--rpc-* -` reads them hidden.
  - Smaller fixes:
    - stdout drains before the exit timer;
    - a rate-limited RPC fails fast;
    - basic-auth RPC URLs work;
    - more invisible characters are stripped;
    - the keystore export no longer fails on an audit-log error.
- Review round 3, all fixed:
  - JSON-RPC errors from the endpoint (rate limit, quota, bad key, internal error)
    are worded as RPC problems everywhere, never as "not a token". The e2e sweep
    asserts the wording for balance, history, send and token add.
  - Wallet data that others could have changed (writable by group or others, owned by
    another user, or a symlink) is refused before anything is tightened or read.
  - The data-dir `.env` only supplies RPC URLs and API keys.
  - RPC redirects keep the abortable transport and the 429 limit.
  - Redaction only masks what looks like a key (the dRPC `network=sepolia` stays
    readable); debug details mask more.
  - `config --show` flags ignored RPC URLs.

Acceptance: tests assert file modes; a wrong-chain RPC is refused; no test output or log
contains a private key, phrase or API key.

## Phase 3: Terminal navigation

Matches `docs/ui-design.md`.

- [x] `@inquirer/prompts` replaces `inquirer`
- [x] Router with a back-stack; Esc = back one step, Ctrl+C = home, second Ctrl+C on Home quits
- [x] Status bar: breadcrumb, network badge (red on mainnet), wallet, lock state, ETH, pending
- [x] Results shown inline above the menu; no "Press Enter to continue"
- [x] Send wizard (Token → Recipient → Amount → Review → Sign) with step-back that keeps input
- [x] Number keys 1-9, `0` quits, letter shortcuts on Home, stable numbering
- [x] Sticky defaults (last token / recipient per network)
- [x] `?` help for the current screen
- [x] `:` command bar (`send bob 25 cusdc`, `balances`, `doctor`, `lock`, …)
- [x] `interactive.ts` split into one module per screen; shared flows with subcommands

Acceptance: e2e test drives Home → Send → Esc back through each step → Ctrl+C → Home in a
pseudo-terminal against the mock backend.

## Phase 4: fhEVM features and smoothness

- [x] `fhew doctor` (Node, RPC + chain, relayer, ETH, ERC-7984 support per token, data perms) (Phase 4a)
- [x] ERC-7984 interface check when adding a token (Phase 4a)
- [x] Find tokens: scan ConfidentialTransfer events where the wallet is the recipient and a curated known-token list per network; one checkbox list (Space toggle, a all, Enter bulk-add); unverified tokens unselected and labelled (Phase 4a)
- [x] One signature decrypts all tracked balances (session-scoped keypair + signature) (Phase 4b; mock-tested, not verified on-chain)
- [x] Decrypted amounts in history where the user is allowed to decrypt (Phase 4b; mock-tested, not verified on-chain)
- [x] Operators screen (view, grant with expiry, revoke) (Phase 4b; mock-tested, not verified on-chain)
- [x] Disclose a transfer amount (Phase 4b; mock-tested, not verified on-chain)
- [x] `--json` output on non-interactive commands (Phase 4a)
- [x] Receive screen with terminal QR code (Phase 4a)
- [x] First-run setup (wallet → network → token → gas) (done with the Phase 3 TUI)
- [x] Repeat last send (`.`), friendlier amounts (`max`, `half`, `1k`, `1,250.50`) (done with the Phase 3 TUI)
- [x] "Next time: fhew send …" hint after interactive sends (done with the Phase 3 TUI)
- [x] Cached balances on Home with age; background re-decrypt (Phase 4b; mock-tested, not verified on-chain)
- [x] Non-blocking sends with pending indicator (done with the Phase 3 TUI)
- [x] Recipient checks: first-time note, look-alike stop, save-contact offer (done with the Phase 3 TUI)
- [x] Cancellable send countdown (configurable; always on for mainnet) (done with the Phase 3 TUI)
- [x] Low-gas nudge (done with the Phase 3 TUI)
- [x] Lock now (`L`) and auto-lock timer (done with the Phase 3 TUI)

Acceptance: e2e covers first-run, a full send with countdown cancel and resend, look-alike
warning, lock/unlock, doctor output and `--json`.

## Release

- [x] Full e2e on `staging`, independent review and validation
- [x] `staging` merged into `main`
- [x] README and docs updated; version bumped to 2.0.0 (CHANGELOG.md)

### Relayer SDK: stay on `@zama-fhe/relayer-sdk` 0.4.5 for 2.0 (decided in Phase 4b)

`createInstance` in `@zama-fhe/relayer-sdk` 0.4.5 prints "`createInstance` is deprecated.
Use the `@zama-fhe/sdk` package instead." (lib/node.js, once per process). The wallet
captures that and the SDK's other console notes (`src/core/fhe/sdkConsole.ts`), so they
never reach the TUI or stdout; `FHEW_DEBUG=1` shows them on stderr outside the TUI.

Not migrating now, because (from `npm view @zama-fhe/sdk` and its 3.8.0 README, read
2026-11-21):
- `@zama-fhe/sdk` 3.8.0 is a higher-level framework (`ZamaSDK`, `Token`, sessions,
  storage layers) that depends on `viem >=2` and `@fhevm/sdk` 0.13.2; ethers is only an
  adapter (`@zama-fhe/sdk/ethers`). Adopting it replaces `src/core/fhe` and part of
  `TokenService`, including the sign-locally / SENT_UNCONFIRMED path, which must then be
  re-proven.
- Its 4.0 line is already in alpha (`4.0.0-alpha.6`), so the API is still moving.
- 0.4.5 still works and is the `latest` tag of `@zama-fhe/relayer-sdk` (0.5.0-rc.1 is a
  prerelease). Nothing in this release needs the new package.

Plan: a separate post-2.0 phase that migrates `src/core/fhe` behind the existing
`DecryptAuthority` / encryption seams, with on-chain verification on Sepolia. Sources:
https://www.npmjs.com/package/@zama-fhe/sdk , https://github.com/zama-ai/sdk

## Phase 5: Wrap / Unwrap (ERC-20 ⇄ ERC-7984 wrapper tokens)

Nearly every Sepolia ERC-7984 token is an OpenZeppelin `ERC7984ERC20Wrapper`: a
confidential token backed 1:`rate` by a public ERC-20 (cZAMA ⇄ ZAMA, cUSDT ⇄ USDT, …).
Users fund a confidential balance by wrapping, and leave it by unwrapping. A user wrapped
`1e8` base units of an 18-decimal ERC-20 into a wrapper with `rate = 1e12` and got **0**:
the wrapper rounds down to whole confidential units and does not revert. The wallet must
make that impossible to miss.

### Researched interface (Sepolia, 2026-11-21)

Evidence: PUSH4 selectors and PUSH32 event topics in the deployed bytecode (implementation
behind EIP-1967 proxies), decoded Sepolia unwrap and finalize transactions (e.g.
`0x171c5e33…` and `0x528003ea…` on cZAMAMock), and the OpenZeppelin
Confidential Contracts 0.5.3 source (`token/ERC7984/extensions/ERC7984ERC20Wrapper.sol`).

- cZAMA `0x85E3…F938`, cUSDT `0x421f…2Df7`, cUSDC `0xef98…729e`, cWBTC, cWETH (9077-byte
  contracts) and the upgradeable mocks cZAMAMock `0xf2D6…FbFB`, cUSDTMock, cUSDCMock (proxy →
  `0xae37…af04`) all have OZ ≥ 0.4:
  - `underlying() → address`, `rate() → uint256`, `decimals()` (≤ 6; `rate = 10^(underlying
    decimals − 6)`: cZAMA/cWETH 1e12, cWBTC 100, cUSDT 1)
  - `wrap(address to, uint256 amount) → euint64`: pulls `amount − amount % rate` with
    `transferFrom`, mints `amount / rate` (SafeCast to uint64; total supply capped at
    `maxTotalSupply() = 2^64−1` via `inferredTotalSupply`). Nothing reverts for
    `amount < rate`: it mints 0.
  - `unwrap(address from, address to, bytes32 encryptedAmount, bytes inputProof) → bytes32`
    (plus `unwrap(from, to, euint64)` for an already-allowed handle). Burns *up to* the
    amount (ERC-7984: more than the balance burns 0), makes the burnt handle publicly
    decryptable and returns it as the request id. `from` must be `msg.sender` or have it
    as operator; the input is bound to (wrapper, msg.sender).
  - `finalizeUnwrap(bytes32 unwrapRequestId, uint64 cleartext, bytes decryptionProof)`:
    **anyone** may call it; checks the KMS signatures (`FHE.checkSignatures`), deletes the
    request, sends `cleartext * rate` underlying to the receiver. A second call reverts
    with `InvalidUnwrapRequest(id)`.
  - `unwrapRequester(bytes32) → address` (0 once finalized or unknown),
    `unwrapAmount(bytes32) → euint64` (= the id).
  - Events `UnwrapRequested(address indexed receiver, bytes32 indexed unwrapRequestId,
    bytes32 amount)` and `UnwrapFinalized(address indexed receiver, bytes32 indexed
    unwrapRequestId, bytes32 encryptedAmount, uint64 cleartextAmount)`.
- The older cUSDC `0xa8Ca…1c01` (proxy → `0x9a5c…a1e5`) is OZ 0.3.x: same `wrap`, `unwrap`
  and `finalizeUnwrap(bytes32,uint64,bytes)` selectors, events `UnwrapRequested(address
  indexed, bytes32)` / `UnwrapFinalized(address indexed, bytes32, uint64)`, and no
  `unwrapRequester`: there "already finalized" is only visible as the
  `InvalidUnwrapRequest` revert during simulation.
- cKRW and cSHARD are plain ERC-7984 tokens (no `underlying()`): no wrap actions.
- Gateway-callback wrappers (OZ ≤ 0.2) are not supported: finalize would fail simulation.

### Plan

- [ ] Core: wrapper detection (`underlying()` + `rate()` answer) with the underlying's
      name, symbol and decimals read and sanitised, cached in `wrappers.json`
- [ ] Core: exact amount maths in bigint (`src/core/token/wrapMath.ts`): wrap input in
      underlying units, `wrapped = amount / rate`, `dust = amount % rate`; refuse
      `wrapped == 0` and `wrapped > 2^64−1`; warn on dust; unwrap input in confidential
      units, receive `amount × rate`
- [ ] Wrap: ERC-20 balance and allowance check; approve **exactly** `wrapped × rate`
      (never unlimited; reset to 0 first only when the token refuses a non-zero change);
      `wrap(self, wrapped × rate)` so the dust never leaves the wallet; both through
      `prepareTokenCall` / `signAndBroadcast`; re-decrypt the confidential balance after
- [ ] Unwrap: decrypted balance check, encrypt for (wrapper, sender), `unwrap(self, self,
      handle, proof)`; read the request id from `UnwrapRequested`; public decryption through
      the relayer; `finalizeUnwrap`; ERC-20 balance re-read
- [ ] Pending unwraps in `unwraps.json` (owner-only), saved when the request is signed;
      resume reconciles with the chain first (receipt of our transactions,
      `unwrapRequester`) so no step is sent twice; a new unwrap of a token with an
      unconfirmed request is refused until that one is checked
- [ ] CLI: `fhew wrap <amount> [token]`, `fhew unwrap <amount> [token]`,
      `fhew unwrap --list`, `fhew unwrap --resume [id]`; `-n -w --yes --password-stdin
      --mainnet --json`; in `MOCK_COMMANDS`
- [ ] MockBackend: deterministic wrappers (mock cUSDC wraps USDC at rate 1, mock cDAI wraps
      an 18-decimal DAI at rate 1e12), approvals, unwrap requests that survive a restart
      through the pending store, `FHEW_MOCK_FAIL=public-pending`
- [ ] TUI: Wrap / Unwrap from Balances and Tokens (wrapper tokens only), one screen with
      both balances, the exact result and dust, then the shared Review → Confirm →
      countdown; pending unwraps on Home and Balances with "Finish unwrap"; `:wrap 25
      cusdc`, `:unwrap 10 cusdc`; `?` help
- [ ] Tests: maths (rounding, dust, zero, bounds), detection, approve plan, the pending
      state machine (no double send), MockBackend, TUI harness, pty e2e under the mock
- [ ] Live on Sepolia (test wallet): wrap a minted ZAMA amount into cZAMA, unwrap cZAMA end
      to end, the zero/dust refusals before signing; tx hashes in the PR

Acceptance: a wrap that would mint 0 is refused before anything is signed, with the
smallest amount that works; dust is shown before confirming; approvals are exact; a
killed unwrap is finished by `fhew unwrap --resume` (or Home › Finish unwrap) without
re-sending a step that was already sent; `npm run verify` and `npm audit` are clean.

## Not yet done (needs the user)

- On-chain verification on Sepolia with a real ERC-7984 token and funded wallet.
- Confirm the ERC-7984 interface id `0x4958f2a4` against a deployed token:
  `cast call <token> "supportsInterface(bytes4)(bool)" 0x4958f2a4` should be true for an
  OpenZeppelin v0.3.0+ token; then `fhew doctor` should show "(reports the interface id)".
- Run `fhew token find` on Sepolia with a wallet that received a confidential transfer,
  against the default public RPCs (chunking and range errors are only tested locally).
- Fill the shipped known-token lists (`src/core/token/lists/`) with verified addresses,
  see docs/token-lists.md; check whether Etherscan's logs API accepts topic-only queries.
- Phase 4b on Sepolia: one-signature batch decrypt and `fhew history --decrypt` against the
  real relayer; `fhew operator set/revoke` on a real token; `fhew disclose` end to end (it
  assumes OpenZeppelin ERC7984's `requestDiscloseEncryptedAmount(bytes32)` and
  `discloseEncryptedAmount(bytes32,uint64,bytes)` with the relayer's `publicDecrypt`
  `decryptionProof`; a token without them fails at simulation, before signing).
