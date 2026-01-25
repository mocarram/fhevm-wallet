# Docker Setup

Run fhEVM Wallet using Docker without installing Node.js locally.

## Quick Start

```bash
# 1. Create environment file
make env
# Edit .env with your RPC URLs and API keys

# 2. Run
make docker-run
```

## Commands

| Command                       | Description                 |
| ----------------------------- | --------------------------- |
| `make docker-build`           | Build Docker image          |
| `make docker-run`             | Run in Docker (interactive) |
| `make docker-shell`           | Open shell in container     |
| `make docker-send ARGS="..."` | Send tokens via Docker      |
| `make docker-balance`         | Check balance via Docker    |
| `make docker-history`         | View history via Docker     |
| `make docker-clean`           | Remove Docker image         |

## Docker Compose

| Command              | Description               |
| -------------------- | ------------------------- |
| `make up`            | Start with docker-compose |
| `make down`          | Stop services             |
| `make compose-build` | Build with docker-compose |
| `make compose-clean` | Clean all resources       |

## Running with Arguments

```bash
# Send tokens
make docker-send ARGS="0x... 100"

# Check balance
make docker-balance

# View history
make docker-history
```
