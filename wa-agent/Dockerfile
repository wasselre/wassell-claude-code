# wassel-wa-agent — runs headless Claude Code sessions that answer WhatsApp.
#
# Unlike the deck worker (which runs compiled TS), this image's whole job is to
# host the `claude` CLI: the intelligence is a real Claude Code session, not an
# API call. Node 22 + git (the CLI shells out to it) + the runner + the skill.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Claude Code CLI — the agent itself.
RUN npm install -g @anthropic-ai/claude-code

# Runner deps.
COPY package.json ./
RUN npm install --omit=dev

# Runner + the tools sessions call.
COPY runner.mjs ./
# The skill documents these as /app/wa-agent/tools/* (matching the repo layout).
# Put them exactly there — a session should never have to hunt for its own tools.
COPY tools /app/wa-agent/tools

# The skill lives where a session started in /app/repo will find it.
RUN mkdir -p /app/repo/.claude/skills/whatsapp-reply
COPY skill/SKILL.md /app/repo/.claude/skills/whatsapp-reply/SKILL.md

# NON-ROOT. The Claude CLI hard-refuses --dangerously-skip-permissions when
# running as root ("cannot be used with root/sudo privileges for security
# reasons") — verified live 2026-07-26: the first real job spawned a session
# that died on exactly that. Headless sessions have no one to approve prompts,
# so the flag is required; therefore the process must not be root.
RUN useradd -m -u 10001 -s /bin/bash agent \
    && chown -R agent:agent /app
USER agent
ENV HOME=/home/agent

# Sessions run with cwd=/app/repo; give them a git identity so the CLI is happy.
RUN cd /app/repo && git init -q \
    && git config user.email "agent@wassel.re" \
    && git config user.name "Wassel WA Agent"

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "runner.mjs"]
