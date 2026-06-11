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

# poppler-utils gives us pdftoppm — used by pdfToImages.ts to render PDF
# pages to PNGs before sending them to Anthropic as image content blocks
# (PDF document blocks balloon unpredictably with image-heavy PDFs; image
# blocks have a predictable ~1.5k tokens each). Adds ~10 MB to the image
# but skips Node-native PDF rendering (pdfjs + node-canvas) which would
# add ~30 MB and need extra system libs anyway.
#
# libreoffice-writer/-impress/-calc give us headless `soffice` — used by
# runPreviewJob.ts to convert DOC/DOCX/PPT/PPTX/XLS/XLSX to PDF for in-app
# previews WITHOUT shipping bytes to a third-party viewer (~400 MB, the
# price of keeping documents private). The font packages matter: Arabic
# documents need Amiri (the Wassel brand font) + Noto Arabic installed or
# converted PDFs render as tofu boxes.
RUN apk add --no-cache \
    poppler-utils \
    libreoffice-writer \
    libreoffice-impress \
    libreoffice-calc \
    fontconfig \
    font-amiri \
    font-noto-arabic \
    font-noto \
    ttf-dejavu \
    font-liberation

# Install production deps only — keeps the image small.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder.
COPY --from=builder /app/dist ./dist

# Fly.io health checks hit this port (see fly.toml).
EXPOSE 8080

CMD ["node", "dist/index.js"]
