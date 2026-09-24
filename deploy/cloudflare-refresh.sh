#!/usr/bin/env bash
#
# Keep the server reachable ONLY through Cloudflare, and keep nginx's list of Cloudflare addresses
# current.
#
#   sudo bash /opt/workshopone/app/deploy/cloudflare-refresh.sh            # dry run — shows what it would do
#   sudo bash /opt/workshopone/app/deploy/cloudflare-refresh.sh --apply    # does it
#
# WHY. Cloudflare is the front door: TLS, the rate limit on sign-in, bot and attack filtering. But the
# server's own address (in DNS history, in scanners' lists) is a back door straight to nginx, and
# anyone who uses it skips all of that. With this applied, port 443 answers only Cloudflare's
# published ranges; everyone else is dropped by the firewall before nginx sees them.
#
# The same list is what nginx uses to decide whose "CF-Connecting-IP" header to believe (the login
# rate limiter depends on it), so both are refreshed from one download. Cloudflare adds ranges now
# and then — run monthly from cron (see deploy/VPS.md).
#
# Safe by construction, because this runs as root on the machine holding the company's records:
#   - dry run unless --apply;
#   - refuses if the download looks wrong (an empty list would lock Cloudflare out);
#   - refuses if ufw has no SSH rule (so it cannot lock YOU out);
#   - adds the new rules BEFORE removing the open ones, so traffic through Cloudflare never stops;
#   - tests the nginx config and puts the old file back if the test fails.

set -Eeuo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
TAG=cloudflare-origin
REALIP=/etc/nginx/cloudflare-real-ip.conf

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
die()  { printf '\n  **  %s\n\n' "$*" >&2; exit 1; }
# The dry-run line goes to stderr so it still shows when a caller silences the command's own output.
act()  { if [ "$APPLY" -eq 1 ]; then "$@"; else printf '  would run: %s\n' "$*" >&2; fi; }
DONE=$([ "$APPLY" -eq 1 ] && echo "done" || echo "planned")

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
for c in ufw curl nginx; do command -v "$c" >/dev/null || die "$c is not installed."; done
[ "$APPLY" -eq 1 ] || say "DRY RUN — nothing will change. Re-run with --apply to do it."

# ---------------------------------------------------------------------------
say "1. Cloudflare's address ranges"
V4=$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4 | tr -d '\r' | grep -E '^[0-9.]+/[0-9]{1,2}$' || true)
V6=$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6 | tr -d '\r' | grep -E '^[0-9a-fA-F:]+/[0-9]{1,3}$' || true)
N4=$(printf '%s\n' "$V4" | grep -c . || true)
N6=$(printf '%s\n' "$V6" | grep -c . || true)
# Cloudflare publishes about 15 IPv4 and 7 IPv6 ranges. Far fewer means a failed or garbled
# download, and applying it would shut Cloudflare itself out — so change nothing.
[ "$N4" -ge 10 ] && [ "$N6" -ge 5 ] || die "The downloaded list looks wrong (IPv4: $N4, IPv6: $N6). Changing nothing."
RANGES=$(printf '%s\n%s\n' "$V4" "$V6")
ok "$N4 IPv4 + $N6 IPv6 ranges"

# ---------------------------------------------------------------------------
say "2. Checking the firewall is on and SSH stays open"
STATUS=$(ufw status)
printf '%s\n' "$STATUS" | grep -q '^Status: active' || die "ufw is not active. Follow step 3 of deploy/VPS.md first."
printf '%s\n' "$STATUS" | grep -qE '^(OpenSSH|22(/tcp)?)[[:space:]]+(ALLOW|LIMIT)' \
  || die "ufw has no rule allowing SSH. Run 'sudo ufw allow OpenSSH' first — refusing so you are not locked out."
ok "active, SSH allowed"

# ---------------------------------------------------------------------------
say "3. Port 443 from Cloudflare only"
while read -r r; do
  [ -n "$r" ] || continue
  # ufw skips a rule that already exists, so re-running is harmless.
  act ufw allow proto tcp from "$r" to any port 443 comment "$TAG" >/dev/null
done <<< "$RANGES"
ok "Cloudflare ranges allowed on 443 ($DONE)"

# Tagged rules for ranges Cloudflare no longer lists. Deleted highest number first, because each
# deletion renumbers the rules after it. (`|| true`: finding none is the normal case, and under
# `set -e` a grep that matches nothing would otherwise stop the script here.)
STALE=$(ufw status numbered | grep -F "# $TAG" \
  | sed -E 's/^\[ *([0-9]+)\].*ALLOW IN[[:space:]]+([^[:space:]]+).*/\1 \2/' \
  | while read -r n src; do printf '%s\n' "$RANGES" | grep -qxF "$src" || echo "$n"; done | sort -rn || true)
for n in $STALE; do act ufw --force delete "$n" >/dev/null; done
[ -z "$STALE" ] && ok "no stale Cloudflare rules" || ok "$(echo "$STALE" | wc -w) stale rule(s) removed ($DONE)"

# The open-to-everyone rules. Port 80 stays open: it only ever answers with a redirect to https.
for rule in 'Nginx Full' 'Nginx HTTPS' '443/tcp' '443'; do
  if ufw status | grep -qE "^${rule}( \(v6\))?[[:space:]]+ALLOW[[:space:]]+Anywhere"; then
    act ufw --force delete allow "$rule" >/dev/null
    ok "open rule '$rule' removed ($DONE)"
  fi
done
if ! ufw status | grep -qE '^(Nginx HTTP|80(/tcp)?)[[:space:]]+ALLOW'; then
  act ufw allow 'Nginx HTTP' >/dev/null
  ok "port 80 kept open for the https redirect ($DONE)"
fi

# ---------------------------------------------------------------------------
say "4. nginx real-IP list ($REALIP)"
NEW=$( { echo "# Generated by deploy/cloudflare-refresh.sh — do not edit by hand."
         while read -r r; do [ -n "$r" ] && echo "set_real_ip_from $r;"; done <<< "$RANGES"
         echo "real_ip_header CF-Connecting-IP;"; } )
if [ -f "$REALIP" ] && diff -q <(grep -v '^#' "$REALIP") <(printf '%s\n' "$NEW" | grep -v '^#') >/dev/null; then
  ok "already current"
elif [ "$APPLY" -eq 1 ]; then
  [ -f "$REALIP" ] && cp "$REALIP" "$REALIP.bak"
  printf '%s\n' "$NEW" > "$REALIP"
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    ok "updated and nginx reloaded"
  else
    [ -f "$REALIP.bak" ] && mv "$REALIP.bak" "$REALIP"
    die "nginx rejected the new list — the old file has been put back. Run 'sudo nginx -t' to see why."
  fi
else
  printf '  would write %s (%s lines) and reload nginx\n' "$REALIP" "$(printf '%s\n' "$NEW" | grep -c set_real_ip_from)"
fi

# ---------------------------------------------------------------------------
say "Done"
if [ "$APPLY" -eq 1 ]; then
  ok "$(ufw status | grep -cF "# $TAG") Cloudflare rules in the firewall"
  echo "  Check from OUTSIDE the server (your own PC): the site must still open at"
  echo "  https://storesdb.ec-workshops.online, and https://<server-ip> must now time out."
fi
