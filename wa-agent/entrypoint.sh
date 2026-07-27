#!/bin/sh
# Runs as root for exactly one reason: a Fly volume is mounted root-owned, and
# the process must run as `agent` (the Claude CLI refuses
# --dangerously-skip-permissions under root). Take ownership of the mount, then
# drop privileges for good.
set -e

if [ -d /home/agent/.claude ]; then
  chown -R agent:agent /home/agent/.claude 2>/dev/null || \
    echo "[entrypoint] WARNING: could not chown /home/agent/.claude — session state may not persist"
fi

exec gosu agent "$@"
