# ─────────────────────────────────────────────────────────────────────────
# Always-on Claude Code runner (marketing intelligence).
#
# Runs scripts/claude-study-runner.mjs headless on Fly so intelligence work no
# longer depends on the developer laptop. The runner authenticates with the PAID
# subscription via CLAUDE_CODE_OAUTH_TOKEN — injected at RUNTIME via `fly secrets`,
# never baked into an image layer, never echoed to logs.
#
# Exactly ONE runner may execute: ownership is enforced by the DB singleton lease
# (claude_runner_lease), so even a stray second machine exits cleanly at boot.
# ─────────────────────────────────────────────────────────────────────────
FROM node:22-slim

# git: the Claude CLI expects a working repo context for some skills.
# ca-certificates: TLS to Supabase/Anthropic. tini: correct PID-1 signal
# forwarding so Fly's SIGTERM reaches Node and the graceful-shutdown path runs
# (without it, the shutdown handler never fires and jobs are orphaned).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates tini \
      # client_study renders a branded PDF: headless Chromium + python3 (the
      # skill's render_study.py, stdlib only) + Amiri/Noto for Arabic glyphs.
      # Text-only jobs (enrichment, campaign-summary, whatsapp-reply) don't use
      # these, but the runner is shared so the browser must be present.
      chromium python3 fonts-hosny-amiri fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

# Pin the Claude Code CLI version so a silent upstream change can't alter
# production behaviour. Bump deliberately.
ARG CLAUDE_CLI_VERSION=2.1.220
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
    && npm cache clean --force \
    && claude --version

WORKDIR /app

# Runtime deps only (the runner needs @supabase/supabase-js).
COPY runner/package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force

# Runner + validator + version-controlled Skills. No secrets are copied.
COPY scripts/claude-study-runner.mjs ./scripts/claude-study-runner.mjs
COPY scripts/lib ./scripts/lib
# scripts/_lib/serviceClient.mjs — imported by the runner (design-read handlers
# use makeIdentifiedClient). Missing this dir crash-loops the runner at import.
COPY scripts/_lib ./scripts/_lib
COPY .claude/skills ./.claude/skills

# Non-root execution.
RUN useradd -m -u 10001 runner && chown -R runner:runner /app
USER runner
ENV HOME=/home/runner \
    NODE_ENV=production \
    RUNNER_ENV=fly \
    # render_study.py resolves the browser from CHROME_BIN first (Debian's
    # package installs /usr/bin/chromium).
    CHROME_BIN=/usr/bin/chromium \
    # Fly's own init is PID 1, so tini runs as a child and cannot reap orphans
    # by default (it warns about exactly this at boot). The Claude CLI spawns
    # grandchildren; without subreaper mode a killed session can leave zombies
    # that accumulate over a long-lived runner.
    TINI_SUBREAPER=1

# tini reaps zombies and forwards SIGTERM to Node → graceful shutdown → lease
# release. No shell wrapper: a shell would swallow the signal.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/claude-study-runner.mjs"]
