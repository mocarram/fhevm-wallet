# Terminal UI design

The approved interactive design is published as a clickable prototype (private to the
owner): https://claude.ai/artifact/84aiBXnW4L2XEE5ciDePs5

This file is the text reference agents build against.

## Layout of every screen

```
 fhEVM Wallet  Home › Send › Review          [Sepolia] alice 0x3f9A…C21d unlocked 15m 0.4210 ETH
                                              ^ red MAINNET badge on mainnet; yellow ETH when low;
                                                "⠋ 1 pending" segment while a send confirms
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
| L | Lock now | not in text fields |
| / | Filter list | long lists |

## Home

Low-gas nudge (when ETH covers < 5 sends), cached balances with age, then:
`↻ repeat last send` (unnumbered, key `.`), Balances, Send, Receive, History,
Wallets, Tokens, Address book, Settings, Doctor, `0` Quit.

## Send wizard

Token → Recipient → Amount → Review → Sign, with a stepper line. Amount accepts
`25`, `1,250.50`, `1k`, `half`, `max` and shows the exact value. Review shows the fee
estimate and three checks (simulation, balance, ERC-7984). If unlocked, Sign is skipped.
Then a cancellable countdown (default 5 s), broadcast, and return to Home with
`1 pending` in the status bar. On confirmation: balance re-decrypt, success notice with
the matching `fhew send …` command, and an offer to save new addresses.

## Errors

Simulation failures stop before signing and show: what happened, likely cause, what to
try, and "Show technical details" for the raw error.

## Secrets

Private keys and recovery phrases are shown on a screen that is cleared on the next key
press, so they do not remain in scrollback.
