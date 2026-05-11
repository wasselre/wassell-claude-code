#!/bin/bash
# Audit every git worktree of this repo. For each, print:
#   name, branch, SHA, age of last commit, commits ahead of origin/main,
#   commits behind origin/main, and a verdict.
#
# Verdicts:
#   SAFE     -- branch's tip is an ancestor of origin/main (no unique commits) -> safe to remove
#   STALE    -- branch is N commits behind origin/main but has no unique commits -> safe to remove
#   WIP      -- branch has unique commits not on origin/main -> needs attention before removing
#   MAIN     -- the main worktree itself; never auto-remove
#
# Usage:
#   bash scripts/audit-worktrees.sh           # human-readable table
#   bash scripts/audit-worktrees.sh --tsv     # tab-separated, for piping to awk/sort

set -e

git fetch origin main --quiet 2>/dev/null || {
    echo "WARNING: could not fetch origin/main; verdicts based on cached refs."
}
origin_main=$(git rev-parse origin/main)
main_wt=$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')

format="$1"

if [ "$format" != "--tsv" ]; then
    printf "%-44s %-44s %-8s %-12s %-7s %-7s %s\n" "WORKTREE" "BRANCH" "SHA" "AGE" "AHEAD" "BEHIND" "VERDICT"
    printf "%-44s %-44s %-8s %-12s %-7s %-7s %s\n" "$(printf '%.0s-' {1..44})" "$(printf '%.0s-' {1..44})" "--------" "------------" "-------" "-------" "-------"
fi

# Parse `git worktree list --porcelain` blocks (worktree / HEAD / branch lines, blank-separated).
current_path=""
current_head=""
current_branch=""

emit_row() {
    [ -z "$current_path" ] && return

    local name branch sha age ahead behind verdict
    name=$(basename "$current_path")
    branch="${current_branch#refs/heads/}"
    sha=$(git rev-parse --short "$current_head" 2>/dev/null || echo "????")

    # Age of the commit
    age=$(git log -1 --format='%cr' "$current_head" 2>/dev/null || echo "unknown")

    # Ahead / behind vs origin/main
    if [ "$current_head" = "$origin_main" ]; then
        ahead=0
        behind=0
    else
        ahead=$(git rev-list --count "$origin_main..$current_head" 2>/dev/null || echo "?")
        behind=$(git rev-list --count "$current_head..$origin_main" 2>/dev/null || echo "?")
    fi

    # Verdict
    if [ "$current_path" = "$main_wt" ]; then
        verdict="MAIN"
    elif [ "$ahead" = "0" ] && [ "$behind" = "0" ]; then
        verdict="SAFE (== origin/main)"
    elif [ "$ahead" = "0" ]; then
        verdict="STALE (behind only)"
    else
        verdict="WIP ($ahead unique)"
    fi

    if [ "$format" = "--tsv" ]; then
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$name" "$branch" "$sha" "$age" "$ahead" "$behind" "$verdict"
    else
        # Truncate name/branch to fit
        local name_disp="${name:0:43}"
        local branch_disp="${branch:0:43}"
        local age_disp="${age:0:12}"
        printf "%-44s %-44s %-8s %-12s %-7s %-7s %s\n" "$name_disp" "$branch_disp" "$sha" "$age_disp" "$ahead" "$behind" "$verdict"
    fi
}

while IFS= read -r line; do
    case "$line" in
        "worktree "*)
            emit_row
            current_path="${line#worktree }"
            current_head=""
            current_branch=""
            ;;
        "HEAD "*)
            current_head="${line#HEAD }"
            ;;
        "branch "*)
            current_branch="${line#branch }"
            ;;
        "")
            emit_row
            current_path=""
            ;;
    esac
done < <(git worktree list --porcelain)

# Final row (in case input doesn't end with a blank line)
emit_row

if [ "$format" != "--tsv" ]; then
    echo ""
    echo "Verdicts:"
    echo "  SAFE   = branch is at origin/main; remove freely."
    echo "  STALE  = branch is behind origin/main but has no unique commits; remove freely."
    echo "  WIP    = branch has unique commits not on origin/main; investigate before removing."
    echo "  MAIN   = the main worktree; never remove."
fi
