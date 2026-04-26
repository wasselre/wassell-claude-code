# Cloud worker for Wassell presentations.
# Tiny container — pure Node.js, no Chrome (Phase 4 will revisit when the
# Paseetah tool needs a hosted browser, but that's external — Browserbase or
# similar — not in this image).

FROM node:22-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --prefer-offline --no-audit --no-fund || npm install --omit=dev

# Copy source.
COPY tsconfig.json ./
COPY src ./src

# tsx is a devDep; reinstall including it so we can run TS directly.
# Tradeoff: ~30MB extra layer vs the build complexity of a separate
# `tsc` step + dist/ output. We can switch to compiled JS in Phase 1
# when the worker stops being a few hundred lines.
RUN npm install --no-audit --no-fund tsx@^4.19.2

ENV NODE_ENV=production

CMD ["npx", "tsx", "src/index.ts"]
