# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace manifests first for better layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.json ./
COPY apps/runtime/package.json ./apps/runtime/
COPY packages/shared/package.json ./packages/shared/
COPY db/package.json ./db/

RUN pnpm install --frozen-lockfile

# Copy source
COPY apps/runtime/tsconfig.json ./apps/runtime/
COPY apps/runtime/src ./apps/runtime/src
COPY packages/shared ./packages/shared
COPY db ./db

# Build shared packages first, then runtime
RUN pnpm -F @uai/shared build 2>/dev/null || true
RUN pnpm -F @uai/runtime build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:22-alpine AS production

RUN npm install -g pnpm@9

# Non-root kullanıcı
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/runtime/package.json ./apps/runtime/
COPY packages/shared/package.json ./packages/shared/
COPY db/package.json ./db/

RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/apps/runtime/dist ./apps/runtime/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/db ./db

RUN chown -R appuser:appgroup /app

WORKDIR /app/apps/runtime

USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/server.js"]
