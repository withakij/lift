#!/usr/bin/env bash
# One-shot: create the GitHub repository, push, and start the build that
# produces the installers. Needs the GitHub CLI: https://cli.github.com
set -euo pipefail

REPO_NAME="${1:-lift}"
VISIBILITY="${2:---private}"
TAG="${3:-v1.1.0}"

command -v gh >/dev/null || { echo "GitHub CLI not found. Install it: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not signed in. Run: gh auth login"; exit 1; }

OWNER="$(gh api user --jq .login)"
echo "Publishing as $OWNER"

if gh repo view "$OWNER/$REPO_NAME" >/dev/null 2>&1; then
  echo "Repository $OWNER/$REPO_NAME already exists — pushing to it."
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
  git push -u origin HEAD:main
else
  gh repo create "$REPO_NAME" "$VISIBILITY" \
    --source=. --remote=origin --push \
    --description "Lift — product collection and migration for Shopify and WooCommerce. Made by Rahul Raj."
fi

echo "Tagging $TAG to start the build…"
git tag -f "$TAG"
git push -f origin "$TAG"

echo
echo "Build started. Watch it:"
echo "  https://github.com/$OWNER/$REPO_NAME/actions"
echo
echo "When it finishes (about 5-10 minutes) the installers are here:"
echo "  https://github.com/$OWNER/$REPO_NAME/releases/tag/$TAG"
echo
echo "Following the run now — press Ctrl-C to stop watching (the build keeps going):"
sleep 6
gh run watch --exit-status || true
gh release view "$TAG" --web 2>/dev/null || true
