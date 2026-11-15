#!/bin/zsh
# Fork patch (see FORK.md): deploy this fork's branch to the production OpenDesign on the devbox.
#
#   ~/open-design is tracked by a git dir kept OUTSIDE the tree (~/.open-design.git), so neither
#   the daemon nor the coding agents it spawns ever see a .git folder inside the app.
#
#   fork-deploy.sh             deploy origin/server-folder-browser (snapshot first, auto-rollback)
#   fork-deploy.sh --dry-run   show what would change, touch nothing
#   fork-deploy.sh --rollback  restore the pre-deploy snapshot and restart
set -euo pipefail

# Retired 2026-11-15: production now follows the latest upstream release + this patch, deployed by
# ~/opendesign-backup/upgrade/od-upgrade.sh (branch devbox-<ver>). This script would put the old
# 0.23.1 branch back, so it refuses.
echo "fork-deploy.sh is retired: use ~/opendesign-backup/upgrade/od-upgrade.sh (see FORK.md)" >&2
exit 1

# Run from a temp copy: a rollback rewrites files in the tree this script may live in.
if [[ "${FORK_DEPLOY_COPY:-}" != 1 ]]; then
  tmp=$(mktemp -t fork-deploy).zsh
  cp "$0" "$tmp"
  FORK_DEPLOY_COPY=1 exec zsh "$tmp" "$@"
fi

OD=$HOME/open-design
GD=$HOME/.open-design.git
BRANCH=${FORK_BRANCH:-server-folder-browser}
FORK=git@github.com:FranP-code/open-design.git
UP=https://github.com/nexu-io/open-design.git
SNAP=$HOME/backups/open-design-pre-fork
export PATH="$HOME/od-node/bin:$HOME/od-npm-global/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# pm2 lives under nvm on the devbox; take whichever node install has it.
for d in $HOME/.nvm/versions/node/*/bin(N); do [[ -x $d/pm2 ]] && PATH="$PATH:$d"; done
command -v pm2 >/dev/null || { echo "pm2 not found"; exit 1; }
odgit() { git --git-dir="$GD" --work-tree="$OD" "$@"; }
health() {
  for i in {1..90}; do
    curl -sf -m 3 http://127.0.0.1:7456/api/health >/dev/null && curl -sf -m 3 -o /dev/null http://127.0.0.1:8756/ && return 0
    sleep 2
  done
  return 1
}

if [[ "${1:-}" == "--rollback" ]]; then
  [[ -d $SNAP/apps ]] || { echo "no snapshot at $SNAP"; exit 1; }
  pm2 stop opendesign >/dev/null
  rsync -a --delete --exclude node_modules --exclude .od --exclude .env-od --exclude run-prod.sh "$SNAP/" "$OD/"
  odgit reset -q "$(cat "$SNAP/.fork-deploy-base")"   # index back to the snapshot's commit, tree untouched
  pm2 start opendesign >/dev/null
  health && echo "ROLLBACK OK" || { echo "ROLLBACK: health check failed"; exit 1; }
  exit 0
fi

cd "$OD"

# 0. nothing may be generating right now
RUNS=$(curl -s -m 5 'http://127.0.0.1:7456/api/runs?status=running' | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("runs",[])))')
[[ "$RUNS" == "0" ]] || { echo "ABORT: $RUNS OpenDesign run(s) in progress"; exit 1; }

# 1. one-time: attach the outside-the-tree git dir at the commit the install was unpacked from.
#    Blobless clone: full history is ~3.6 GB, but only commits/trees are needed up front; the few
#    file contents a checkout writes are fetched on demand.
FRESH=
if [[ ! -d $GD ]]; then
  git clone -q --bare --filter=blob:none "$FORK" "$GD"
  odgit config core.bare false
  odgit config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
  odgit remote add upstream "$UP"
  # production files that live in the tree but are not source
  printf '%s\n' '/.env-od' '/run-prod.sh' > "$GD/info/exclude"
  odgit symbolic-ref HEAD refs/heads/installed
  FRESH=1
fi
odgit fetch -q origin
[[ -n $FRESH ]] && odgit reset -q origin/devbox   # branch 'installed' = base, index = base, tree untouched
TARGET=$(odgit rev-parse "origin/$BRANCH")

# 2. the tree must equal HEAD (no local edits to clobber). Missing files are fine: the install
#    tarball never had e2e/, docs/, specs/, .github/.
DIRTY=$(odgit status --porcelain --untracked-files=no | grep -v '^ D ' || true)
if [[ -n "$DIRTY" ]]; then echo "ABORT: ~/open-design has local changes vs $(odgit rev-parse --short HEAD):"; echo "$DIRTY" | head; exit 1; fi
CHANGED=$(odgit diff --name-only HEAD "$TARGET")
MISSING_CHANGED=$(cd "$OD" && echo "$CHANGED" | while read -r f; do [[ -n $f && ! -e $f ]] && odgit cat-file -e "HEAD:$f" 2>/dev/null && echo "$f"; done || true)
echo "HEAD $(odgit rev-parse --short HEAD) -> $BRANCH $(odgit rev-parse --short "$TARGET"): $(echo "$CHANGED" | grep -c . || true) files"
[[ -z "$MISSING_CHANGED" ]] || { echo "ABORT: target changes files missing from the tree:"; echo "$MISSING_CHANGED" | head; exit 1; }
NEEDS_INSTALL=$(echo "$CHANGED" | grep -E '(^|/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$' || true)
[[ "${1:-}" == "--dry-run" ]] && { echo "$CHANGED" | sed 's/^/  /'; echo "install needed: ${NEEDS_INSTALL:-no}"; echo "DRY RUN: nothing changed"; exit 0; }

# 3. snapshot code + build output for rollback (not node_modules, not .od data)
mkdir -p "$SNAP"
rsync -a --delete --exclude node_modules --exclude .od "$OD/" "$SNAP/"
odgit rev-parse HEAD > "$SNAP/.fork-deploy-base"
echo "snapshot: $SNAP ($(du -sh "$SNAP" | cut -f1))"

# 4. check out the target (only files that differ from HEAD are written)
odgit checkout -q -B "$BRANCH" "$TARGET"
odgit branch -q --set-upstream-to="origin/$BRANCH"
[[ -n "$NEEDS_INSTALL" ]] && pnpm install --frozen-lockfile --prefer-offline >/tmp/od-deploy-install.log 2>&1
pnpm --filter @open-design/daemon build >/tmp/od-deploy-daemon.log 2>&1 || { echo "daemon build failed (/tmp/od-deploy-daemon.log), rolling back"; exec zsh "$0" --rollback; }

# 5. the web build rewrites .next in place, so the old server must be stopped first (~1 min down)
pm2 stop opendesign >/dev/null
pnpm --filter @open-design/web build >/tmp/od-deploy-web.log 2>&1 || { echo "web build failed (/tmp/od-deploy-web.log), rolling back"; exec zsh "$0" --rollback; }
pm2 start opendesign >/dev/null
health || { echo "health check failed, rolling back"; exec zsh "$0" --rollback; }
echo "DEPLOYED $(odgit rev-parse --short HEAD) ($BRANCH)"
