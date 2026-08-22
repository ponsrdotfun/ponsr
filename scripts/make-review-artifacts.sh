#!/usr/bin/env bash
#
# Builds the review artifacts and PROVES what each one is.
#
#   bash scripts/make-review-artifacts.sh <START_COMMIT>
#
# Three artifacts get produced, and the labels are the point. A previous delivery shipped
# a "full" bundle that could not be cloned on its own and a patch whose range was not the
# one declared beside it -- both are easy mistakes and both waste a reviewer's afternoon
# before they find out.
#
# So each claim here is checked by doing the thing:
#
#   standalone bundle  -> actually cloned into a scratch directory, from nothing
#   incremental bundle -> verified, and its prerequisite named rather than hidden
#   patch              -> applied to a checkout of START, and the result's tree hash
#                         compared to END
set -euo pipefail

START="${1:?usage: make-review-artifacts.sh <START_COMMIT>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

END="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

echo "=== BUILDING REVIEW ARTIFACTS ==="
echo "  branch  $BRANCH"
echo "  start   $START"
echo "  end     $END"
echo

rm -f ponsr-standalone.bundle ponsr-incremental.bundle ponsr-range.patch ponsr-commits.txt

# 1. Standalone: every ref and all history. Clonable from nothing.
git bundle create ponsr-standalone.bundle --all >/dev/null 2>&1

# 2. Incremental: this closure only. Requires START in the receiving repository.
git bundle create ponsr-incremental.bundle "$START..$BRANCH" >/dev/null 2>&1

# 3. Patch for exactly the declared range, and the commit list to match.
git diff --binary "$START..$END" > ponsr-range.patch
git log --oneline --decorate "$START..$END" > ponsr-commits.txt

echo "=== PROOF: the standalone bundle clones from nothing ==="
git clone -q --branch "$BRANCH" ponsr-standalone.bundle "$SCRATCH/standalone"
echo "  cloned HEAD  $(git -C "$SCRATCH/standalone" rev-parse HEAD)"
test "$(git -C "$SCRATCH/standalone" rev-parse HEAD)" = "$END" \
  && echo "  matches END  yes" || { echo "  matches END  NO"; exit 1; }
echo

echo "=== PROOF: the incremental bundle needs its prerequisite (by design) ==="
git bundle verify ponsr-incremental.bundle 2>&1 | sed 's/^/  /'
echo

echo "=== PROOF: the patch is exactly $START..$END ==="
git clone -q --branch "$BRANCH" ponsr-standalone.bundle "$SCRATCH/patchtest"
git -C "$SCRATCH/patchtest" checkout -q "$START"
git -C "$SCRATCH/patchtest" apply --binary "$ROOT/ponsr-range.patch"
git -C "$SCRATCH/patchtest" add -A
APPLIED="$(git -C "$SCRATCH/patchtest" write-tree)"
EXPECTED="$(git rev-parse "$END^{tree}")"
echo "  tree after applying to START  $APPLIED"
echo "  tree of END                   $EXPECTED"
test "$APPLIED" = "$EXPECTED" \
  && echo "  equivalent                    yes" || { echo "  equivalent  NO"; exit 1; }
echo

echo "=== ARTIFACTS ==="
for f in ponsr-standalone.bundle ponsr-incremental.bundle ponsr-range.patch ponsr-commits.txt; do
  printf '  %-30s %10s bytes  %s\n' "$f" "$(stat -c%s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
done
