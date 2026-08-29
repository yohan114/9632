#!/usr/bin/env bash
#
# Update WorkshopOne on the VPS, safely.
#
#   sudo bash /opt/workshopone/app/deploy/update.sh
#
# Takes a backup, fetches, installs, migrates, restarts, and then CHECKS THAT IT WORKED — and puts
# the old version back if it did not. The checks are the point: migrations run automatically at
# boot, so a bad update is discovered by a storekeeper, not by whoever ran the deploy, unless
# something looks straight afterwards.
#
# Written to be run by someone who is not a sysadmin, on a machine holding the company's records.
# It refuses rather than guesses, and it says what it is doing before it does it.

set -Eeuo pipefail

APP=/opt/workshopone/app
DATA=/opt/workshopone/data/workshopone.db
SVC=workshopone
USER=workshopone
PORT=3000

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
die()  { printf '\n  **  %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo bash $APP/deploy/update.sh"
[ -d "$APP/.git" ]   || die "No git checkout at $APP"

# ---------------------------------------------------------------------------
say "1. Backing up first"
# Not optional. Migrations are additive and have never dropped anything, but "never so far" is not
# a reason to skip the thirty seconds this takes when the alternative is the workshop's history.
sudo -u "$USER" bash -c "cd $APP && node scripts/backup.js" | sed 's/^/  /'
BEFORE=$(sudo -u "$USER" git -C "$APP" rev-parse HEAD)
ok "current version $(echo "$BEFORE" | cut -c1-8) — this is what a rollback returns to"

# ---------------------------------------------------------------------------
say "2. Fetching"
sudo -u "$USER" git -C "$APP" fetch --quiet origin
BRANCH=$(sudo -u "$USER" git -C "$APP" rev-parse --abbrev-ref HEAD)
AFTER=$(sudo -u "$USER" git -C "$APP" rev-parse "origin/$BRANCH")

if [ "$BEFORE" = "$AFTER" ]; then
  ok "already up to date — nothing to do"
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
say "3. Installing"
sudo -u "$USER" git -C "$APP" merge --ff-only "origin/$BRANCH" --quiet
sudo -u "$USER" bash -c "cd $APP && npm ci --omit=dev" 2>&1 | tail -3 | sed 's/^/  /'
ok "now at $(echo "$AFTER" | cut -c1-8)"

# ---------------------------------------------------------------------------
say "4. Restarting"
systemctl restart "$SVC"
sleep 4

rollback() {
  printf '\n  **  %s\n' "$1" >&2
  printf '  **  putting %s back and restarting\n\n' "$(echo "$BEFORE" | cut -c1-8)" >&2
  sudo -u "$USER" git -C "$APP" reset --hard --quiet "$BEFORE"
  sudo -u "$USER" bash -c "cd $APP && npm ci --omit=dev" >/dev/null 2>&1 || true
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
say "5. Checking it actually works"

curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
  || rollback "The app is not answering on 127.0.0.1:$PORT after the restart."
ok "answering on 127.0.0.1:$PORT"

# The database is the check that matters. A wrong DB_PATH starts perfectly on an empty database and
# refuses every password — it has happened, and nothing else here would notice.
USERS=$(sudo -u "$USER" bash -c "cd $APP && node -e '
  const c = require(\"./src/config\");
  const { get } = require(\"./src/db\");
  if (require(\"path\").resolve(c.dbPath) !== require(\"path\").resolve(\"$DATA\")) { console.log(\"WRONGDB\"); process.exit(0); }
  console.log(get(\"SELECT COUNT(*) c FROM users\").c);
' 2>/dev/null" | tail -1)

[ "$USERS" != "WRONGDB" ] || rollback "The app resolved a different database than $DATA — check .env"
case "$USERS" in ''|*[!0-9]*) rollback "Could not read the accounts table.";; esac
[ "$USERS" -gt 0 ] || rollback "The database has NO user accounts — nobody would be able to sign in."
ok "$USERS accounts, in $DATA"

systemctl is-active --quiet nginx || die "The app is fine but nginx is not running: systemctl status nginx"
ok "nginx is up"

# ---------------------------------------------------------------------------
say "Updated: $(echo "$BEFORE" | cut -c1-8) -> $(echo "$AFTER" | cut -c1-8)"
cat <<NOTE

  Tell anyone already signed in to press Ctrl+Shift+R once. Assets are versioned per restart, so
  this is normally automatic — it is only needed for a browser holding an old service worker.

  If something looks wrong:
    sudo -u $USER bash -c 'cd $APP && node scripts/doctor.js'
    journalctl -u $SVC -n 50 --no-pager

  To undo this update:
    sudo -u $USER git -C $APP reset --hard $BEFORE && sudo systemctl restart $SVC

NOTE
