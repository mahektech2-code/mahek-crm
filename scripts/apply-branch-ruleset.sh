#!/usr/bin/env bash
# Applies .github/rulesets/main.json to the repository: creates the ruleset the
# first time, updates it in place every time after, matched on its name. Needs
# `gh` signed in as a repository admin. See DEPLOY.md, "Protecting main".
set -euo pipefail

repo="${1:-mahektech2-code/mahek-crm}"
file="$(dirname "$0")/../.github/rulesets/main.json"
name="$(jq -r .name "$file")"

id="$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id" | head -n1)"

if [ -n "$id" ]; then
  gh api -X PUT "repos/$repo/rulesets/$id" --input "$file" --jq '"updated ruleset \(.id): \(.name)"'
else
  gh api -X POST "repos/$repo/rulesets" --input "$file" --jq '"created ruleset \(.id): \(.name)"'
fi
