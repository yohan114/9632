#!/usr/bin/env bash
#
# Update WorkshopOne on the VPS, safely.
#
#   sudo bash /opt/workshopone-unified/app/deploy/update.sh
#   # or legacy path:
#   sudo bash /opt/workshopone/app/deploy/update.sh
#
# Auto-detects unified (/opt/workshopone-unified/app -> workshopone-unified :3400) vs
# legacy (/opt/workshopone/app -> workshopone :3000) installations, reads .env overrides,
# creates and verifies a cold SQLite backup before merging, uses /usr/bin/npm when present
# for Node 20 native ABI safety, restarts systemd, verifies health + PRAGMA integrity_check,
# and automatically rolls back to the prior commit if any check fails.

set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [ -z "${APP:-}" ]; then
  if [ "$SCRIPT_DIR" = "/opt/workshopone-unified/app" ] || [[ "$SCRIPT_DIR" == *"workshopone-unified"* ]]; then
    APP="$SCRIPT_DIR"
    SVC="${SVC:-workshopone-unified}"
    DEFAULT_DATA="/opt/workshopone-unified/data/workshopone_merged.db"
    DEFAULT_PORT="3400"
  else
    APP="/opt/workshopone/app"
    [ -d "$SCRIPT_DIR/.git" ] && APP="$SCRIPT_DIR"
    SVC="${SVC:-workshopone}"
    DEFAULT_DATA="/opt/workshopone/data/workshopone.db"
    DEFAULT_PORT="3000"
  fi
else
  SVC="${SVC:-workshopone}"
  DEFAULT_DATA="/opt/workshopone/data/workshopone.db"
  DEFAULT_PORT="3000"
fi

USER="${USER:-workshopone}"
PORT="${PORT:-$DEFAULT_PORT}"
DATA="${DATA:-$DEFAULT_DATA}"

# Respect explicit DB_PATH and PORT from $APP/.env when present so update checks match runtime config.
if [ -f "$APP/.env" ]; then
  ENV_DB_PATH=$(grep -E '^DB_PATH=' "$APP/.env" | tail -1 | cut -d= -f2- | tr -d "\"'\r " || true)
  ENV_PORT=$(grep -E '^PORT=' "$APP/.env" | tail -1 | cut -d= -f2- | tr -d "\"'\r " || true)
  [ -n "$ENV_DB_PATH" ] && DATA="$ENV_DB_PATH"
  [ -n "$ENV_PORT" ] && PORT="$ENV_PORT"
fi

NODE_BIN="node"
NPM_CMD="npm"
if [ -x /usr/bin/node ] && [ -x /usr/bin/npm ]; then
  NODE_BIN="/usr/bin/node"
  NPM_CMD="env PATH=/usr/bin:/bin /usr/bin/npm"
fi

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
die()  { printf '\n  **  %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo bash $APP/deploy/update.sh"
[ -d "$APP/.git" ]   || die "No git checkout at $APP"

# ---------------------------------------------------------------------------
say "1. Fetching ($SVC @ $APP)"
sudo -u "$USER" git -C "$APP" fetch --quiet origin
BRANCH=$(sudo -u "$USER" git -C "$APP" rev-parse --abbrev-ref HEAD)
BEFORE=$(sudo -u "$USER" git -C "$APP" rev-parse HEAD)
AFTER=$(sudo -u "$USER" git -C "$APP" rev-parse "origin/$BRANCH")

if [ "$BEFORE" = "$AFTER" ]; then
  ok "already up to date ($(echo "$BEFORE" | cut -c1-8)) — nothing to do"
  exit 0
fi

# Local edits would be silently discarded by a hard reset, and on this machine a local edit is
# probably somebody's emergency fix. Stop and let a human decide.
if ! sudo -u "$USER" git -C "$APP" diff --quiet || ! sudo -u "$USER" git -C "$APP" diff --cached --quiet; then
  die "There are uncommitted changes in $APP. Someone edited the server directly.
      Look at them first:  sudo -u $USER git -C $APP diff"
fi

echo "  changes coming in:"
sudo -u "$USER" git -C "$APP" log --oneline "$BEFORE..$AFTER" | sed 's/^/    /'

# ---------------------------------------------------------------------------
if [ "${1:-}" != "--now" ] && [ "${1:-}" != "--skip-notice" ]; then
  say "2. Broadcasting 2-minute maintenance alert to active users"
  if [ -f "$APP/scripts/broadcast_maintenance.js" ]; then
    sudo -u "$USER" bash -c "cd $APP && PORT=$PORT $NODE_BIN scripts/broadcast_maintenance.js 120 'The system will update in 2 minutes. Please save all files, complete tasks, and log out now.'" || true
  elif sudo -u "$USER" git -C "$APP" rev-parse "origin/$BRANCH:scripts/broadcast_maintenance.js" >/dev/null 2>&1; then
    mkdir -p "$APP/scripts"
    sudo -u "$USER" git -C "$APP" show "origin/$BRANCH:scripts/broadcast_maintenance.js" > "$APP/scripts/.tmp_broadcast.js"
    sudo -u "$USER" bash -c "cd $APP && PORT=$PORT $NODE_BIN scripts/.tmp_broadcast.js 120 'The system will update in 2 minutes. Please save all files, complete tasks, and log out now.'" || true
    rm -f "$APP/scripts/.tmp_broadcast.js"
  fi
else
  ok "Immediate update requested (--now): skipping 2-minute notice"
fi

# ---------------------------------------------------------------------------
say "3. Taking & verifying cold backup first"
sudo -u "$USER" bash -c "cd $APP && $NODE_BIN scripts/backup.js" | sed 's/^/  /'
sudo -u "$USER" bash -c "cd $APP && $NODE_BIN scripts/restore.js --verify --latest" | sed 's/^/  /'
ok "cold backup verified; current version $(echo "$BEFORE" | cut -c1-8) — rollback target"

# ---------------------------------------------------------------------------
say "4. Installing"
sudo -u "$USER" git -C "$APP" merge --ff-only "origin/$BRANCH" --quiet
sudo -u "$USER" bash -c "cd $APP && $NPM_CMD ci --omit=dev" 2>&1 | tail -5 | sed 's/^/  /'
ok "now at $(echo "$AFTER" | cut -c1-8)"

# ---------------------------------------------------------------------------
say "5. Restarting $SVC"
systemctl restart "$SVC"

rollback() {
  printf '\n  **  %s\n' "$1" >&2
  printf '  **  putting %s back and restarting %s\n\n' "$(echo "$BEFORE" | cut -c1-8)" "$SVC" >&2
  sudo -u "$USER" git -C "$APP" reset --hard --quiet "$BEFORE"
  sudo -u "$USER" bash -c "cd $APP && $NPM_CMD ci --omit=dev" >/dev/null 2>&1 || true
  systemctl restart "$SVC"
  sleep 3
  if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    die "Rolled back to $(echo "$BEFORE" | cut -c1-8), and the old version is answering. The
      update is NOT applied. Send the output above to whoever wrote the change."
  fi
  die "ROLLED BACK, BUT THE OLD VERSION IS NOT ANSWERING EITHER. The site is down.
      Look at:  journalctl -u $SVC -n 50 --no-pager"
}

# ---------------------------------------------------------------------------
say "6. Checking it actually works"

HEALTHY=0
for i in $(seq 1 15); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
  journalctl -u "$SVC" -n 30 --no-pager || true
  rollback "The app is not answering on 127.0.0.1:$PORT after the restart."
fi
ok "answering on 127.0.0.1:$PORT"

DB_CHECK=$(sudo -u "$USER" bash -c "cd $APP && $NODE_BIN -e '
  const c = require(\"./src/config\");
  const { db, get } = require(\"./src/db\");
  if (require(\"path\").resolve(c.dbPath) !== require(\"path\").resolve(\"$DATA\")) { console.log(\"WRONGDB\"); process.exit(0); }
  const ic = db.pragma(\"integrity_check\", { simple: true });
  if (ic !== \"ok\") { console.log(\"BADIC:\" + ic); process.exit(0); }
  console.log(get(\"SELECT COUNT(*) c FROM users\").c);
' 2>/dev/null" | tail -1)

[ "$DB_CHECK" != "WRONGDB" ] || rollback "The app resolved a different database than $DATA — check .env"
case "$DB_CHECK" in
  BADIC:*) rollback "Database integrity check failed ($DB_CHECK) after migration.";;
  ''|*[!0-9]*) rollback "Could not read the accounts table ($DB_CHECK).";;
esac
[ "$DB_CHECK" -gt 0 ] || rollback "The database has NO user accounts — nobody would be able to sign in."
ok "$DB_CHECK accounts, PRAGMA integrity_check=ok in $DATA"

systemctl is-active --quiet nginx || die "The app is fine but nginx is not running: systemctl status nginx"
ok "nginx is up"

# ---------------------------------------------------------------------------
say "Updated: $(echo "$BEFORE" | cut -c1-8) -> $(echo "$AFTER" | cut -c1-8)"
cat <<NOTE

  Tell anyone already signed in to press Ctrl+Shift+R once. Assets are versioned per restart, so
  this is normally automatic — it is only needed for a browser holding an old service worker.

  If something looks wrong:
    sudo -u $USER bash -c 'cd $APP && $NODE_BIN scripts/doctor.js'
    journalctl -u $SVC -n 50 --no-pager

  To undo this update:
    sudo -u $USER git -C $APP reset --hard $BEFORE && sudo systemctl restart $SVC

NOTE
