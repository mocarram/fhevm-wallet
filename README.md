# FHE Wallet

A CLI wallet for managing encrypted ERC-7984 tokens using Zama's Fully Homomorphic Encryption (FHE) technology.

**Node.js 20+** required

## Features

- **Wallet Management** - Create new wallets or import existing ones via mnemonic phrase or private key
- **Confidential Token Tracking** - Add and manage ERC-7984 compliant tokens
- **Encrypted Balance Viewing** - Decrypt and view your confidential token balances
- **Confidential Transfers** - Send tokens with end-to-end encryption
- **Multi-Network Support** - Works on Ethereum Sepolia testnet and Mainnet

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd fhe-wallet

# Install dependencies
npm install

# Build the project
npm run build

# Link globally for CLI access
npm link
```

After linking, the `fhe-wallet` command will be available globally in your terminal.

## Configuration

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Configure your RPC endpoints in `.env`:

```env
# RPC Endpoints
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_INFURA_KEY
MAINNET_RPC_URL=https://mainnet.infura.io/v3/YOUR_INFURA_KEY

# Default network (sepolia or mainnet)
DEFAULT_NETWORK=sepolia

# Default wallet name (optional)
DEFAULT_WALLET=
```

## Usage

### Wallet Commands

```bash
# Create a new wallet
fhe-wallet wallet create [name]
fhe-wallet wallet create my-wallet --set-default

# Import wallet from mnemonic
fhe-wallet wallet import [name] --mnemonic

# Import wallet from private key
fhe-wallet wallet import [name] --key

# List all wallets
fhe-wallet wallet list
fhe-wallet wallet ls

# Set default wallet
fhe-wallet wallet set-default <name>

# Remove a wallet
fhe-wallet wallet remove <name>
fhe-wallet wallet rm <name> --force
```

### Token Commands

```bash
# Add a token to track
fhe-wallet token add [address]
fhe-wallet token add 0x... --network sepolia

# List tracked tokens
fhe-wallet token list
fhe-wallet token ls --network mainnet

# Remove a tracked token
fhe-wallet token remove <address>
fhe-wallet token rm <address> --network sepolia --force
```

### Balance Command

```bash
# View balances for all tracked tokens
fhe-wallet balance

# View balance with specific wallet
fhe-wallet balance --wallet my-wallet

# View balance for specific token
fhe-wallet balance --token 0x...

# View balance on specific network
fhe-wallet balance --network mainnet
```

### Send Command

```bash
# Send tokens (interactive prompts)
fhe-wallet send

# Send tokens with arguments
fhe-wallet send <to-address> <amount>
fhe-wallet send 0x... 100 --token 0x... --wallet my-wallet

# Send on specific network
fhe-wallet send 0x... 50 --network mainnet
```

### Configuration Command

```bash
# View current configuration
fhe-wallet config --show

# Set default network
fhe-wallet config --network sepolia
```

### Global Flags

```bash
# Use specific network for any command
fhe-wallet balance --network mainnet
fhe-wallet send 0x... 100 -n sepolia
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

## Project Structure

```
fhe-wallet/
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── wallet.ts    # Wallet management commands
│   │   │   ├── token.ts     # Token tracking commands
│   │   │   ├── balance.ts   # Balance viewing command
│   │   │   └── transfer.ts  # Token transfer command
│   │   └── index.ts         # CLI setup
│   ├── core/
│   │   ├── fhe/             # FHE encryption services
│   │   ├── network/         # Network configuration
│   │   ├── token/           # Token operations
│   │   └── wallet/          # Wallet operations
│   ├── storage/             # Data persistence
│   └── utils/               # Formatting and validation
├── data/                    # Local data storage (created at runtime)
│   ├── wallets/             # Encrypted keystores
│   ├── tokens.json          # Tracked tokens
│   └── config.json          # CLI configuration
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
