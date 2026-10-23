#!/usr/bin/env bash
# Check that vendored fixtures and lexicons are byte-for-byte what their SOURCE files say they are.
#
#   check-fixtures.sh --fixtures DIR    a port's fixtures directory: DIR/SOURCE, DIR/*.json, DIR/lexicon/
#   check-fixtures.sh --lexicon DIR     a lexicon directory on its own: DIR/SOURCE, DIR/*.json
#
# SOURCE is read one line at a time: blank lines and lines starting with '#' are skipped, and the
# first three whitespace-separated fields of every other line are
#
#   <repo> <commit> [<path>]
#
# where <repo> is atgeo-sdk-js or garganorn, <commit> is a hex SHA (the full 40 characters; an
# abbreviation of 7 or more is resolved, and an ambiguous or unknown one fails), and <path> is the
# directory in that repo the files were copied from (default fixtures/ for atgeo-sdk-js,
# garganorn/lexicon/ for garganorn). Anything after the third field is for people.
#
# --fixtures needs an atgeo-sdk-js line in DIR/SOURCE. The lexicon copy in DIR/lexicon needs a
# garganorn line, from DIR/lexicon/SOURCE if there is one and from DIR/SOURCE if not.
#
# Fails (exit 1) if a pinned commit does not exist, or a vendored *.json file differs from the pinned
# commit's, is missing from the copy, or is not in the pinned commit. Warns (a GitHub ::warning::
# annotation under Actions, and still exit 0) if the pin is behind its upstream: the fixtures behind
# atgeo-sdk-js's default branch, a port's lexicons behind that branch's test/lexicon, or the lexicons
# given with --lexicon behind garganorn's default branch. Exit 2 is a usage error.
#
# Needs bash, git and diff, and the network (https://github.com). CHECK_FIXTURES_BASE replaces
# https://github.com/schuyler, for a mirror.

set -euo pipefail

BASE=${CHECK_FIXTURES_BASE:-https://github.com/schuyler}
export GIT_TERMINAL_PROMPT=0

usage() {
  sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

if [ -n "${GITHUB_ACTIONS:-}" ]; then
  warn() { echo "::warning::$*"; }
  err() { echo "::error::$*"; }
else
  warn() { echo "warning: $*"; }
  err() { echo "error: $*" >&2; }
fi

failures=0
fail() { err "$*"; failures=$((failures + 1)); }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# clone REPO: a clone with every commit and tree and no blobs (they are fetched when a diff needs
# one), in $work/REPO. HEAD there is the upstream default branch.
clone() {
  [ -d "$work/$1" ] && return 0
  git clone --quiet --no-checkout --filter=blob:none "$BASE/$1.git" "$work/$1" 2>"$work/clone.err" \
    || { cat "$work/clone.err" >&2; err "cannot clone $BASE/$1.git"; exit 1; }
}

# pin REPO SOURCEFILE: prints "<commit> <path>" from the first line of SOURCEFILE that names REPO.
pin() {
  local repo sha path
  while read -r repo sha path _; do
    [ "$repo" = "$1" ] || continue
    if [ -z "$path" ]; then
      case $repo in atgeo-sdk-js) path=fixtures ;; garganorn) path=garganorn/lexicon ;; esac
    fi
    echo "$sha ${path%/}"
    return 0
  done < <(grep -Ev '^[[:space:]]*(#|$)' "$2")
  return 1
}

# resolve REPO SHA: sets $full to the full commit SHA. Fails if SHA is not hex, names no commit, or
# is an abbreviation of more than one.
resolve() {
  local repo=$1 sha=$2
  case $repo in atgeo-sdk-js | garganorn) ;; *) fail "SOURCE names '$repo'; expected atgeo-sdk-js or garganorn"; return 1 ;; esac
  if ! [[ $sha =~ ^[0-9a-f]{7,40}$ ]]; then fail "SOURCE has '$sha' for $repo, which is not a hex commit SHA"; return 1; fi
  clone "$repo"
  if ! full=$(git -C "$work/$repo" rev-parse --verify --quiet "$sha^{commit}" 2>/dev/null); then
    fail "$repo commit $sha does not exist, or is ambiguous, on $BASE/$repo.git"
    return 1
  fi
}

# tree REPO REV PATH: "<blob id> <name>" for each *.json directly under PATH at REV.
tree() {
  { git -C "$work/$1" ls-tree "$2:$3" 2>/dev/null || true; } \
    | awk '$2 == "blob" && $4 ~ /\.json$/ { print $3, $4 }' | LC_ALL=C sort -k2
}

# local_ids DIR: the same for the *.json files directly in DIR (the blob id is what git would store).
local_ids() {
  local f
  for f in "$1"/*.json; do
    [ -f "$f" ] || continue
    echo "$(git hash-object --no-filters --stdin <"$f") ${f##*/}"
  done | LC_ALL=C sort -k2
}

has_name() { awk -v n="$2" '$2 == n { f = 1 } END { exit !f }' <<<"$1"; }

# compare LABEL DIR REPO COMMIT PATH: every *.json in DIR is the file at REPO's COMMIT, and no file is
# missing or extra. Returns 1, having reported each problem, if not.
compare() {
  local label=$1 dir=$2 repo=$3 commit=$4 path=$5 want have n=0 id name short=${4:0:12} before=$failures
  want=$(tree "$repo" "$commit" "$path")
  if [ -z "$want" ]; then fail "$label: $repo $short has no $path/*.json"; return; fi
  have=$(local_ids "$dir")
  while read -r id name; do
    n=$((n + 1))
    if ! has_name "$have" "$name"; then
      fail "$label: $dir/$name is missing; $repo $short has $path/$name"
    elif ! grep -qxF "$id $name" <<<"$have"; then
      fail "$label: $dir/$name differs from $repo $short $path/$name"
      git -C "$work/$repo" show "$commit:$path/$name" \
        | diff -u --label "$repo@$short:$path/$name" --label "$dir/$name" - "$dir/$name" | head -20 || true
    fi
  done <<<"$want"
  while read -r id name; do
    [ -n "$name" ] || continue
    has_name "$want" "$name" || fail "$label: $dir/$name is not in $repo $short $path/"
  done <<<"$have"
  [ "$failures" -eq "$before" ] || return 1
  echo "ok: $label: $dir ($n files) vs $repo $short $path/"
}

# behind LABEL DIR UPSTREAM_REPO UPSTREAM_PATH: DIR is known to match its pin, so if it differs from
# UPSTREAM_REPO's default branch the pin is behind. Warn, don't fail: a fixture change upstream would
# otherwise turn every downstream CI red at once.
behind() {
  local label=$1 dir=$2 up=$3 uppath=$4 head want have
  clone "$up"
  head=$(git -C "$work/$up" rev-parse HEAD)
  want=$(tree "$up" "$head" "$uppath")
  have=$(local_ids "$dir")
  if [ "$want" != "$have" ]; then
    warn "$label: $dir is behind $up $uppath/ at its default branch (${head:0:12}); differing: $(
      diff <(echo "$want") <(echo "$have") | awk '/^[<>]/ { print $3 }' | sort -u | tr '\n' ' ')"
  fi
}

# check_lexicon DIR [FALLBACK_SOURCE] [js]: the lexicon copy in DIR against its garganorn pin, from
# DIR/SOURCE if there is one and from FALLBACK_SOURCE if not. With js, a pin that is behind is judged
# against atgeo-sdk-js's test/lexicon, which is what a port follows; without, against garganorn.
check_lexicon() {
  local dir=$1 src=$1/SOURCE line commit path full
  [ -f "$src" ] || src=${2:-}
  [ -f "$src" ] || { err "$dir/SOURCE not found"; exit 2; }
  line=$(pin garganorn "$src") || { fail "$src has no garganorn line"; return; }
  read -r commit path <<<"$line"
  resolve garganorn "$commit" || return 0
  compare lexicon "$dir" garganorn "$full" "$path" || return 0
  if [ "${3:-}" = js ]; then behind lexicon "$dir" atgeo-sdk-js test/lexicon; else behind lexicon "$dir" garganorn "$path"; fi
}

check_fixtures() {
  local dir=$1 line commit path full
  [ -f "$dir/SOURCE" ] || { err "$dir/SOURCE not found"; exit 2; }
  if line=$(pin atgeo-sdk-js "$dir/SOURCE"); then
    read -r commit path <<<"$line"
    if resolve atgeo-sdk-js "$commit"; then
      if compare fixtures "$dir" atgeo-sdk-js "$full" "$path"; then behind fixtures "$dir" atgeo-sdk-js "$path"; fi
    fi
  else
    fail "$dir/SOURCE has no atgeo-sdk-js line"
  fi
  if [ -d "$dir/lexicon" ]; then
    check_lexicon "$dir/lexicon" "$dir/SOURCE" js
  else
    fail "$dir/lexicon not found"
  fi
}

[ $# -eq 2 ] || usage
case $1 in
  --fixtures) check_fixtures "${2%/}" ;;
  --lexicon) check_lexicon "${2%/}" ;;
  *) usage ;;
esac

if [ "$failures" -gt 0 ]; then
  err "$failures mismatch(es): vendored files do not match their SOURCE pins"
  exit 1
fi
