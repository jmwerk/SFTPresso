#!/usr/bin/env bash
# Render every docs/*.md as a GitHub wiki page of the same name.
#
# Repo-relative links (../CONTRIBUTING.md, ./foo.md, ...) don't resolve
# on the wiki, so they are rewritten to absolute GitHub blob URLs. Links
# between pages (Configuration.md#ignore) become wiki links (Configuration#ignore).
# Wiki pages with no source in docs/ are removed.
#
# Usage: scripts/sync-wiki.sh [src_dir] [dest_dir]
set -euo pipefail

src=${1:-docs}
dest=${2:-wiki}
repo_url="https://github.com/jmwerk/SFTPresso/blob/develop"

rm -f "$dest"/*.md

for page in "$src"/*.md; do
  sed -E \
    -e "s#\]\(\.\./#](${repo_url}/#g" \
    -e "s#\]\(\./#](${repo_url}/${src}/#g" \
    -e "s#\]\(([A-Za-z_][A-Za-z0-9_-]*)\.md(\#[^)]*)?\)#](\1\2)#g" \
    "$page" > "$dest/$(basename "$page")"
  echo "Wrote $dest/$(basename "$page")"
done
