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

### Option 1: Docker (Recommended)

No local dependencies required - just Docker.

```bash
# 1. Clone and enter the directory
git clone <repository-url>
cd fhevm-wallet

# 2. Create environment file
make env
# Edit .env with your RPC URLs and API keys

# 3. Run
make docker-run
```

### Option 2: Local Installation

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

## Docker vs Local Development

| Task                  | Docker                              | Local                             |
| --------------------- | ----------------------------------- | --------------------------------- |
| **Prerequisites**     | Docker only                         | Node.js >= 22                     |
| **Setup**             | `make env`                          | `make install && make env`        |
| **Run (interactive)** | `make docker-run`                   | `make run`                        |
| **Run (with args)**   | `make docker-send ARGS="0x... 100"` | `npm run start -- send 0x... 100` |
| **Check balance**     | `make docker-balance`               | `npm run start -- balance`        |
| **View history**      | `make docker-history`               | `npm run start -- history`        |
| **Shell access**      | `make docker-shell`                 | N/A                               |
| **Build image/code**  | `make docker-build`                 | `make build`                      |
| **Clean up**          | `make docker-clean`                 | `make clean`                      |
| **Run all checks**    | N/A                                 | `make check`                      |

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
> Alternatively, use `npm run start --` or `make` commands as shown in the Quick Start section.

### Interactive Mode

The easiest way to use fhEVM Wallet is through the interactive menu:

```bash
# Docker
make docker-run

# Local
make run
# or: npm run start
```

Interactive mode provides a menu-driven interface with keyboard navigation for all operations.

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

## How It Works

### Fully Homomorphic Encryption (FHE)

FHE allows computations on encrypted data without decrypting it first. This enables confidential token transfers where:

1. Token balances are stored encrypted on-chain
2. Transfer amounts are encrypted before submission
3. The blockchain processes encrypted values directly
4. Only the token holder can decrypt their balance

### ERC-7984 Standard

ERC-7984 is a token standard for confidential tokens using FHE. It provides:

- Encrypted balance storage
- Confidential transfer operations
- Decryption capabilities for authorized users

### Encryption Flow

1. **Wallet Creation**: A standard Ethereum wallet is created and encrypted locally with your password
2. **Balance Query**: Encrypted balances are fetched from the blockchain and decrypted using your private key
3. **Transfers**: Amounts are encrypted client-side before being sent to the token contract

## Make Commands

Run `make help` to see all available commands:

### Development

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

### Docker

| Command                       | Description                 |
| ----------------------------- | --------------------------- |
| `make docker-build`           | Build Docker image          |
| `make docker-run`             | Run in Docker (interactive) |
| `make docker-shell`           | Open shell in container     |
| `make docker-send ARGS="..."` | Send tokens via Docker      |
| `make docker-balance`         | Check balance via Docker    |
| `make docker-history`         | View history via Docker     |
| `make docker-clean`           | Remove Docker image         |

### Docker Compose

| Command              | Description               |
| -------------------- | ------------------------- |
| `make up`            | Start with docker-compose |
| `make down`          | Stop services             |
| `make compose-build` | Build with docker-compose |
| `make compose-clean` | Clean all resources       |

## Project Structure

```
fhevm-wallet/
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── wallet.ts      # Wallet management commands
│   │   │   ├── token.ts       # Token tracking commands
│   │   │   ├── balance.ts     # Balance viewing command
│   │   │   ├── transfer.ts    # Token transfer command
│   │   │   ├── history.ts     # Transaction history command
│   │   │   └── interactive.ts # Interactive TUI mode
│   │   └── index.ts           # CLI setup
│   ├── core/
│   │   ├── fhe/               # FHE encryption services
│   │   ├── network/           # Network configuration
│   │   ├── token/             # Token operations
│   │   └── wallet/            # Wallet operations
│   ├── storage/               # Data persistence
│   │   ├── AddressBook.ts     # Address book storage
│   │   ├── ConfigStore.ts     # Configuration storage
│   │   ├── TransactionStore.ts # Transaction history
│   │   └── WalletStore.ts     # Wallet storage
│   └── utils/                 # Formatting and validation
├── data/                      # Local data storage (created at runtime)
│   ├── wallets/               # Encrypted keystores
│   ├── addressbook.json       # Saved contacts
│   ├── tokens.json            # Tracked tokens
│   ├── transactions.json      # Transaction history
│   └── config.json            # CLI configuration
├── Dockerfile                 # Docker build configuration
├── docker-compose.yml         # Docker Compose configuration
├── Makefile                   # Make commands
└── package.json
```

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
