# Agent Guide — fhEVM Wallet

This file is the single source of truth for any coding agent (Claude Code, Codex, Cursor, …)
working in this repository. `CLAUDE.md` imports it. Keep it current: if you change a
workflow, a command or the architecture, update this file in the same commit.

## What this project is

A terminal wallet (`fhevm-wallet`, alias `fhew`) for **ERC-7984 confidential tokens** on
Zama's fhEVM. Balances and transfer amounts are encrypted on-chain; the wallet encrypts
amounts with the Zama relayer SDK and decrypts balances via EIP-712 "user decrypt".

- Language: TypeScript (ESM, `"type": "module"`, imports end in `.js`)
- Runtime: **Node.js 24 LTS** (`engines: >=24.11`). Do not use Node 22 or 26 features without
  checking the roadmap.
- Key libraries: `ethers` v6, `@zama-fhe/relayer-sdk` (Node entry `@zama-fhe/relayer-sdk/node`),
  `commander`, `@inquirer/prompts`, `chalk`, `zod`.
- User data lives in `~/.fhevm-wallet/` (override with `FHEVM_WALLET_HOME`).

## Commands

```bash
npm ci                 # install exactly from the lockfile
npm run build          # tsc → dist/
npm run lint           # eslint
npm run format:check   # prettier
npm test               # vitest unit + integration tests
npm run test:e2e       # drives the real CLI binary against the offline mock backend
npm run verify         # everything above, in order; must pass before any merge
```

`npm run verify` is the gate. A change that does not pass it is not done.

## Architecture

```
src/
  index.ts                 tiny entry: private compile cache (compileCache.ts), then
                           startup.ts; `--version` stops there, anything else loads main.ts
  startup.ts               checks every command gets: backend switch, data-folder trust and
                           permissions, mock guard, loads env (light modules only)
  main.ts                  commands and the TUI (commander)
  cli/                     commander subcommands (non-interactive: fhew send, fhew balance …)
  cli/commands/interactive.ts   thin launcher for the TUI (`fhew`, `fhew interactive`)
  tui/                     interactive terminal UI (see "Terminal UI" below)
  core/
    network/               RPC config, provider factory (timeouts, fallbacks), chain checks
    fhe/                   relayer SDK instance, encryption, decryption
    token/                 ERC-7984 calls (TokenService), registry, balance cache;
                           wrapper.ts / wrapMath.ts / unwrapPending.ts: ERC-20 wrappers
    wallet/                keystore encryption and wallet loading
    backend/               Backend interface + RealBackend and offline MockBackend
                           (wrap/unwrap: wrapTypes.ts, realWrap.ts, mockWrap.ts)
    send/                  friendly amounts, address checks, recipient/token resolution
  storage/                 JSON stores under the data dir (owner-only permissions)
  utils/                   validation, formatting, amount parsing
tests/                     vitest; mirrors src/
tests/e2e/                 end-to-end runs of dist/index.js in a throwaway HOME
site/                      the website (plain HTML/CSS/JS, no build step), deployed to
                           https://mocarram.github.io/fhevm-wallet/ by
                           .github/workflows/pages.yml when site/ changes on staging
```

### ERC-7984 rules that bit us before

- Transfer with `confidentialTransfer(address to, bytes32 encryptedAmount, bytes inputProof)`.
  Never call `$_transfer` / `$_mint` / `$_burn`: those exist only on OpenZeppelin's
  hardhat-exposed **mock** contracts and revert on real tokens.
- There is no `approve`. Delegation uses `setOperator(address operator, uint48 until)` and
  `isOperator(holder, spender)`.
- Encrypted amounts are `euint64`. Reject amounts above `2^64 - 1` base units.
- A transfer larger than the balance does **not** revert: it moves 0. Always check the
  decrypted balance before sending and confirm it moved afterwards.
- Encrypted inputs are bound to `(contract, sender)`. The sender must be `msg.sender`.

### ERC-20 wrapper rules (Phase 5, OpenZeppelin `ERC7984ERC20Wrapper`)

- A wrapper answers `underlying()` and `rate()`. `wrap(to, amount)` mints `amount / rate`
  and **never reverts for a small amount: it mints 0**. Do all maths in
  `src/core/token/wrapMath.ts` (bigint): refuse `wrapped == 0`, show `dust = amount %
  rate`, send `wrap(self, wrapped × rate)` and approve exactly that, never unlimited.
- Wrap amounts are typed in the ERC-20's units, unwrap amounts in the confidential
  token's. An 18-decimal ERC-20 passes 2^64 base units at 18.4 tokens: the euint64 bound
  applies to `wrapped`, not to the typed amount (`parseFriendlyAmount` `limit: null`).
- Unwrap is `unwrap(from, to, handle, proof)` (burns *up to* the amount: check the
  decrypted balance first) then `finalizeUnwrap(requestId, cleartext, proof)` with the
  relayer's public decryption. Anyone may finalize; a finished request reverts
  `InvalidUnwrapRequest` and `unwrapRequester(id)` is 0 (OZ 0.4+; 0.3.x has no getter).
- Every unwrap is recorded in `unwraps.json` (`src/storage/UnwrapStore.ts`) when its
  request is **signed**, and `reconcileUnwrap` (`src/core/token/unwrapPending.ts`) asks the
  chain before any step is sent again. Never resend a request from a resume; never send a
  finalize while ours may still land. The store holds amounts: owner-only, like
  amount-cache.json, and a damaged file is never overwritten.
- "The RPC does not know this transaction" is not "dropped": behind a load balancer it
  may be pending on another node. The request's nonce is recorded when it is signed
  (`onSigned(hash, { nonce })`), and `checkForget` lets `--forget` drop a `signed` entry
  only once `Backend.txDropped` proves it (`src/core/network/txDropped.ts`): the nonce at
  a *settled* block (`finalized`, else latest − 64; never `latest`) is past it, and a
  node whose head has that block knows no receipt (both reads batched, so one node
  answers each; a node behind is "try again in a minute"). Entries without a nonce:
  30 minutes old. Disclosure step 2 follows the same rule
  before a resend (`refuseIfDisclosurePending` in RealBackend.ts, nonce kept in
  amount-cache.json). A mined request without an
  `UnwrapRequested` log is `unclear` (tokens may be burnt), never "failed, nothing burnt".
- A TUI effect that signs later (an unwrap's step 2) asks `deps.unlockedSigner()` right
  before each use and stops when the wallet locked or changed; it never keeps the key it
  started with.
- Re-read the wrapper (`Backend.wrapperInfo`) before signing; `wrappers.json` is a cache
  for display only.
- "The contract did not answer" is decided by one rule, `isContractNoAnswer`
  (`src/core/token/txErrors.ts`), for the ERC-7984 check and the wrapper check alike:
  BAD_DATA counts only as `0x` back, never "missing response for request" (an RPC that
  dropped part of a JSON-RPC batch; nodies drops batches above 10), which is a transport
  failure.
- A wrap (mint) or unwrap request (burn) is recorded in `transactions.json` when it
  confirms, and at block 0 (unconfirmed, with its hash) when the receipt does not come
  (`src/core/token/wrapHistory.ts`), like a send; a resume that learns the request's
  receipt records it too. Block 0 sorts first in `listTransactions`, so a limit never
  cuts it. A new wrap of a token with an unconfirmed one warns (`unconfirmedWrapIn`).
- A wrap step priced after the review (the wrap after its approval) must fit in what is
  left of the reviewed "up to" fee, or it stops with `WRAP_APPROVED_ONLY`.

## Offline mock backend

`FHEW_BACKEND=mock` swaps the chain + relayer for an in-memory simulation
(`src/core/backend/MockBackend.ts`). Use it for e2e tests and demos. It must never be the
default and must print a visible `MOCK` badge in the status bar. Knobs:
`FHEW_MOCK_LATENCY_MS`, `FHEW_MOCK_CONFIRM_MS`, `FHEW_MOCK_ETH` and
`FHEW_MOCK_FAIL=simulate|unconfirmed|reverted|replaced|rpc|public-pending` (failures go
through the real error translation; `public-pending` keeps unwrap decryptions pending).
Mock cUSDC wraps a 6-decimal USDC at rate 1 and mock cDAI an 18-decimal DAI at rate 1e12
(`src/core/backend/mockWrap.ts`); unwrap requests from an earlier process are found
through `unwraps.json`. Keystores, contacts, tokens and settings always use the real storage,
so mock and real data never share a folder (`src/core/backend/mockGuard.ts`):
`FHEW_BACKEND` and `FHEVM_WALLET_HOME` are taken from the launch environment, never a
`.env`; the mock runs only in a folder marked `.fhew-mock`, which it creates only in a
missing or empty folder other than `~/.fhevm-wallet`; every command refuses a marked
folder without `FHEW_BACKEND=mock`; and under the mock only the commands in
`MOCK_COMMANDS` run: the TUI, `send`, `wallet`, `token`, `doctor`, `receive`, `history`,
`operator`, `disclose`, `wrap`, `unwrap` and help (the rest, e.g. `balance` and `config`,
would reach the real network; an unknown command is left to commander's "unknown
command"). Use `FHEVM_WALLET_HOME=$(mktemp -d)`. The TUI shows
"MOCK · simulated, no real funds" right after the brand in the status bar.

## Terminal UI (src/tui)

The approved design is `docs/ui-design.md`. Layout of the code:

```
tui/
  app.ts          pure core: handleKey(state, key) and tick(state, now) → effects;
                  render(state, size) → styled lines. Key precedence is documented here.
  state.ts        AppState, router/back-stack (push, back, goHome), lock helpers
  screen.ts       ScreenDef / ScreenView / menu Item types, stable numbering
  screens/        one module per screen; registry.ts maps ids to modules
  flows/          logic shared by screens (send, wallet, data, manage, wrap); no drawing
  components/     reusable menu and multi-select list (Space, a, Enter)
  effects.ts      Effect = described I/O, run by the shell with Deps (backend, …)
  errors.ts       describeError: the ONLY way a TUI error reaches the screen; wording
                  and redaction delegate to src/cli/utils/userError.ts
  statusBar.ts, commandParser.ts, text.ts (styled segments → ANSI), keys.ts
  input.ts        raw terminal bytes → keys and paste events (Esc at once, Esc+key
                  kept, bracketed paste as one event)
  shell.ts        thin I/O: alternate screen, bracketed paste, raw keys, resize, timer,
                  restore on quit/crash/signals (every exit path turns paste mode off),
                  one draw per input chunk with only changed rows rewritten, drops the
                  key and destroys providers on exit
  index.ts        runTui(): picks the backend and network, starts the shell
  storeWarnings.ts  damaged-store warnings → Home notice while the TUI runs (adapter
                  for `setStoreWarningSink`, see the file)
```

Rules: screens never do I/O in `view` (they render from `state.data`, a snapshot
reloaded by effects); every user-visible error goes through `describeError`; secret text
fields are listed in `SECRET_FIELDS` and cleared on Esc/Ctrl+C; no ora spinners or
`console.log` while the TUI owns the screen. A paste goes through `handlePaste` (app.ts):
into the focused field with its rules, or a screen's `onPaste`; never as shortcuts.

`fhew send bob 25 cusdc` uses the same core/send helpers and the Backend as the TUI, so
the TUI's "Next time" hint is a working command (an e2e test runs it). Scripts use
`--password-stdin` (send, balance, history --decrypt, operator, disclose, wrap, unwrap,
wallet create/import) and `--yes` (also on `wallet remove` and `token remove`); prompts
refuse without a terminal and name the missing option. The default network is set with
`fhew config --default-network <net>` (`-n` on `config` is refused); `fhew -n <net>` with
no command starts the TUI on that network.

Testing: `tests/tui/harness.ts` drives the real core with the MockBackend and no delays
(press keys, `settle()` effects, `text()` the frame). `tests/e2e/tui.e2e.test.ts` runs the
built binary in a pty via `tests/e2e/pty_driver.py` (Python stdlib). To try it by hand:
`FHEW_BACKEND=mock FHEVM_WALLET_HOME=$(mktemp -d) node dist/index.js`.

The sandboxed cloud environment usually cannot reach Ethereum RPCs. When you cannot test
on-chain, say so explicitly in your report and list what the user should run by hand.

## Git workflow (mandatory)

```
feature branch  ──rebase, fast-forward──▶  staging  ──fast-forward──▶  main
```

1. `main` and `staging` must stay in sync before new work starts. Branch from `staging`.
2. Work on a feature branch (`claude/<topic>`, `feat/<topic>`, `fix/<topic>`).
3. Small, focused commits using Conventional Commits: `feat(tui): …`, `fix(token): …`,
   `test: …`, `docs: …`, `chore(deps): …`, `refactor: …`, `ci: …`.
   Subject ≤ 72 chars, imperative mood; body explains *why*.
4. Before merging into `staging`: `npm run verify` passes **and** an independent review
   (see below) has no open blocking findings.
5. History is linear: rebase the feature branch on `staging`, then fast-forward
   (`git merge --ff-only`). No merge commits.
6. Promote `staging` → `main` (fast-forward) only after a full e2e pass on `staging`
   and the manual checklist in `docs/manual-testing.md`. A release is one
   `chore(release): X.Y.Z` commit (version + CHANGELOG), tagged `vX.Y.Z` on `main`,
   then published to npm following `docs/releasing.md`.
7. Never force-push `staging` or `main`. Never rewrite published history.
8. Never commit secrets, `.env`, keystores or anything from the data dir.
9. Commits are authored by the repository owner (Mocarram Hossain
   <mocarramhossain@gmail.com>) with no AI attribution lines (`Co-Authored-By`,
   session links).

## Quality loop (mandatory)

Every unit of work goes through this loop until it comes out clean:

1. **Plan**: write down the change and how you will prove it works.
2. **Implement** with comments that explain intent and non-obvious decisions
   (why, not what). Every exported function gets a short doc comment.
3. **Test**: add or update tests in `tests/` for the behaviour you changed. Bug fixes get a
   regression test that fails without the fix.
4. **Verify**: `npm run verify`.
5. **Independent review**: a *separate* agent that did not write the code reviews the diff
   against `origin/staging`. In Claude Code use the `reviewer` subagent
   (`.claude/agents/reviewer.md`) and, for anything touching keys, storage, network or
   signing, also the `security-reviewer` subagent. Other agents: run an equivalent fresh
   session with the reviewer prompt.
6. **Fix** every confirmed finding, then go back to step 3.
7. **Validate** with the `verifier` subagent: it runs the build, tests and e2e on its own and
   checks the change against the acceptance criteria in `docs/ROADMAP.md`.
8. Merge (see Git workflow) and tick the item in `docs/ROADMAP.md`.

## Coding conventions

- Strict TypeScript; no `any` unless commented with the reason.
- Pure logic (parsing, validation, formatting, routing) lives outside UI code so it can be
  unit-tested.
- User-facing text: plain English, active voice, says what happened and what to do next.
  Never show a raw ethers error to the user without a translation; keep the raw text one
  keypress away ("Show technical details").
- Start-up cost matters (`fhew --version` ~55 ms, a command ~280 ms): keep heavy imports
  (ethers, the relayer SDK) out of `startup.ts` and the modules it imports. The relayer SDK is loaded on first use (`loadRelayerSdk` in
  `src/core/fhe/FheService.ts`; constants from it live in `relayerConfig.ts`). Node's
  compile cache is kept outside the data dir in a 0700 folder (`src/compileCache.ts`).
- Files are written with owner-only permissions via `src/storage/secureFs.ts`
  (`writeSecureFile`, `appendSecureFile`, `ensureSecureDir`; `writeNewPrivateFile` for
  exports to a user-chosen path). Do not call `fs.writeFileSync`, `mkdirSync` or
  `appendFileSync` on user data directly.
- Startup tightening (`tightenPermissions`) only touches the data dir and the paths in
  `WALLET_DATA_ENTRIES`, and only clears group/other bits. The data dir itself is only
  chmodded when the wallet owns it (`getDataDirPolicy` in `src/storage/paths.ts`): the
  default `~/.fhevm-wallet`, a folder the wallet created, or one holding only wallet
  files. Never home or above, the temp folder, the current folder, `/` or a sticky
  folder (`sharedLocationReason`). A data dir or `wallets/` that group or others can
  write to, or any wallet file that is writable by others, owned by another user or a
  symlink, is refused *before* anything is tightened or read (`assertTrustedDataDir`),
  and so is a data dir under a folder another user could change (like sshd's StrictModes:
  owned by someone other than the user or root, world-writable without the sticky bit, or
  group-writable by a group other than the user's private one; `untrustedAncestor`). The
  one exception is a group-writable (not world-writable) file of the user's own private
  group, which is tightened. Trust is re-checked before a keystore is read.
  The data-dir `.env` only supplies `SAVED_ENV_KEYS` (RPC URLs, API keys);
  `FHEW_BACKEND`, `FHEW_DEBUG` and `FHEVM_WALLET_HOME` come only from the real
  environment.
  A new store file must be added to `WALLET_DATA_ENTRIES`.
- Network calls have timeouts: JSON-RPC through `getProvider` (20 s per request, chain-ID
  check per URL, fallback endpoints, `abortableGetUrl` so a timed-out socket is closed;
  read-only calls also fail over on JSON-RPC rate/plan/pruned/range replies, classified
  in `src/core/network/rpcLimits.ts`, never `eth_sendRawTransaction`; an endpoint that
  refuses with HTTP 4xx is skipped for the rest of the process),
  `fetch` with `AbortSignal.timeout`, relayer SDK calls through `quietSdk(fn, timeout)`
  (`src/core/fhe/sdkConsole.ts`, which gives the console back when the timeout fires;
  never wrap `quietSdk` in `withTimeout`). HTTP 429 is retried 3 times, not ethers' 12. Custom RPC URLs
  from anywhere (settings, ./.env, the environment) must pass `validateRpcUrl`.
  `user:password@` in an RPC URL is sent as a Basic header. Redirects are followed inside
  `abortableGetUrl` (registered globally), never by ethers, so they keep the timeout and
  the 429 limit. The relayer SDK reads the
  chain through `getEip1193Provider`,
  which answers `eth_chainId` locally. A one-shot command exits about a second after it
  finishes even if a timed-out relayer request is still open (`src/index.ts`).
- A failing command sets `process.exitCode = 1`. A prompt without a terminal ends with
  one sentence (`describePromptError`); flows that can do without asking (history sync)
  check `process.stdin.isTTY` and skip the prompt instead.
- Text that comes from a contract (token name and symbol, revert reasons) is untrusted:
  pass it through `sanitizeContractText` / `src/core/token/tokenText.ts` before storing
  or printing it.
- Show private keys and recovery phrases only through `showSecretScreen`
  (`src/cli/utils/secretScreen.ts`), never with `console.log`.
- Sign locally first (`signAndBroadcast` in `TokenService`) so the hash is known before
  anything leaves the machine. Once a transaction is signed and handed to the RPC, any
  failure goes through `sentButUnconfirmed` and is shown as `SENT_UNCONFIRMED` with the
  hash and explorer link, never "try again": resending could pay twice. The only node
  refusals that count as "definitely not sent" (safe to retry) are the ethers codes
  `INSUFFICIENT_FUNDS` and `REPLACEMENT_UNDERPRICED`. `NONCE_EXPIRED` ("nonce too low")
  is *not* safe: an RPC gateway may have retried the broadcast on another backend after
  ours was already accepted. Mined reverts stay `TX_REVERTED`; a nonce taken by another
  transaction is `TX_REPLACED`. Both keep the hash. The wait for a receipt is bounded
  (`CONFIRMATION_TIMEOUT_MS`) and also ends in `SENT_UNCONFIRMED`.
- History sync (`src/core/token/historySync.ts`) keeps a cursor per (wallet, network,
  token) plus `eth`, saved after every chunk, and stores transfers keyed by tx hash + log
  index. eth_getLogs goes through `walkBlockRange` (`src/core/network/logRange.ts`:
  shrinks to a named cap such as nodies' 50 blocks, backs off on rate limits, request
  budget); Find tokens uses the same walker. Tokens with equal cursors are read with one
  address-list eth_getLogs per direction. On the built-in public endpoints a first RPC
  sync covers only a recent window (`PUBLIC_HISTORY_WINDOW`, 10k blocks) and says so; a
  first sync's start refused as "pruned" moves forward (the provider counts those
  refusals) instead of crawling a 50-block fallback; an existing cursor never moves or
  loses coverage (it walks the fallback under the budget and names the unsearched range); Etherscan replies with `status: "0"` are
  errors unless "No records found". Test sync changes against `tests/helpers/stubRpc.ts`
  (real provider + sync code), not only the MockBackend.
- Never write plaintext token amounts to the audit log. Decrypted transfer amounts live
  in `amount-cache.json` (`src/storage/AmountCache.ts`, owner-only, keyed by handle).
  Two other owner-only files hold amounts the user typed themselves: a send recorded
  locally in `transactions.json` (`recordLocalTransaction`, sends, wraps and unwrap
  requests) and the TUI's "Next time"
  hint in `ui-prefs.json` (`lastSend`). Synced history stores only the encrypted handle.
- User decryption goes through a `DecryptSession` (`src/core/fhe/DecryptSession.ts`): one
  EIP-712 signature per 10 contracts for all tracked tokens, requests of at most 2048
  encrypted bits (the relayer SDK limits). It is memory-only and must be `clear()`ed with
  the key (the TUI's `lockWallet` does; one-shot CLI commands clear it when done).
- Wrap every relayer SDK call in `quietSdk` (`src/core/fhe/sdkConsole.ts`): the SDK prints
  to the console (a deprecation notice among others), which would corrupt the TUI and
  `--json` output.
- Transactions other than transfers (operators, disclosure, approve, wrap, unwrap) use
  `prepareTokenCall` in `TokenService` (chain check, simulation, fee, ETH check, then
  `signAndBroadcast`; pass `abi` for a contract other than ERC-7984) and, in the TUI,
  `src/tui/flows/tx.ts` (review, confirm, countdown, background broadcast). A feature
  with its own steps plugs in through `TxAction.custom` (prepare, send, done) instead of
  growing `tx.ts` (see `src/tui/flows/wrap.ts`).
- Disclosure step 1 refuses the wallet's current balance handle and any handle that is
  no transfer amount of the wallet in local history (the holder keeps ACL access to its
  earlier balance handles). Callers pass `{ vouched: true }` only for a handle taken from
  the transfer's receipt or after the user typed `disclose` at a terminal.
- With `FHEW_BACKEND=mock` only commands that route every network call through the
  Backend may run (`MOCK_COMMANDS` in `src/core/backend/mockGuard.ts`).
- Set `FHEW_DEBUG=1` to print redacted technical details under error messages
  (`describeError` adds them; `describeErrorShort` is for table cells and never does).
- A `.env` in the current directory is only trusted for `CWD_ENV_ALLOWED_KEYS`
  (`src/storage/paths.ts`: RPC URLs and API keys). Never add behaviour switches such as
  `FHEW_DEBUG`, `FHEW_BACKEND` or `FHEVM_WALLET_HOME` to that list.
- Print caught errors only through `describeError` / `describeErrorShort`
  (`src/cli/utils/userError.ts`) and RPC URLs only through `maskUrl`: raw ethers messages
  include the request URL, and providers echo the path and key in response bodies.
  `redactSecrets` masks pieces of the configured RPC URLs (path segments of 8+
  characters, query values, credentials) wherever they appear; keep new secret-bearing
  settings in its lists.
- A JSON-RPC error from the endpoint (HTTP 200 with `{"error": ...}`) is the RPC's
  problem, not the token's: `rpcErrorOf` maps it to `RPC_RATE_LIMITED`, `RPC_AUTH` or
  `RPC_ERROR`. "Not a token" needs BAD_DATA (`0x` back) or an empty revert from an
  address whose `eth_getCode` is `0x`.
- Prompts for an RPC URL use `transformer: maskUrlWhenAnswered`; `--rpc-*` and
  `--*-key` options accept `-` for hidden or piped input (one piped value per run).
- CI runs as an ordinary user, while the cloud sandbox runs as root (root ignores file
  modes). Any test about permissions must pass both ways: run it as a non-root user too
  (e.g. `setpriv --reuid=65534 --regid=65534 --clear-groups` on a copy owned by that uid).
- e2e tests that need a terminal (password prompts) use `tests/e2e/pty-run.py`
  (python3); they are skipped where python3 is missing.
- `-n/--network` is a program-level option: commander gives it the flag wherever it is
  typed, so the program's preAction hook copies it to the running subcommand's own
  `network` option (`adoptTypedNetwork`, `src/cli/utils/networkOption.ts`). A new
  command that takes a network declares `-n, --network` and reads `options.network`.
- A one-shot command that signs a transaction takes `--mainnet` and calls
  `mainnetAllowed` (`src/cli/utils/txFlow.ts`, rule in `src/cli/utils/mainnetGuard.ts`)
  before reading the password: without a prompt, Mainnet needs `-n mainnet` and `--mainnet`.
- Anything that needs the chain or relayer goes through the `Backend` interface so the
  mock supports it; a command that does is added to `MOCK_COMMANDS`
  (`src/core/backend/mockGuard.ts`).
- Tokens are added only after `Backend.checkToken` (ERC-7984 check,
  `src/core/token/erc7984Check.ts`); a failing one needs an explicit override (`--force`,
  "Add anyway"). A transport failure is never reported as "not ERC-7984".
- `--json` (`src/cli/utils/json.ts`): one document on stdout, stable camelCase keys, bigint
  as strings, errors `{"error":{code,message}}` with exit 1, no prompts (require
  `--password-stdin` / `--yes` instead), human progress on stderr only. Every result
  names its wallet as `walletJson` (`{name, address}`) and carries `mock` (`mockJson`);
  amounts are `{baseUnits, formatted}` (history rows: `amountBaseUnits`). Use the
  shared codes (`INVALID_AMOUNT`, `INSUFFICIENT_BALANCE`, `TOKEN_NOT_TRACKED`,
  `CONFLICTING_TOKENS`, `WRONG_PASSWORD`, `PASSWORD_STDIN_REQUIRED`, …) before inventing one.
- Spinners come from `src/cli/utils/spinner.ts` (marks ✔ ! ✗, colour only on a
  terminal), never `ora` directly; success and warning lines use `success` / `warning`
  (`src/utils/formatting.ts`). Nothing writes escape codes into a pipe or a file.
- Never put a token address in `src/core/token/lists/*.json` that was not verified; record
  the source in `docs/token-lists.md`.
- No emoji in menus (they break column alignment in many terminals).
- Colour honours `NO_COLOR`: `applyNoColor` runs at startup and cli-table3 tables take
  `style: tableStyle()` (`src/utils/formatting.ts`).

## Where the plan lives

- `docs/ROADMAP.md`: phases, acceptance criteria and status. Agents pick the next unchecked
  item from here.
- `docs/ui-design.md`: the approved terminal design (screens, keymap, behaviours).
- `site/`: the website. Screenshots in `site/assets/screenshots/` are real captures of the
  terminal UI (a pty run rendered with xterm.js), never mock-ups; never show the MOCK
  badge there. Its version and install text follow the latest npm release.
