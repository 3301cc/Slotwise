#!/usr/bin/env bash
# Pushes this repo to GitHub — run on YOUR machine (uses your own git login / SSH key).
#   1. github.com → New repository → name "slotwise", private, NO README/.gitignore → Create
#   2. ./scripts/push-to-github.sh <github-user>        (e.g. ./scripts/push-to-github.sh 3301cc)
set -euo pipefail
user="${1:?GitHub-Benutzername angeben, z. B. ./scripts/push-to-github.sh 3301cc}"
repo="${2:-slotwise}"
cd "$(dirname "$0")/.."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { git init -q; git checkout -q -b main; git add -A; git commit -q -m "Slotwise"; }
git remote get-url origin >/dev/null 2>&1 || git remote add origin "git@github.com:$user/$repo.git"
# SSH not set up? fall back to HTTPS (git will ask for your GitHub login / token in the browser or credential helper)
git ls-remote origin >/dev/null 2>&1 || git remote set-url origin "https://github.com/$user/$repo.git"
git push -u origin main
echo
echo "Fertig. Jetzt auf vercel.com: Add New → Project → $repo importieren → Root Directory apps/site → Deploy (Details: DEPLOY.md)"
