# Build stage. The base image is pinned by digest (node:24-alpine, looked up 2026-11-21) so
# a re-tagged image cannot change what is built; bump it deliberately.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder

WORKDIR /app

# Install dependencies exactly from the lockfile. No install scripts: none is needed (the
# only one, keccak's native build, has a pure-JS fallback) and each is code run at build.
COPY package*.json ./
RUN npm ci --ignore-scripts

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

WORKDIR /app

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

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
