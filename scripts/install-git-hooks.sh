#!/bin/bash
# Install the safe-push-main pre-push hook.
#
# Git shares .git/hooks across the main repo and every worktree by default,
# so a single install protects ALL worktrees (existing and future).
#
# The installed hook is a one-line wrapper that exec()s the version-controlled
# scripts/safe-push-main.sh in the main worktree. Logic stays in source control;
# only re-run this if the absolute path to the main worktree ever changes.
#
# Usage:
#   bash scripts/install-git-hooks.sh

set -e

# Find the main worktree (always the first entry from `git worktree list --porcelain`).
main_wt=$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')
script="$main_wt/scripts/safe-push-main.sh"

if [ ! -f "$script" ]; then
    echo "ERROR: $script not found."
    echo "       scripts/safe-push-main.sh must exist in the main worktree's filesystem"
    echo "       (i.e. the change must already be on the main branch)."
    exit 1
fi

# git common-dir resolves to the shared .git directory regardless of which
# worktree we're invoked from. That's where shared hooks live.
common_dir=$(git rev-parse --git-common-dir)
case "$common_dir" in
    /*|[A-Za-z]:/*|[A-Za-z]:\\*) hooks_dir="$common_dir/hooks" ;;
    *)                            hooks_dir="$(git rev-parse --show-toplevel)/$common_dir/hooks" ;;
esac

mkdir -p "$hooks_dir"
hook="$hooks_dir/pre-push"

# Back up any pre-existing hook that isn't already ours.
if [ -f "$hook" ] && ! grep -q 'safe-push-main' "$hook" 2>/dev/null; then
    backup="$hook.bak.$(date +%s)"
    cp "$hook" "$backup"
    echo "Backed up existing hook: $backup"
fi

# Invoke through `bash` rather than exec'ing the script directly. The scripts in
# this repo are committed mode 100644 (no exec bit) -- on the Windows laptop that
# is invisible because Git Bash fakes the mode, but on Linux (cloud session, CI,
# a WSL checkout) `exec "$script"` dies with "Permission denied" and blocks EVERY
# push, including to a feature branch. Going through bash makes the hook work
# regardless of whether the exec bit survived the checkout.
cat > "$hook" <<EOF
#!/bin/bash
# Auto-installed by scripts/install-git-hooks.sh -- delegates to the version-controlled script.
exec /bin/bash "$script" "\$@"
EOF
chmod +x "$hook"

echo "Installed pre-push hook: $hook"
echo "Delegates to:           $script"
echo ""
echo "Coverage: shared .git/hooks/ -- protects ALL worktrees of this repo."
echo ""
echo "Test from any stale worktree:  git push --force --dry-run origin HEAD:main"
echo "Hook should refuse with a 'rebase first' message."
