# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies exactly from the lockfile
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:24-alpine

WORKDIR /app

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Wallet data (encrypted keystores, settings) lives on a volume, owned by the
# unprivileged "node" user that ships with the official image. FHEVM_WALLET_HOME
# tells the app to use it instead of ~/.fhevm-wallet inside the container.
ENV NODE_ENV=production \
    FHEVM_WALLET_HOME=/data
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME ["/data"]

USER node

ENTRYPOINT ["node", "dist/index.js"]
