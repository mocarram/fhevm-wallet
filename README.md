# fhEVM Wallet

A CLI wallet for managing encrypted ERC-7984 tokens using Zama's Fully Homomorphic Encryption (FHE) technology.

## Features

- **Interactive terminal UI** - Status bar, numbered menus, a send wizard with safety checks, `?` help and a `:` command bar
- **Wallet Management** - Create new wallets or import existing ones via mnemonic phrase or private key
- **Confidential Token Tracking** - Add and manage ERC-7984 compliant tokens
- **Encrypted Balance Viewing** - Decrypt and view your confidential token balances
- **Confidential Transfers** - Send tokens with end-to-end encryption
- **Address Book** - Save frequently used addresses with friendly names
- **Multi-Network Support** - Works on Ethereum Sepolia testnet and Mainnet

![fhEVM Wallet CLI](docs/images/main-menu.png)

## Installation

Requires Node.js >= 24.11.

```bash
# npm
npm install -g fhevm-wallet

# yarn
yarn global add fhevm-wallet

# pnpm
pnpm add -g fhevm-wallet

# bun
bun add -g fhevm-wallet
```

## Usage

Run `fhevm-wallet` or the shorter alias `fhew` to start the interactive terminal UI
(`fhew interactive` does the same):

```bash
fhew
```

The first start walks you through setup: wallet, network, a token and ETH for gas.
Then, on any screen:

| Key | Action |
| --- | --- |
| ↑ ↓ / k j, Enter | Move and select |
| 1-9, 0 | Jump to a numbered item; 0 quits from Home |
| b s r h d | Balances, Send, Receive, History, Doctor (on Home) |
| . | Repeat your last send (stops on Review) |
| Esc | Back one step, keeping what you typed; stops a send countdown |
| Ctrl+C | Back to Home; twice on Home quits |
| : | Command bar: `send bob 25 cusdc`, `balances`, `doctor`, `lock`, `help`, … |
| ? | Help for the current screen |
| L | Lock now (the decrypted key is only ever held in memory) |

Sends go Token → Recipient → Amount → Review → Sign. Amounts accept `25`, `1,250.50`,
`1k`, `half` and `max` and show the exact value. A pasted address that looks like a saved
contact stops the send; a first-time address is flagged; after the send you can save it.
On Mainnet you retype the amount and a countdown always runs before broadcasting.

Try the UI without any network or funds against the offline simulation (a `MOCK` badge is
shown). Use a throwaway data folder so simulated tokens and history stay out of your real one:

```bash
FHEW_BACKEND=mock FHEVM_WALLET_HOME=$(mktemp -d) fhew
```

### Wallet Commands

```bash
# Create a new wallet
fhew wallet create my-wallet

# Import wallet from mnemonic
fhew wallet import my-wallet --mnemonic

# Import wallet from private key
fhew wallet import my-wallet --key

# List all wallets
fhew wallet list

# Set default wallet
fhew wallet set-default my-wallet
```

### Token Commands

```bash
# Add a token to track
fhew token add 0x...

# List tracked tokens
fhew token list

# Remove a tracked token
fhew token remove 0x...
```

### Balance & Transfers

```bash
# View balances for all tracked tokens
fhew balance

# View balance on specific network
fhew balance --network mainnet

# Send tokens (interactive prompts)
fhew send

# Send tokens with arguments
fhew send 0x... 100 --token 0x...
```

### Configuration

```bash
# View current configuration
fhew config --show

# Set default network
fhew config --network sepolia

# Set RPC endpoints (https only; the wallet checks the chain ID before saving).
# Use - to type the URL hidden, so its key stays out of your shell history.
fhew config --rpc-mainnet https://mainnet.infura.io/v3/YOUR_KEY
fhew config --rpc-sepolia -

# Set API keys
fhew config --etherscan-key YOUR_ETHERSCAN_KEY
fhew config --zama-key YOUR_ZAMA_KEY
```

### Global Flags

```bash
# Use specific network for any command
fhew balance --network mainnet
fhew send 0x... 100 -n sepolia
```

## Data Storage

All data is stored in `~/.fhevm-wallet/` (set `FHEVM_WALLET_HOME` to use another folder):

```
~/.fhevm-wallet/
├── wallets/           # Encrypted keystore files
├── .env               # RPC URLs and API keys saved by `fhew config`
├── config.json        # CLI configuration
├── tokens.json        # Tracked tokens
├── addressbook.json   # Saved contacts
├── transactions.json  # Local transaction history
├── audit.log          # Wallet events (never amounts, keys or phrases)
└── balance-cache.json # Cached balances
```

The folder is readable only by you (`0700`, files `0600`), and files are replaced
atomically so a crash cannot leave half a keystore behind. Data written by older versions
is tightened automatically the next time the wallet starts.

## Documentation

- [Wallet Guide](docs/wallet.md) - Detailed wallet, token, and balance documentation
- [Development](docs/development.md) - Local development setup
- [Docker](docs/docker.md) - Docker setup
- [Contributing](CONTRIBUTING.md) - Contribution guidelines

## Security

- Wallets are encrypted locally using standard Ethereum keystore format with scrypt
- Your password never leaves your machine
- Recovery phrases and private keys are shown on a separate screen that is wiped when you
  press a key, so they do not stay in your terminal scrollback
- Prefer `fhew wallet export <name> --keystore <file>` for backups: the file stays
  encrypted with your password
- Before sending, the wallet checks the RPC serves the right chain and that your decrypted
  balance covers the amount (ERC-7984 transfers that exceed the balance move 0 instead of
  failing); after sending it re-checks that the balance went down
- **Write down your recovery phrase** - anyone with it can access your funds
- Start with testnet (Sepolia) before using mainnet

## License

MIT
