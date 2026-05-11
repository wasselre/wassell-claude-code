#!/bin/bash
# Prune stale worktrees. ONLY removes worktrees that meet ALL of these:
#   - Branch has no commits unique to it (i.e. tip is an ancestor of origin/main)
#   - Working tree is clean (no modified/staged files)
#   - No untracked files
#
# Anything else is skipped with a reason. The main worktree and the worktree
# you're invoking from are always skipped.
#
# Default mode is DRY-RUN: prints what would be removed but does nothing.
# Pass --apply to actually delete worktrees and their branches.
#
# Usage:
#   bash scripts/prune-worktrees.sh             # dry-run, list candidates
#   bash scripts/prune-worktrees.sh --apply     # actually delete

set -e

apply=false
if [ "$1" = "--apply" ]; then
    apply=true
fi

git fetch origin main --quiet 2>/dev/null || true
origin_main=$(git rev-parse origin/main)
main_wt=$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')
invoke_wt=$(git rev-parse --show-toplevel)

removed=0
skipped=0
total=0

emit_decision() {
    local path="$1"
    local head="$2"
    local branch="$3"
    local name
    name=$(basename "$path")

    total=$((total + 1))

    # Never touch main or the worktree we're invoked from
    if [ "$path" = "$main_wt" ]; then
        echo "  skip $name -- main worktree"
        skipped=$((skipped + 1))
        return
    fi
    if [ "$path" = "$invoke_wt" ]; then
        echo "  skip $name -- you're invoking from here"
        skipped=$((skipped + 1))
        return
    fi

    # Branch must have no unique commits vs origin/main
    local ahead
    ahead=$(git rev-list --count "$origin_main..$head" 2>/dev/null || echo "?")
    if [ "$ahead" != "0" ]; then
        echo "  skip $name -- $ahead unique commit(s) on the branch"
        skipped=$((skipped + 1))
        return
    fi

    # Working tree must be clean (no modified, no staged, no untracked)
    local dirty
    dirty=$(git -C "$path" status --porcelain 2>/dev/null | head -1)
    if [ -n "$dirty" ]; then
        local count
        count=$(git -C "$path" status --porcelain 2>/dev/null | wc -l)
        echo "  skip $name -- $count uncommitted/untracked file(s)"
        skipped=$((skipped + 1))
        return
    fi

    # Eligible for removal
    if $apply; then
        echo "  remove $name (branch: ${branch#refs/heads/})"
        git worktree remove "$path" 2>&1 | sed 's/^/    /' || {
            echo "    ERROR removing worktree, skipping branch delete"
            skipped=$((skipped + 1))
            return
        }
        if [ -n "$branch" ]; then
            git branch -d "${branch#refs/heads/}" 2>&1 | sed 's/^/    /' || true
        fi
        removed=$((removed + 1))
    else
        echo "  would-remove $name (branch: ${branch#refs/heads/})"
        removed=$((removed + 1))
    fi
}

# Parse worktree blocks
current_path=""
current_head=""
current_branch=""

flush() {
    [ -z "$current_path" ] && return
    emit_decision "$current_path" "$current_head" "$current_branch"
    current_path=""
    current_head=""
    current_branch=""
}

while IFS= read -r line; do
    case "$line" in
        "worktree "*)
            flush
            current_path="${line#worktree }"
            ;;
        "HEAD "*)
            current_head="${line#HEAD }"
            ;;
        "branch "*)
            current_branch="${line#branch }"
            ;;
        "")
            flush
            ;;
    esac
done < <(git worktree list --porcelain)
flush

echo ""
if $apply; then
    echo "Removed $removed worktree(s); skipped $skipped of $total total."
else
    echo "DRY RUN: would remove $removed worktree(s); skipped $skipped of $total total."
    echo "Re-run with --apply to actually delete."
fi
