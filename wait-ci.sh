#!/bin/bash
# Throwaway: block until every check on the PR has settled, then print them.
for i in $(seq 1 45); do
  n=$(gh pr checks "$1" --json bucket --jq '[.[] | select(.bucket=="pending")] | length' 2>/dev/null)
  if [ "$n" = "0" ]; then break; fi
  sleep 20
done
gh pr checks "$1"
