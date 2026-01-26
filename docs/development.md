# Development

Guide for setting up and running fhEVM Wallet locally for development.

## Prerequisites

- Node.js >= 22
- npm, yarn, pnpm, or bun

## Setup

```bash
# 1. Clone the repository
git clone https://github.com/mocarram/fhevm-wallet.git
cd fhevm-wallet

# 2. Install dependencies
make install
# or: npm install

# 3. Create environment file
make env
# or: cp .env.example .env

# 4. Edit .env with your RPC URLs and API keys
```

## Environment Variables

| Variable            | Description                              | Required |
| ------------------- | ---------------------------------------- | -------- |
| `SEPOLIA_RPC_URL`   | Sepolia testnet RPC endpoint             | No       |
| `MAINNET_RPC_URL`   | Ethereum mainnet RPC endpoint            | No       |
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

## Running

```bash
# Development mode (with ts-node)
make dev
# or: npm run dev

# Build and run
make run
# or: npm run build && npm run start

# Run directly after build
npm run start
# or: node dist/index.js
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
| `make env`      | Create .env from template            |

## Project Structure

```
src/
├── index.ts              # Entry point
├── cli/
│   ├── index.ts          # Commander setup
│   ├── commands/         # Command implementations
│   │   ├── wallet.ts
│   │   ├── token.ts
│   │   ├── balance.ts
│   │   ├── transfer.ts
│   │   ├── history.ts
│   │   └── interactive.ts
│   └── utils/
├── core/
│   ├── wallet/           # Wallet management
│   ├── token/            # Token operations
│   ├── fhe/              # FHE encryption/decryption
│   └── network/          # Network configuration
├── storage/              # Data persistence
└── utils/                # Utilities
```

## Building

```bash
# Build TypeScript to dist/
npm run build

# Clean build artifacts
npm run clean
# or: make clean
```

## Linting & Formatting

```bash
# Run ESLint
npm run lint

# Fix lint issues
npm run lint:fix

# Format with Prettier
npm run format

# Check formatting
npm run format:check
```

## Local Testing

Link the package globally for testing:

```bash
npm link
```

Then you can use `fhevm-wallet` or `fhew` commands from anywhere:

```bash
fhew --version
fhew wallet list
```

To unlink:

```bash
npm unlink -g fhevm-wallet
```

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

## Publishing

The package is configured for npm publishing:

```bash
# Login to npm
npm login

# Publish (runs prepublishOnly which builds automatically)
npm publish
```

The `prepublishOnly` script ensures a clean build before publishing.
