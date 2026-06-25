# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared

# Next.js standalone output
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm -F @uai/web build
# Ensure public dir exists so COPY never fails
RUN mkdir -p /app/apps/web/public

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# Non-root kullanıcı
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001

# Next.js standalone bundle
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3001

CMD ["node", "apps/web/server.js"]
