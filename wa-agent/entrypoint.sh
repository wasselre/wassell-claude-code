#!/bin/sh
# Runs as root for exactly one reason: /home/agent is a Fly volume, mounted
# root-owned, and the process must run as `agent` (the Claude CLI refuses
# --dangerously-skip-permissions under root). Take ownership, then drop
# privileges for good.
set -e

HOME_DIR=/home/agent

if [ -d "$HOME_DIR" ]; then
  # Cheap on every boot. The recursive pass runs only on a fresh volume —
  # the session store grows without bound and chown -R over it every restart
  # would get slower for no benefit.
  chown agent:agent "$HOME_DIR" 2>/dev/null || true
  if [ ! -f "$HOME_DIR/.owned" ]; then
    chown -R agent:agent "$HOME_DIR" 2>/dev/null || \
      echo "[entrypoint] WARNING: could not chown $HOME_DIR — session state may not persist"
    touch "$HOME_DIR/.owned" 2>/dev/null || true
    chown agent:agent "$HOME_DIR/.owned" 2>/dev/null || true
  fi
fi

# The CLI keeps `~/.claude.json` (the index that makes a session id resumable)
# separate from the transcripts, and backs it up under ~/.claude/backups. If the
# live file is missing but a backup is not, restore the newest one — otherwise
# every --resume fails and each conversation silently restarts from turn one.
if [ ! -f "$HOME_DIR/.claude.json" ] && [ -d "$HOME_DIR/.claude/backups" ]; then
  BACKUP=$(ls -1t "$HOME_DIR"/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1)
  if [ -n "$BACKUP" ]; then
    cp "$BACKUP" "$HOME_DIR/.claude.json" && chown agent:agent "$HOME_DIR/.claude.json"
    echo "[entrypoint] restored ~/.claude.json from $BACKUP"
  fi
fi

exec gosu agent "$@"
