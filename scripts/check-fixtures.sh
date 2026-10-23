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
# garganorn/lexicon/ for garganorn). Anything after the third field, a parenthetical included, is ignored.
#
# --fixtures needs an atgeo-sdk-js line in DIR/SOURCE. The lexicon copy in DIR/lexicon needs a
# garganorn line, from DIR/lexicon/SOURCE if there is one and from DIR/SOURCE if not.
#
# Fails (exit 1) if a pinned commit does not exist, or a vendored file differs from the pinned commit's,
# is missing from the copy, or is not in the pinned commit. Every file counts, at any depth and of any
# type, except SOURCE itself (and, for --fixtures, lexicon/, which is checked on its own). A symlink,
# FIFO or other non-regular file never matches anything. File modes are ignored. Warns (a GitHub
# ::warning:: annotation under Actions, and still exit 0) if the pin is behind its upstream: the
# fixtures behind atgeo-sdk-js's default branch, a port's lexicons behind that branch's test/lexicon,
# or the lexicons given with --lexicon behind garganorn's default branch. Exit 2 is a usage error.
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
  local attempt
  [ -d "$work/$1" ] && return 0
  for attempt in 1 2 3; do
    rm -rf "${work:?}/$1"
    if git clone --quiet --no-checkout --filter=blob:none "$BASE/$1.git" "$work/$1" 2>"$work/clone.err"; then
      return 0
    fi
    [ "$attempt" -lt 3 ] && sleep "$attempt"
  done
  cat "$work/clone.err" >&2
  err "cannot clone $BASE/$1.git"
  exit 1
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
  done < <(tr -d '\r' <"$2" | grep -Ev '^[[:space:]]*(#|$)')
  return 1
}

# resolve REPO SHA: sets $full to the full commit SHA. Fails if SHA is not hex, names no commit, or
# is an abbreviation of more than one.
resolve() {
  local repo=$1 sha
  sha=$(tr '[:upper:]' '[:lower:]' <<<"$2")
  case $repo in atgeo-sdk-js | garganorn) ;; *) fail "SOURCE names '$repo'; expected atgeo-sdk-js or garganorn"; return 1 ;; esac
  if ! [[ $sha =~ ^[0-9a-f]{7,40}$ ]]; then fail "SOURCE has '$2' for $repo, which is not a hex commit SHA"; return 1; fi
  clone "$repo"
  if ! full=$(git -C "$work/$repo" rev-parse --verify --quiet "$sha^{commit}" 2>/dev/null); then
    fail "$repo commit $sha does not exist, or is ambiguous, on $BASE/$repo.git"
    return 1
  fi
}

# tree REPO REV PATH [SKIP]: "<blob id><TAB><path>" for every file under PATH at REV, paths relative to
# PATH, without the top-level SOURCE and without anything under SKIP/.
tree() {
  local entry meta path mode type id
  { git -C "$work/$1" ls-tree -r -z "$2:$3" 2>/dev/null || true; } | while IFS= read -r -d '' entry; do
    meta=${entry%%$'\t'*}
    path=${entry#*$'\t'}
    [ "$path" = SOURCE ] && continue
    case $path in "${4:-}"/*) [ -n "${4:-}" ] && continue ;; esac
    read -r mode type id <<<"$meta"
    if [ "$type" = blob ]; then printf '%s\t%s\n' "$id" "$path"; fi
  done | LC_ALL=C sort -t $'\t' -k2
}

# local_ids DIR [SKIP]: the same for everything under DIR that is not a directory (the blob id is what
# git would store), without the top-level SOURCE and without anything under DIR/SKIP/. A symlink, a
# FIFO or any other entry that is not a regular file gets the id "non-regular", which matches nothing,
# so it is always extra (or different, if the pinned commit has a file by that name). Modes are ignored.
local_ids() {
  local f rel id
  while IFS= read -r -d '' f; do
    rel=${f#"$1"/}
    [ "$rel" = SOURCE ] && continue
    case $rel in "${2:-}"/*) [ -n "${2:-}" ] && continue ;; esac
    if [ -f "$f" ] && [ ! -L "$f" ]; then id=$(git hash-object --no-filters --stdin <"$f"); else id=non-regular; fi
    printf '%s\t%s\n' "$id" "$rel"
  done < <(find "$1" ! -type d -print0) | LC_ALL=C sort -t $'\t' -k2
}

has_path() { P=$2 awk -F '\t' '$2 == ENVIRON["P"] { f = 1 } END { exit !f }' <<<"$1"; }

# compare LABEL DIR REPO COMMIT PATH [SKIP]: every file in DIR (but SOURCE, and SKIP/ if given) is the
# file at REPO's COMMIT, and none is missing or extra. Returns 1, having reported each problem, if not.
compare() {
  local label=$1 dir=$2 repo=$3 commit=$4 path=$5 want have n=0 id name short=${4:0:12} before=$failures
  want=$(tree "$repo" "$commit" "$path" "${6:-}")
  if [ -z "$want" ]; then fail "$label: $repo $short has no files in $path/"; return 1; fi
  have=$(local_ids "$dir" "${6:-}")
  while IFS=$'\t' read -r id name; do
    n=$((n + 1))
    if ! has_path "$have" "$name"; then
      fail "$label: $dir/$name is missing; $repo $short has $path/$name"
    elif ! grep -qxF "$id"$'\t'"$name" <<<"$have"; then
      fail "$label: $dir/$name differs from $repo $short $path/$name"
      git -C "$work/$repo" show "$commit:$path/$name" \
        | diff -u --label "$repo@$short:$path/$name" --label "$dir/$name" - "$dir/$name" | head -20 || true
    fi
  done <<<"$want"
  while IFS=$'\t' read -r id name; do
    [ -n "$name" ] || continue
    has_path "$want" "$name" || fail "$label: $dir/$name is not in $repo $short $path/"
  done <<<"$have"
  [ "$failures" -eq "$before" ] || return 1
  echo "ok: $label: $dir ($n files) vs $repo $short $path/"
}

# behind LABEL DIR UPSTREAM_REPO UPSTREAM_PATH [SKIP]: DIR is known to match its pin, so if it differs
# from UPSTREAM_REPO's default branch the pin is behind. Warn, don't fail: a fixture change upstream
# would otherwise turn every downstream CI red at once.
behind() {
  local label=$1 dir=$2 up=$3 uppath=$4 head want have
  clone "$up"
  head=$(git -C "$work/$up" rev-parse HEAD)
  want=$(tree "$up" "$head" "$uppath" "${5:-}")
  have=$(local_ids "$dir" "${5:-}")
  if [ "$want" != "$have" ]; then
    warn "$label: $dir is behind $up $uppath/ at its default branch (${head:0:12}); differing: $(
      diff <(echo "$want") <(echo "$have") | awk -F '\t' '/^[<>]/ { print $2 }' | sort -u | tr '\n' ' ')"
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
      if compare fixtures "$dir" atgeo-sdk-js "$full" "$path" lexicon; then behind fixtures "$dir" atgeo-sdk-js "$path" lexicon; fi
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
  --fixtures | --lexicon)
    dir=$2
    while [ "${#dir}" -gt 1 ] && [ "${dir%/}" != "$dir" ]; do dir=${dir%/}; done
    if [ "$1" = --fixtures ]; then check_fixtures "$dir"; else check_lexicon "$dir"; fi ;;
  *) usage ;;
esac

if [ "$failures" -gt 0 ]; then
  err "$failures mismatch(es): vendored files do not match their SOURCE pins"
  exit 1
fi
