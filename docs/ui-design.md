# Terminal UI design

The approved interactive design is published as a clickable prototype (private to the
owner): https://claude.ai/artifact/84aiBXnW4L2XEE5ciDePs5

This file is the text reference agents build against.

## Layout of every screen

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

| Key | Action | Where |
| --- | --- | --- |
| ↑ ↓ / k j | Move | lists |
| Enter | Select / next step | everywhere |
| Esc | Back one screen or step, keeping input; stops the send countdown | not Home |
| Ctrl+C | Cancel to Home; twice on Home quits | everywhere |
| 1-9 | Jump to numbered item (numbers are stable) | menus |
| 0 / q | Quit | Home |
| b s r h d | Balances, Send, Receive, History, Doctor | Home |
| . | Repeat last send | Home |
| a | Save last new address as contact | Home, when offered |
| : | Command bar | not in text fields |
| ? | Help for this screen | not in text fields |
| L or l | Lock now | not in text fields |
| / | Filter list (planned, Phase 4) | long lists |
| e | What happened to the last send | Home, after a failed send |
| p | Paste an address | Send › Recipient |
| Space / a | Select one / all | multi-select lists (Remove tokens, Find tokens) |

## Home

Low-gas nudge (when ETH covers < 5 sends), cached balances with age, then:
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
multi-select list) and a disabled "Find tokens (coming soon)" slot for Phase 4.

## Errors

Simulation failures stop before signing and show: what happened, likely cause, what to
try, and "Show technical details" for the raw error. Failures after the broadcast
(may have been sent, reverted, replaced) show the hash and explorer link and say not
to send again until it is checked; they never offer "try again".

## Secrets

Private keys and recovery phrases are shown on a screen that is cleared on the next key
press, so they do not remain in scrollback.
