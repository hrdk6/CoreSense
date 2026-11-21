# ==============================================================================
# CoreSense Backend API — Production Multi-Stage Dockerfile
# Compatible with Railway, Render, Fly.io, and self-hosted Docker
# ==============================================================================

FROM node:24-slim AS builder
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/diagnostics-core/package.json packages/diagnostics-core/tsconfig.json ./packages/diagnostics-core/
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/

RUN npm ci --workspace @coresense/shared --workspace @coresense/diagnostics-core --workspace @coresense/api --include-workspace-root=false

COPY packages/shared/src ./packages/shared/src
COPY packages/diagnostics-core/src ./packages/diagnostics-core/src
COPY apps/api/src ./apps/api/src

RUN npm --workspace @coresense/shared run build \
 && npm --workspace @coresense/diagnostics-core run build \
 && npm --workspace @coresense/api run build

# Production runtime image
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV DATA_DIR=/app/data

RUN groupadd --system coresense && useradd --system --gid coresense coresense \
 && mkdir -p /app/data/uploads && chown -R coresense:coresense /app

COPY --from=builder --chown=coresense:coresense /app/package.json ./
COPY --from=builder --chown=coresense:coresense /app/node_modules ./node_modules
COPY --from=builder --chown=coresense:coresense /app/packages/shared/package.json ./packages/shared/
COPY --from=builder --chown=coresense:coresense /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=coresense:coresense /app/packages/diagnostics-core/package.json ./packages/diagnostics-core/
COPY --from=builder --chown=coresense:coresense /app/packages/diagnostics-core/dist ./packages/diagnostics-core/dist
COPY --from=builder --chown=coresense:coresense /app/apps/api/package.json ./apps/api/
COPY --from=builder --chown=coresense:coresense /app/apps/api/dist ./apps/api/dist

USER coresense
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]
