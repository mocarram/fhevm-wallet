# Terminal UI design

The approved interactive design is published as a clickable prototype (private to the
owner): https://claude.ai/artifact/84aiBXnW4L2XEE5ciDePs5

This file is the text reference agents build against.

## Layout of every screen

Long lists (tokens, contacts, balances, history, doctor rows, multi-selects) scroll in a
window between the screen's header and its notes and menu, which stay on screen; the last
row of the window says `rows 21-40 of 200 · pgup/pgdn scroll`. A menu longer than the
screen shows a window around the cursor with `↑ n more` / `↓ n more`.

```
 fhEVM Wallet  Home › Send › Review          [Sepolia] alice 0x3f9A…C21d unlocked 15m 0.4210 ETH
                                              ^ red MAINNET badge on mainnet; yellow ETH when low;
                                                "⠋ 1 pending" segment while a send confirms
 With FHEW_BACKEND=mock, "MOCK · simulated, no real funds" follows the brand on the left.
 <result of the last action, if any>

 <screen body>

 ❯ 1  Item
   2  Item
   ─────────
   0  Quit

 <key hints for this screen>
```

## Keymap

| Key       | Action                                                                                  | Where                                                                  |
| --------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| ↑ ↓ / k j | Move                                                                                    | lists                                                                  |
| Enter     | Select / next step                                                                      | everywhere                                                             |
| Esc       | Back one screen or step, keeping input; stops the send countdown                        | not Home                                                               |
| Ctrl+C    | Cancel to Home; twice on Home quits                                                     | everywhere                                                             |
| 1-9       | Jump to numbered item (numbers are stable)                                              | menus                                                                  |
| 0 / q     | Quit                                                                                    | Home                                                                   |
| b s r h d | Balances, Send, Receive, History, Doctor                                                | Home                                                                   |
| .         | Repeat last send                                                                        | Home                                                                   |
| a         | Save last new address as contact                                                        | Home, when offered                                                     |
| :         | Command bar                                                                             | not in text fields                                                     |
| ?         | Help for this screen                                                                    | not in text fields                                                     |
| L or l    | Lock now                                                                                | not in text fields                                                     |
| /         | Filter the list (Enter keeps, Esc clears)                                               | Tokens, Address book, History, Find tokens, Send › Token and Recipient |
| PgUp PgDn | Scroll a long list one window (Home / End: top / bottom); in a long menu, move 10 items | lists                                                                  |
| e         | What happened to the last send                                                          | Home, after a failed send                                              |
| p         | Paste an address                                                                        | Send › Recipient                                                       |
| Space / a | Select one / all                                                                        | multi-select lists (Remove tokens, Find tokens)                        |
| r         | Scan again                                                                              | Find tokens                                                            |

Input details: Esc acts at once (an escape sequence split across reads gets 25 ms to
complete), and a key typed right after Esc is not lost: Esc+s (or Alt+s) is Esc, then s.
Paste is bracketed: pasted text is one event that types into the focused field, command
bar or filter with that field's rules (never Enter, never shortcuts). On Send ›
Recipient, Address book, Tokens and Operators a pasted address opens the address step
filled in (all checks still run on Continue); elsewhere a paste is ignored with a note.
Without bracketed paste, a whole address arriving in one read is treated as a paste, and
a 0 or q inside a burst of keys only arms Quit ("Press 0 again to quit").

## Home

Low-gas nudge (when ETH covers < 5 sends), cached balances with age (at most two rows;
entries never split, the rest counted as `+N more · b Balances`), then:
(after unlock and after each confirmed send the balances re-decrypt in the background:
each value stays on screen with a spinner beside it and the line ends `2m ago ·
updating…`; one EIP-712 signature covers every tracked token for the unlocked session)
`↻ repeat last send` (unnumbered, key `.`), Balances, Send, Receive, History,
Wallets, Tokens, Address book, Settings, Doctor, `0` Quit.

## Send wizard

Token → Recipient → Amount → Review → Sign, with a stepper line. Amount accepts
`25`, `1,250.50`, `1k`, `half`, `max` and shows the exact value. Review shows the fee
estimate and three checks (simulation, balance, ERC-7984). If unlocked, Sign is skipped.
With "Stay unlocked for: every action", the unlock lasts for this one send: it
locks as soon as the send is broadcast or cancelled. If locked, Sign asks for the password and then returns to Review, now with the fee
and the three checks (they need the decrypted key), so nothing is broadcast that the
user has not seen checked. On Mainnet the amount is retyped before the countdown.
Then a cancellable countdown (default 5 s; at least 5 s on Mainnet), broadcast, and
return to Home with `1 pending` in the status bar. On confirmation: balance re-decrypt, success notice with
the matching `fhew send …` command, and an offer to save new addresses.

## Settings, Tokens

Settings › Network opens a two-item picker (Sepolia / Mainnet) rather than toggling on
Enter, so Mainnet is never one accidental key press away. "Stay unlocked for" and
"Send countdown" cycle through their choices on Enter. Tokens has "Remove tokens" (a
multi-select list) and "Find tokens".

Adding a token runs the ERC-7984 check. A contract that fails opens "does not look like
an ERC-7984 confidential token" with the reasons and two choices, "Don't add it"
(default) and "Add anyway".

Find tokens shows scan progress ("block X of Y (n%) · k found"; Esc stops it and keeps
what was scanned), then one multi-select list. Each row: symbol, name, short address and
its source, "known list" and/or "found in your history". Verified rows (known list +
check passed) start selected; rows only found in the history are labelled "unverified" in
yellow and start unselected. Contracts that fail the check are listed below, dimmed, as
"not ERC-7984, not offered". Space toggles, `a` selects all, Enter adds the selection,
`r` scans again from where it stopped.

## Receive, Doctor

Receive shows the address and a terminal QR code (half blocks, quiet zone) of the address,
or of an EIP-681 link `ethereum:<address>@<chainId>` after "QR with network (EIP-681)".
Doctor lists one row per check (Node, data folder, each RPC URL masked, relayer, ETH for
gas, each tracked token's ERC-7984 check) with ✔ ! ✗ marks, the same as `fhew doctor`.

## History

Newest first (pending sends at the top, then by block), the latest 200 transfers.
A sync notice (what it could not cover, e.g. a public endpoint's block window) is shown
once per session above the menu.
A send that ended "sent, not confirmed" (SENT_UNCONFIRMED) is kept as a row marked
`! unconfirmed` with its hash until a sync finds it mined; 30 s after such a send the
TUI refreshes ETH, balances and history once.
Rows show decrypted amounts once the wallet is unlocked (`Decrypt amounts` unlocks first).
Amounts this wallet may not decrypt stay `encrypted`, without an error. Decrypted amounts
are cached by handle, so they show on later visits while locked. `Disclose an amount`
lists confidential transfers; the Disclose screen shows the stage (private → step 1 done,
pending public decryption → public) and offers the next step.

## Operators (Tokens › Operators)

Lists contacts and recent counterparties with `operator` / `not an operator` for the
selected token (`Switch token` when several are tracked). Grant: address or contact →
expiry (1 hour, 1 day, 7 days, custom date or duration, `No expiry…` which asks to type
`forever`) → Review. A pasted look-alike of a contact stops first, like Send (`Grant to
bob instead` / `I checked it`); a first-time address is noted on the expiry step and on
Review. Custom dates are capped at a year, like durations; longer means `forever`.
Revoke: pick an operator or paste an address → Review; an address that is not an
operator is refused on the address step ("not an operator … nothing was signed or
sent"). ERC-7984 has no getter for an operator's expiry, so grants made from this
computer are remembered (`ui-prefs.json`) and listed as `operator until …`; others show
`expiry unknown`.

## Review for operator changes and disclosures

One title line ("Let bob move your cUSDC until Nov 22 2026 14:05"), a yellow warning
(operators: "can move ALL of your cUSDC … until …"; disclosure: "cannot be made private
again"), token, network, operator, fee and "Simulation passed". Locked: `Unlock and
check` asks for the password and returns here. `Confirm` starts the send countdown (Esc
stops it), then broadcasts in the background with `1 pending` and a notice on Home. Errors
use the send error screen; after the broadcast it keeps the hash and never offers a retry.

## Errors

Simulation failures stop before signing and show: what happened, likely cause, what to
try, and "Show technical details" for the raw error. Failures after the broadcast
(may have been sent, reverted, replaced) show the hash and explorer link and say not
to send again until it is checked; they never offer "try again".

## Secrets

Private keys and recovery phrases are shown on a separate screen that is wiped when the
user presses Enter (or Ctrl+C); other keys are ignored, so a stray key cannot wipe a new
recovery phrase before it was written down. Nothing stays in scrollback. Wallets › Back up
offers the private key, the recovery phrase (password first; wallets imported from a key
have none) and an encrypted keystore file.
