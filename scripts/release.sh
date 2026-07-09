#!/usr/bin/env bash
# release — cut a version, push it, let GitHub publish to npm.
#
# Usage:
#   ./scripts/release.sh patch    # 1.0.2 → 1.0.3
#   ./scripts/release.sh minor    # 1.0.2 → 1.1.0
#   ./scripts/release.sh major    # 1.0.2 → 2.0.0
#   ./scripts/release.sh 1.5.0    # explicit version
#
# What it does:
#   1. Refuses if the work tree is dirty or main isn't in sync with origin.
#   2. Runs `npm version <bump>` — this bumps package.json AND, via the
#      `version` lifecycle hook (scripts/sync-version.mjs), rewrites
#      src/version.ts to match, then commits both in one commit named
#      "<new-version>" and tags it vX.Y.Z.
#   3. Pushes main + the new tag to origin.
#   4. The Release workflow picks up the tag, runs the full gate, and
#      publishes to npm via OIDC Trusted Publishing. You do nothing else.
#
# You never run `npm publish` or touch an npm token. The only npm command
# invoked is `npm version` (a local file-edit + git-commit helper).

set -euo pipefail

if [ "${1:-}" = "" ]; then
	echo "usage: ./scripts/release.sh <patch|minor|major|X.Y.Z>" >&2
	exit 2
fi
BUMP="$1"

# Guard: must be on main.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
	echo "release: refusing to cut a release from '$BRANCH' — switch to main first" >&2
	exit 1
fi

# Guard: clean work tree (uncommitted changes would get swept into the
# version commit or, worse, left behind).
if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "release: work tree is dirty — commit or stash first" >&2
	git status --short >&2
	exit 1
fi

# Guard: main is up to date with origin (so the tag we push is on a commit
# the release runner can actually check out).
git fetch origin main --quiet
if [ "$(git rev-parse main)" != "$(git rev-parse origin/main)" ]; then
	echo "release: local main has diverged from origin/main — push/pull first" >&2
	exit 1
fi

echo "release: cutting $BUMP on main"
# npm version bumps package.json, fires the `version` hook (which rewrites
# src/version.ts and stages it), commits both as "<new-version>", tags vX.Y.Z.
npm version "$BUMP" >/dev/null
NEW_TAG="v$(node -p "require('./package.json').version")"

echo "release: pushing main + $NEW_TAG"
git push --follow-tags --quiet

echo "release: done. Watch the publish:"
echo "  https://github.com/dylanrussellmd/agent-router/actions/workflows/release.yml"
echo "  https://www.npmjs.com/package/@dylanrussell/agent-router"
