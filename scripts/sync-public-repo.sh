#!/usr/bin/env bash
# Publishes the mcp/ directory of the Kelvia monorepo to the standalone public
# repository as a snapshot: the public repo gets its own linear history, one
# commit per sync, and none of the monorepo's commits.
#
#   ./mcp/scripts/sync-public-repo.sh              # dry run, prints what would change
#   ./mcp/scripts/sync-public-repo.sh --push       # commits and pushes
#   ./mcp/scripts/sync-public-repo.sh --push --rewrite
#                                                  # replaces the public history
#                                                  # with a single commit
#
# Only files tracked by git are published, so anything ignored — node_modules,
# dist, local env files — cannot leak by accident. The public repo is a mirror:
# never commit to it directly, or the next sync will revert those edits.
#
# --rewrite force-pushes one fresh commit. Use it when something has to stop
# existing in the public history, not merely stop being present at HEAD; note
# that force-pushing only unlinks the old commits, and GitHub can still serve
# them by their exact SHA until it garbage-collects.
set -euo pipefail

PREFIX="mcp"
REMOTE_URL="${KELVIA_MCP_REMOTE:-https://github.com/gonnagetapower/kelvia-mcp.git}"
TARGET_BRANCH="main"

# Tracked under mcp/ but deliberately not published: internal to the monorepo.
EXCLUDE=("RELEASE_CHECKLIST.md")

PUSH=false
REWRITE=false
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=true ;;
    --rewrite) REWRITE=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
ROOT="$(pwd)"

if [[ -n "$(git status --porcelain -- "$PREFIX")" ]]; then
  echo "error: $PREFIX has uncommitted changes — commit them first" >&2
  exit 1
fi

# The public tree must never carry credentials. Fail loudly rather than
# discovering a leaked token after the repository is public.
if git ls-files "$PREFIX" | grep -Eq '(^|/)\.env($|\.)|\.mcp\.json$'; then
  echo "error: $PREFIX tracks an env or local MCP config file" >&2
  exit 1
fi
if git grep -nIE '(klv|zmt)_[A-Za-z0-9_-]{16,}' -- "$PREFIX" >/dev/null 2>&1; then
  echo "error: $PREFIX appears to contain a real Kelvia token" >&2
  git grep -nIE '(klv|zmt)_[A-Za-z0-9_-]{16,}' -- "$PREFIX" >&2
  exit 1
fi

for required in README.md LICENSE SECURITY.md CONTRIBUTING.md CHANGELOG.md server.json package.json .gitignore; do
  [[ -f "$PREFIX/$required" ]] || { echo "error: $PREFIX/$required is missing" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git init --quiet --initial-branch="$TARGET_BRANCH" "$WORK"
git -C "$WORK" remote add origin "$REMOTE_URL"
# Build on top of whatever the public repo already has, so each sync is one
# ordinary commit rather than a force-push over the previous snapshot.
if $REWRITE; then
  echo "==> rewriting the public history as a single commit"
elif git -C "$WORK" fetch --quiet --depth=1 origin "$TARGET_BRANCH" 2>/dev/null; then
  git -C "$WORK" reset --quiet --hard FETCH_HEAD
  git -C "$WORK" rm -rq --cached . 2>/dev/null || true
  find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  echo "==> syncing on top of the existing $TARGET_BRANCH"
else
  echo "==> publishing the first commit"
fi

# Only tracked files travel, with the mcp/ prefix stripped and EXCLUDE dropped.
git ls-files -z "$PREFIX" | while IFS= read -r -d '' file; do
  rel="${file#"$PREFIX"/}"
  skip=false
  for excluded in "${EXCLUDE[@]}"; do
    [[ "$rel" == "$excluded" ]] && skip=true
  done
  $skip && continue
  dest="$WORK/$rel"
  mkdir -p "$(dirname "$dest")"
  cp -p "$ROOT/$file" "$dest"
done

cd "$WORK"
git add -A
if git diff --cached --quiet; then
  echo "==> public repository already matches $PREFIX/, nothing to do"
  exit 0
fi

echo "==> changes to publish:"
git diff --cached --stat | sed 's/^/    /'

VERSION="$(node -p "require('$ROOT/$PREFIX/package.json').version")"
if ! $PUSH; then
  echo "dry run — re-run with --push to publish to $REMOTE_URL"
  exit 0
fi

git -c user.name="${GIT_AUTHOR_NAME:-Kelvia}" -c user.email="${GIT_AUTHOR_EMAIL:-noreply@kelvia.app}" \
  commit --quiet -m "Sync kelvia-mcp $VERSION from the Kelvia monorepo"
if $REWRITE; then
  git push --quiet --force origin "$TARGET_BRANCH"
  echo "==> force-pushed a single commit to $REMOTE_URL ($TARGET_BRANCH)"
else
  git push --quiet origin "$TARGET_BRANCH"
  echo "==> pushed to $REMOTE_URL ($TARGET_BRANCH)"
fi
