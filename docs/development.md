# Development

Guide for setting up and running fhEVM Wallet locally for development.

## Prerequisites

- Node.js 24.11 or later (`node -v`)
- npm (the lockfile is npm's; `npm ci` installs exactly from it)

## Setup

```bash
# 1. Clone the repository
git clone https://github.com/mocarram/fhevm-wallet.git
cd fhevm-wallet

# 2. Install dependencies
make install
# or: npm ci

# 3. Create environment file
make env
# or: cp .env.example .env

# 4. Edit .env with your RPC URLs and API keys
```

## Environment Variables

| Variable               | Description                             | Required    |
| ---------------------- | --------------------------------------- | ----------- |
| `SEPOLIA_RPC_URL`      | Sepolia testnet RPC endpoint            | No          |
| `MAINNET_RPC_URL`      | Ethereum mainnet RPC endpoint           | No          |
| `ETHERSCAN_API_KEY`    | Etherscan API key (for tx history sync) | No          |
| `ZAMA_MAINNET_API_KEY` | Zama relayer API key (mainnet FHE only) | For mainnet |

Only these four keys are read from a `.env` in the current directory, and they never
override variables already set in your shell. RPC URLs there must be https (plain http
only to localhost), or they are ignored with a notice. Anything else in that file (for example
`FHEW_DEBUG`) is ignored with a notice on stderr, so a folder you `cd` into cannot change
how the wallet behaves. Settings saved with `fhew config` go to the private
`~/.fhevm-wallet/.env` instead, which takes precedence.

Example `.env`:

```env
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_INFURA_KEY
MAINNET_RPC_URL=https://mainnet.infura.io/v3/YOUR_INFURA_KEY
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_KEY
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

See the Architecture section of [AGENTS.md](../AGENTS.md): it is kept up to date with
every change (CLI commands, the terminal UI in `src/tui/`, the Backend with its offline
mock, network, FHE, token and storage modules).

## Tests

```bash
npm test             # unit and integration tests (vitest)
npm run test:e2e     # the built CLI against the offline mock backend
npm run verify       # lint, format, build, unit and e2e: must pass before a merge
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

Releases follow [docs/releasing.md](releasing.md). `npm publish` runs `prepublishOnly`,
which cleans `dist/` and runs the full `npm run verify` first, so a failing build or test
stops the publish.
