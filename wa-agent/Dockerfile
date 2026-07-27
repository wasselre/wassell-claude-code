# wassel-wa-agent — runs headless Claude Code sessions that answer WhatsApp.
#
# Unlike the deck worker (which runs compiled TS), this image's whole job is to
# host the `claude` CLI: the intelligence is a real Claude Code session, not an
# API call. Node 22 + git (the CLI shells out to it) + the runner + the skill.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gosu \
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
ENV HOME=/home/agent

# `/home/agent/.claude` is a Fly VOLUME (see fly.toml) so conversation state
# outlives a deploy. Without it every machine replacement wiped the CLI's
# session store, every resume failed with "No conversation found with session
# ID", and each customer message restarted the agent cold — which is why it
# contradicted itself and re-asked what it had already been told (live
# 2026-07-27). Fly mounts volumes root-owned, so the entrypoint runs as root
# purely to chown the mount, then drops to `agent` for the actual process.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Sessions run with cwd=/app/repo; give them a git identity so the CLI is happy.
# Run as `agent` so the repo it works in is owned by the user that works in it.
RUN gosu agent sh -c 'cd /app/repo && git init -q \
    && git config user.email "agent@wassel.re" \
    && git config user.name "Wassel WA Agent"'

# Pre-create the mountpoint so a machine booted WITHOUT the volume still has a
# writable (if ephemeral) session dir rather than failing outright.
RUN mkdir -p /home/agent/.claude && chown -R agent:agent /home/agent

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "runner.mjs"]
