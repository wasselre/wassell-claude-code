#!/bin/bash
# Pre-push guard: refuse to push 'main' if the local commit is not on top of latest origin/main.
# Stops a stale worktree from silently reverting recent main commits.
#
# Bypass with `git push --no-verify` (NOT recommended unless you've manually
# verified you actually want to overwrite main).
#
# Invoked by .git/hooks/pre-push, which is installed by scripts/install-git-hooks.sh.
# Args from git: $1=remote-name, $2=remote-url. Refspecs come on stdin, one per line:
#   <local-ref> <local-sha> <remote-ref> <remote-sha>

set -e

remote_name="$1"
zero_sha="0000000000000000000000000000000000000000"

while read -r local_ref local_sha remote_ref remote_sha; do
    # Only guard pushes that target main on the upstream
    [ "$remote_ref" = "refs/heads/main" ] || continue
    # Allow branch deletes (push of all-zeros local sha)
    [ "$local_sha" = "$zero_sha" ] && continue

    if ! git fetch "$remote_name" main --quiet 2>/dev/null; then
        echo ""
        echo "REFUSING TO PUSH: could not fetch $remote_name/main to verify freshness."
        echo "Check your network and try again. If you really need to bypass, use --no-verify."
        echo ""
        exit 1
    fi

    remote_main=$(git rev-parse "$remote_name/main")
    base=$(git merge-base "$local_sha" "$remote_main")

    if [ "$base" != "$remote_main" ]; then
        behind=$(git rev-list --count "$base..$remote_main")
        echo ""
        echo "REFUSING TO PUSH: this branch is $behind commit(s) behind $remote_name/main."
        echo ""
        echo "  Latest $remote_name/main: $(git rev-parse --short "$remote_main")"
        echo "  Your tip:                 $(git rev-parse --short "$local_sha")"
        echo "  Last common ancestor:     $(git rev-parse --short "$base")"
        echo ""
        echo "  Pushing now would silently revert those $behind main commit(s)."
        echo ""
        echo "  To fix:"
        echo "    git fetch $remote_name main"
        echo "    git rebase $remote_name/main"
        echo "    # resolve conflicts if any, then re-push"
        echo ""
        echo "  Bypass (DANGEROUS, requires explicit user OK): git push --no-verify"
        echo ""
        exit 1
    fi
done

exit 0
