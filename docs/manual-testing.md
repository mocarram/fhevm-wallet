# Manual testing checklist

Run this before a release (and after a big change), on **Sepolia** first. It covers what
the automated tests cannot: a real terminal, the real chain and the relayer.

## Install the build under test

You need Node.js 24.11 or newer (`node -v`). From a checkout:

```bash
npm ci && npm run build && npm pack
```

```bash
npm install -g ./fhevm-wallet-<version>.tgz
```

`fhew --version` should print that version.

## Keep your data safe

A new version may add files to the data folder (`~/.fhevm-wallet`) or change how it
stores sync progress, and going back to an older version with that folder is not
tested. Make a copy first:

```bash
cp -a ~/.fhevm-wallet ~/.fhevm-wallet.backup
```

Or test with a separate folder:

```bash
export FHEVM_WALLET_HOME=~/.fhevm-wallet-test
```

## Try it without real funds (optional, 2 minutes)

The offline mock backend simulates the chain and the relayer. Nothing leaves your machine.

```bash
FHEW_BACKEND=mock FHEVM_WALLET_HOME=$(mktemp -d) fhew
```

The status bar shows `MOCK · simulated, no real funds`.

## Checklist

Tick each item and note anything odd: wording that confuses you, slow steps, a screen
that looks wrong in your terminal, or an error you did not expect.

### Start-up and setup

- [ ] `fhew --version` is instant (well under a second).
- [ ] `fhew doctor` shows Node, data folder, RPC, relayer, gas and tokens, all green or
      with a clear hint.
- [ ] `fhew` opens the terminal UI. The status bar shows the network, wallet and lock state.

### Navigation (terminal UI)

- [ ] Arrow keys and `j`/`k` move; `Enter` selects; `Esc` goes back one step and keeps
      what you typed.
- [ ] Number keys jump to the item with that number. `0` or `q` quits from Home.
- [ ] Home shortcuts: `b` Balances, `s` Send, `r` Receive, `h` History, `d` Doctor.
- [ ] `?` shows help for the current screen; `:` opens the command bar (try `:send`, `:wrap`).
- [ ] `L` locks the wallet. Unlocking asks for the password again.
- [ ] Resize the terminal: the screen redraws cleanly and long lists scroll.
- [ ] Pasting an address in Send › Recipient fills it in.

### Balances and tokens

- [ ] Balances decrypts all tracked tokens after one signature.
- [ ] Tokens › Find tokens lists tokens you may hold; `Space` selects, `a` selects all,
      `Enter` adds them.
- [ ] Adding a contract that is not ERC-7984 is refused with a clear message.

### Send

- [ ] Send a small amount to a second address you own. The review screen shows the
      recipient, token and exact amount, and the countdown can be stopped with `Esc`.
- [ ] The balance afterwards is lower by exactly that amount.
- [ ] The "Next time" hint on the success screen is a working command: run it with
      `--password-stdin` or interactively.
- [ ] Try an amount larger than your balance: the wallet warns before sending (on-chain
      such a transfer would move 0).

### Wrap / Unwrap (new)

- [ ] Wrap a small amount of a public ERC-20 into its confidential token (Balances or
      Tokens › `w` "Wrap or unwrap", `:wrap`, or `fhew wrap 1 <token>`). The review shows the approval and the wrap,
      and any rounding "dust".
- [ ] Unwrap a small amount back (same screen, `:unwrap`, or `fhew unwrap 1 <token>`). It has two steps:
      a request, then a finalize once the amount is decrypted.
- [ ] Quit between the two unwrap steps, then run `fhew unwrap --list` and
      `fhew unwrap --resume`. It must finish without sending anything twice.

### History, operators, disclosure

- [ ] History syncs, shows your sends, wraps and unwraps, and a second sync is quick.
- [ ] `fhew operator` lists, grants and revokes an operator.
- [ ] `fhew disclose` makes one of _your own_ transfer amounts public (two transactions).

### Failure cases (please try a few)

- [ ] A wrong password: a clear "wrong password" message, nothing sent.
- [ ] Turn the network off during a send: the wallet says whether the transaction was
      sent (with its hash) and never suggests sending again if it might already be out.
- [ ] `FHEW_DEBUG=1 fhew …` shows technical details with secrets masked.
- [ ] Scripts: `--json` prints one JSON document, and errors give exit code 1.

## Known gaps (covered by tests only)

- Mainnet: nothing was sent on mainnet. A one-shot command that signs on mainnet without
  a prompt needs both `-n mainnet` and `--mainnet`.
- USDT-style tokens that need the approval reset to 0 before a new approval: covered
  by tests only.
- Wrappers built on OpenZeppelin 0.3.x contracts: covered by tests only.

## Reporting a problem

Please include: the command or the screen and the keys you pressed, what you expected,
what happened (a screenshot or copied text), `fhew --version`, your OS and terminal, and
`fhew doctor` output. Never share your password, recovery phrase, private key or the
`~/.fhevm-wallet` folder.
