#!/usr/bin/env bash
# Wrapper around the Modal CLI (outside the worktree) so approvals attach to
# this repo-local script. Sets PYTHONUTF8=1 (Windows progress-bar crash guard).
export PYTHONUTF8=1
exec "C:/Users/rayan/AppData/Local/Programs/Python/Python312/Scripts/modal" "$@"
