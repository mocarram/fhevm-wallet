# fhEVM Wallet CLI

A CLI wallet for managing encrypted ERC-7984 tokens using Zama's Fully Homomorphic Encryption (FHE) technology.

## Features

- **Interactive Mode** - Menu-driven terminal interface with keyboard navigation
- **Wallet Management** - Create new wallets or import existing ones via mnemonic phrase or private key
- **Confidential Token Tracking** - Add and manage ERC-7984 compliant tokens
- **Encrypted Balance Viewing** - Decrypt and view your confidential token balances
- **Confidential Transfers** - Send tokens with end-to-end encryption
- **Address Book** - Save frequently used addresses with friendly names
- **Multi-Network Support** - Works on Ethereum Sepolia testnet and Mainnet

## Quick Start

Requires Node.js >= 22.

```bash
# 1. Clone and enter the directory
git clone <repository-url>
cd fhevm-wallet

# 2. Install dependencies
make install

# 3. Create environment file
make env
# Edit .env with your RPC URLs and API keys

# 4. Build and run
make run
```

> For Docker setup, see [docs/docker.md](docs/docker.md).

## Configuration

Create a `.env` file from the template:

```bash
make env
```

Configure your environment in `.env`:

| Variable            | Description                              | Required |
| ------------------- | ---------------------------------------- | -------- |
| `SEPOLIA_RPC_URL`   | Sepolia testnet RPC endpoint             | Yes      |
| `MAINNET_RPC_URL`   | Ethereum mainnet RPC endpoint            | Yes      |
| `ETHERSCAN_API_KEY` | Etherscan API key (for tx history sync)  | No       |
| `DEFAULT_NETWORK`   | Default network (`sepolia` or `mainnet`) | No       |
| `DEFAULT_WALLET`    | Default wallet name                      | No       |

Example `.env`:

```env
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_INFURA_KEY
MAINNET_RPC_URL=https://mainnet.infura.io/v3/YOUR_INFURA_KEY
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_KEY
DEFAULT_NETWORK=sepolia
DEFAULT_WALLET=my-wallet
```

## Usage

> **Note:** Examples below use `fhevm-wallet` which requires global installation via `npm link`.
> Alternatively, use `npm run start --` or `make run`.

### Interactive Mode

The easiest way to use fhEVM Wallet is through the interactive menu:

```bash
make run
# or: npm run start
```

### Wallet Commands

```bash
# Create a new wallet
fhevm-wallet wallet create [name]
fhevm-wallet wallet create my-wallet --set-default

# Import wallet from mnemonic
fhevm-wallet wallet import [name] --mnemonic

# Import wallet from private key
fhevm-wallet wallet import [name] --key

# List all wallets
fhevm-wallet wallet list

# Set default wallet
fhevm-wallet wallet set-default <name>

# Remove a wallet
fhevm-wallet wallet remove <name>
```

### Token Commands

```bash
# Add a token to track
fhevm-wallet token add [address]
fhevm-wallet token add 0x... --network sepolia

# List tracked tokens
fhevm-wallet token list

# Remove a tracked token
fhevm-wallet token remove <address>
```

### Balance Command

```bash
# View balances for all tracked tokens
fhevm-wallet balance

# View balance with specific wallet
fhevm-wallet balance --wallet my-wallet

# View balance for specific token
fhevm-wallet balance --token 0x...

# View balance on specific network
fhevm-wallet balance --network mainnet
```

### Send Command

```bash
# Send tokens (interactive prompts)
fhevm-wallet send

# Send tokens with arguments
fhevm-wallet send <to-address> <amount>
fhevm-wallet send 0x... 100 --token 0x... --wallet my-wallet

# Send to a saved contact
fhevm-wallet send --contact Alice 100

# Send on specific network
fhevm-wallet send 0x... 50 --network mainnet
```

### Address Book

Save frequently used addresses for quick access:

```bash
# In interactive mode: Address Book > Add Contact
# Contacts appear when selecting recipients in Send flow

# Send to a saved contact via CLI
fhevm-wallet send --contact Alice 100
```

### Configuration Command

```bash
# View current configuration
fhevm-wallet config --show

# Set default network
fhevm-wallet config --network sepolia
```

### Global Flags

```bash
# Use specific network for any command
fhevm-wallet balance --network mainnet
fhevm-wallet send 0x... 100 -n sepolia
```

## Make Commands

Run `make help` to see all available commands:

| Command         | Description                          |
| --------------- | ------------------------------------ |
| `make install`  | Install dependencies                 |
| `make build`    | Build TypeScript                     |
| `make dev`      | Run in development mode              |
| `make run`      | Build and run                        |
| `make lint`     | Run ESLint                           |
| `make lint-fix` | Fix lint issues                      |
| `make format`   | Format with Prettier                 |
| `make check`    | Run all checks (lint, format, build) |
| `make clean`    | Clean build artifacts                |

## How It Works

### Fully Homomorphic Encryption (FHE)

FHE allows computations on encrypted data without decrypting it first. This enables confidential token transfers where:

1. Token balances are stored encrypted on-chain
2. Transfer amounts are encrypted before submission
3. The blockchain processes encrypted values directly
4. Only the token holder can decrypt their balance

### ERC-7984 Standard

[ERC-7984](https://eips.ethereum.org/EIPS/eip-7984) is a token standard for confidential tokens using FHE. It provides:

- Encrypted balance storage
- Confidential transfer operations
- Decryption capabilities for authorized users

### Encryption Flow

1. **Wallet Creation**: A standard Ethereum wallet is created and encrypted locally with your password
2. **Balance Query**: Encrypted balances are fetched from the blockchain and decrypted using your private key
3. **Transfers**: Amounts are encrypted client-side before being sent to the token contract

## Security Notes

### Keystore Encryption

Wallets are stored using standard Ethereum keystore format with scrypt key derivation. Your password encrypts the private key locally - it never leaves your machine.

### Recovery Phrase

When creating a new wallet, a 12-word mnemonic recovery phrase is displayed. **Write this down and store it securely.** Anyone with access to this phrase can restore your wallet and access your funds.

### Data Storage

All wallet data is stored locally in the `./data` directory relative to where you run the CLI:

- `data/wallets/` - Encrypted keystore files
- `data/config.json` - CLI configuration
- `data/tokens.json` - List of tracked tokens

Consider backing up the `data/wallets/` directory and keeping it secure.

### Best Practices

- Use a strong password (minimum 8 characters) for wallet encryption
- Never share your recovery phrase or private key
- Verify recipient addresses carefully before sending
- Start with testnet (Sepolia) before using mainnet

## License

MIT
