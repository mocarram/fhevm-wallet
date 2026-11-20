# Docker Setup

Run fhEVM Wallet using Docker without installing Node.js locally.

## Quick Start

```bash
# 1. Create environment file (created readable by you only)
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

## Where your wallet data lives

The container stores wallets, settings and history in `/data`, which is mounted from
`./data` on the host (`FHEVM_WALLET_HOME=/data`). Keystores stay encrypted with your
wallet password, and files are written with owner-only permissions.

The container runs as the unprivileged `node` user (uid 1000). The `make docker-*` targets
and `make up` create `./data` first (`make data-dir`), because a folder Docker creates for
a bind mount belongs to root. If your host uid is not 1000, or `./data` was created by
root, give it to that user once:

```bash
sudo chown -R 1000:1000 ./data && chmod 700 ./data
```

`docker-compose.yml` treats `.env` as optional (`required: false`), which needs Docker
Compose 2.24 or newer. Settings you save from inside the wallet (`fhew config …`) go to
`/data/.env` on the volume, not to the `.env` next to the compose file.

> Upgrading from 1.x: earlier images mounted `./data` at `/app/data` but actually wrote
> wallets to `/root/.fhevm-wallet` inside the container, so they were not persisted. If
> you created wallets in an old container that still exists, copy them out with
> `docker cp <container>:/root/.fhevm-wallet/. ./data/` before removing it.
