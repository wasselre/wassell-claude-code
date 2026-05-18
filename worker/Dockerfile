# ─────────────────────────────────────────────────────────────────────────
# Stage 1: build TypeScript
# ─────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy manifests first for cacheable npm ci.
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# Build.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────
# Stage 2: production image
# ─────────────────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install production deps only — keeps the image small.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder.
COPY --from=builder /app/dist ./dist

# Fly.io health checks hit this port (see fly.toml).
EXPOSE 8080

CMD ["node", "dist/index.js"]
