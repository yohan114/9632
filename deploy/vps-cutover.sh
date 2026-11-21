#!/usr/bin/env bash
# =============================================================================
# WorkshopOne Unified VPS Cutover & Rehearsal Helper
# Target Unified Domain: erp.edchristerp.com
# Legacy Redirects:      storesdb.ec-workshops.online & fuelsystem.ec-workshops.online
#
# Subcommands:
#   preflight   Read-only inspection of live WorkshopOne, Fuel-System-V2, DNS, TLS, and Nginx
#   setup-ssl   Zero-downtime Hostinger DNS check + Let's Encrypt certificate via certbot webroot
#   rehearsal   Zero-downtime Phase A online snapshot merge + parity check in /tmp
#   cutover     Guarded Phase B-C production cutover with mandatory --verify-only gate
#   rollback    60-second Phase D emergency rollback to original WorkshopOne + Fuel-System-V2
# =============================================================================
set -Eeuo pipefail

UNIFIED_ROOT="${UNIFIED_ROOT:-/opt/workshopone-unified}"
UNIFIED_APP="${UNIFIED_APP:-$UNIFIED_ROOT/app}"
UNIFIED_PORT="${UNIFIED_PORT:-3400}"
UNIFIED_DB="${UNIFIED_DB:-$UNIFIED_ROOT/data/workshopone_merged.db}"
UNIFIED_UPLOADS="${UNIFIED_UPLOADS:-$UNIFIED_ROOT/uploads}"
UNIFIED_BACKUPS="${UNIFIED_BACKUPS:-$UNIFIED_ROOT/backups}"
UNIFIED_OUTSOURCING="${UNIFIED_OUTSOURCING:-$UNIFIED_APP/data/outsourcing}"
UNIFIED_SERVICE="${UNIFIED_SERVICE:-workshopone-unified}"
SERVICE_USER="${SERVICE_USER:-workshopone}"
SERVICE_GROUP="${SERVICE_GROUP:-workshopone}"

OLD_WO_ROOT="${OLD_WO_ROOT:-/opt/workshopone}"
OLD_WO_APP="${OLD_WO_APP:-$OLD_WO_ROOT/app}"
OLD_WO_SERVICE="${OLD_WO_SERVICE:-workshopone}"

OLD_FUEL_ROOT="${OLD_FUEL_ROOT:-/var/www/fuelsystem}"
OLD_FUEL_DB="${OLD_FUEL_DB:-}"
OLD_FUEL_USER="${OLD_FUEL_USER:-fuelapp}"
OLD_FUEL_PM2_HOME="${OLD_FUEL_PM2_HOME:-/home/fuelapp/.pm2}"
OLD_FUEL_NPX="${OLD_FUEL_NPX:-/opt/node-24/bin/npx}"
OLD_FUEL_PM2_SERVICE="${OLD_FUEL_PM2_SERVICE:-pm2-fuelapp}"
PM2_BIN="${PM2_BIN:-}"
ACME_WEBROOT="${ACME_WEBROOT:-}"

NGINX_STORESDB="${NGINX_STORESDB:-/etc/nginx/sites-available/storesdb}"
NGINX_STORESDB_ENABLED="${NGINX_STORESDB_ENABLED:-/etc/nginx/sites-enabled/storesdb}"
NGINX_FUELSYSTEM="${NGINX_FUELSYSTEM:-/etc/nginx/sites-available/fuelsystem}"
NGINX_FUELSYSTEM_ENABLED="${NGINX_FUELSYSTEM_ENABLED:-/etc/nginx/sites-enabled/fuelsystem}"
NGINX_ERP="${NGINX_ERP:-/etc/nginx/sites-available/erp}"
NGINX_ERP_ENABLED="${NGINX_ERP_ENABLED:-/etc/nginx/sites-enabled/erp}"

UNIFIED_DOMAIN="${UNIFIED_DOMAIN:-erp.edchristerp.com}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://${UNIFIED_DOMAIN}}"
FUEL_REDIRECT_URL="${FUEL_REDIRECT_URL:-https://${UNIFIED_DOMAIN}/#/fuel}"
ERP_SSL_CERT="${ERP_SSL_CERT:-}"
ERP_SSL_KEY="${ERP_SSL_KEY:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

AUTO_YES=0
SKIP_BROADCAST=0
BROADCAST_SECONDS=120
FORCE_ENV=0
KEEP_TMP=0
ALLOW_HTTP=0
SKIP_DNS_CHECK=0

TMP_DIR=""
CUTOVER_BAK=""
DETECTED_ERP_CERT=""
DETECTED_ERP_KEY=""
FUEL_PM2_MODE="none"
OLD_MFA_KEY=""

log()  { printf '[cutover] %s\n' "$*"; }
warn() { printf '[cutover][WARN] %s\n' "$*" >&2; }
die()  { printf '[cutover][ERROR] %s\n' "$*" >&2; exit 1; }

cleanup_tmp() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && [ "$KEEP_TMP" -eq 0 ]; then
    rm -rf "$TMP_DIR" || true
  fi
}
trap cleanup_tmp EXIT

usage() {
  cat <<'EOF'
Usage:
  sudo bash deploy/vps-cutover.sh <preflight|setup-ssl|rehearsal|cutover|rollback> [options]

Subcommands:
  preflight   Read-only audit of live services, DB mode (single vs split), Fuel V2 DB, DNS, TLS, and Nginx.
  setup-ssl   Zero-downtime Hostinger DNS verification & Let's Encrypt HTTPS certificate setup via certbot.
  rehearsal   Phase A (zero downtime): online sqlite3 .backup snapshots -> /tmp merge -> --verify-only.
  cutover     Phases B-C (off-peak): broadcast -> stop old apps -> cold backup -> merge -> verify gate -> switch Nginx.
  rollback    Phase D (emergency): stop unified service, restore previous Nginx configs, restart old apps.

Options:
  --yes              Skip interactive CUTOVER / ROLLBACK confirmation prompts
  --skip-broadcast   Skip broadcasting 2-minute maintenance warning before stopping old apps
  --wait <seconds>   Maintenance broadcast countdown before stopping services (default: 120)
  --force-env        Overwrite /opt/workshopone-unified/app/.env cleanly from template
  --email <addr>     Email address passed to certbot for Let's Encrypt renewal notices (setup-ssl)
  --skip-dns-check   Skip verifying erp.edchristerp.com DNS IP matches this VPS (setup-ssl)
  --allow-http       Allow cutover over plain HTTP (:80) if erp.edchristerp.com TLS certs are not yet installed
  --keep-tmp         Keep /tmp rehearsal directory after rehearsal completes (for inspection)
  -h, --help         Show this help
EOF
}

require_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    die "This command must run as root (use: sudo bash $0 ...)"
  fi
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "Required command '$cmd' not found on PATH."
}

# Safe .env value reader matching src/config.js (last occurrence wins, strips quotes & unquoted # comments)
read_env_val() {
  local file="$1"
  local target_key="$2"
  [ -r "$file" ] || return 0
  awk -v k="$target_key" '
    BEGIN { found = "" }
    /^[[:space:]]*$/ || /^[[:space:]]*#/ { next }
    {
      idx = index($0, "=")
      if (idx == 0) next
      key = substr($0, 1, idx - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key != k) next
      val = substr($0, idx + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
      first = substr(val, 1, 1)
      last  = substr(val, length(val), 1)
      if ((first == "\"" && last == "\"") || (first == "\x27" && last == "\x27")) {
        val = substr(val, 2, length(val) - 2)
      } else {
        sub(/[[:space:]]+#.*/, "", val)
        gsub(/[[:space:]]+$/, "", val)
      }
      found = val
    }
    END { printf "%s", found }
  ' "$file"
}

resolve_rel_path() {
  local base_dir="$1"
  local raw_path="$2"
  if [[ "$raw_path" == /* ]]; then
    printf '%s' "$raw_path"
  else
    printf '%s' "$base_dir/$raw_path"
  fi
}

# Detect TLS cert & key for UNIFIED_DOMAIN (populated into DETECTED_ERP_CERT & DETECTED_ERP_KEY)
detect_erp_tls() {
  DETECTED_ERP_CERT=""
  DETECTED_ERP_KEY=""

  if [ -n "$ERP_SSL_CERT" ] && [ -n "$ERP_SSL_KEY" ] && [ -f "$ERP_SSL_CERT" ] && [ -f "$ERP_SSL_KEY" ]; then
    DETECTED_ERP_CERT="$ERP_SSL_CERT"
    DETECTED_ERP_KEY="$ERP_SSL_KEY"
    return 0
  fi

  local -a candidates=(
    "/etc/letsencrypt/live/${UNIFIED_DOMAIN}/fullchain.pem:/etc/letsencrypt/live/${UNIFIED_DOMAIN}/privkey.pem"
    "/etc/ssl/cloudflare/${UNIFIED_DOMAIN}.pem:/etc/ssl/cloudflare/${UNIFIED_DOMAIN}.key"
    "/etc/ssl/cloudflare/erp.pem:/etc/ssl/cloudflare/erp.key"
  )
  local pair c k
  for pair in "${candidates[@]}"; do
    c="${pair%%:*}"
    k="${pair##*:}"
    if [ -f "$c" ] && [ -f "$k" ]; then
      DETECTED_ERP_CERT="$c"
      DETECTED_ERP_KEY="$k"
      return 0
    fi
  done
  return 0
}

# Detect ACME HTTP-01 webroot (/var/www/certbot if present, else /var/www/html)
detect_acme_webroot() {
  if [ -n "${ACME_WEBROOT:-}" ]; then
    return 0
  fi
  if [ -d /var/www/certbot ]; then
    ACME_WEBROOT="/var/www/certbot"
  else
    ACME_WEBROOT="/var/www/html"
  fi
}

# Safe PM2 mode detection: isolated fuelapp PM2 vs root PM2 (which may host sibling apps like hydraulic-system)
detect_fuel_pm2() {
  FUEL_PM2_MODE="none"
  if [ -z "$PM2_BIN" ]; then
    if command -v pm2 >/dev/null 2>&1; then
      PM2_BIN="$(command -v pm2)"
    elif [ -x /usr/bin/pm2 ]; then
      PM2_BIN="/usr/bin/pm2"
    elif [ -x /usr/local/bin/pm2 ]; then
      PM2_BIN="/usr/local/bin/pm2"
    fi
  fi

  if id -u "$OLD_FUEL_USER" >/dev/null 2>&1 && [ -d "$OLD_FUEL_PM2_HOME" ]; then
    FUEL_PM2_MODE="fuelapp"
  elif [ -n "$PM2_BIN" ] && [ -x "$PM2_BIN" ]; then
    FUEL_PM2_MODE="root"
  fi
}

# Populates globals:
#   WO_DB_MODE ("single"|"split"), WO_SINGLE_DB, WO_CORE_DB, WO_CW_DB, WO_MTR_DB,
#   OLD_WO_PORT, OLD_WO_UPLOADS, OLD_WO_OUTSOURCING, OLD_FUEL_DB, OLD_MFA_KEY,
#   ACME_WEBROOT, FUEL_PM2_MODE
detect_live_sources() {
  detect_acme_webroot
  detect_fuel_pm2

  local env_file="$OLD_WO_APP/.env"
  local env_db=""
  local env_multi=""
  local env_up=""
  local env_port=""

  if [ -r "$env_file" ]; then
    env_port="$(read_env_val "$env_file" "PORT")"
    env_db="$(read_env_val "$env_file" "DB_PATH")"
    env_multi="$(read_env_val "$env_file" "MULTIDB")"
    env_up="$(read_env_val "$env_file" "UPLOAD_DIR")"
  fi

  OLD_WO_PORT="${env_port:-3000}"

  local single_candidate="$OLD_WO_ROOT/data/workshopone.db"
  if [ -n "$env_db" ]; then
    single_candidate="$(resolve_rel_path "$OLD_WO_APP" "$env_db")"
  fi

  local data_dir
  data_dir="$(dirname "$single_candidate")"
  if [ ! -d "$data_dir" ] && [ -d "$OLD_WO_ROOT/data" ]; then
    data_dir="$OLD_WO_ROOT/data"
  fi

  local core_candidate="$data_dir/core.db"
  local cw_candidate="$data_dir/workshops/CW.db"
  local mtr_candidate="$data_dir/workshops/MTR.db"

  if [ "$env_multi" = "1" ] || { [ ! -f "$single_candidate" ] && [ -f "$core_candidate" ] && [ -f "$cw_candidate" ]; }; then
    WO_DB_MODE="split"
    WO_SINGLE_DB=""
    WO_CORE_DB="$core_candidate"
    WO_CW_DB="$cw_candidate"
    if [ -f "$mtr_candidate" ]; then
      WO_MTR_DB="$mtr_candidate"
    else
      WO_MTR_DB=""
    fi
  else
    WO_DB_MODE="single"
    WO_SINGLE_DB="$single_candidate"
    WO_CORE_DB=""
    WO_CW_DB=""
    WO_MTR_DB=""
  fi

  if [ -n "$env_up" ]; then
    OLD_WO_UPLOADS="$(resolve_rel_path "$OLD_WO_APP" "$env_up")"
  elif [ -d "$OLD_WO_APP/uploads" ]; then
    OLD_WO_UPLOADS="$OLD_WO_APP/uploads"
  elif [ -d "$OLD_WO_ROOT/uploads" ]; then
    OLD_WO_UPLOADS="$OLD_WO_ROOT/uploads"
  else
    OLD_WO_UPLOADS=""
  fi

  if [ -d "$OLD_WO_APP/data/outsourcing" ]; then
    OLD_WO_OUTSOURCING="$OLD_WO_APP/data/outsourcing"
  elif [ -d "$OLD_WO_ROOT/data/outsourcing" ]; then
    OLD_WO_OUTSOURCING="$OLD_WO_ROOT/data/outsourcing"
  else
    OLD_WO_OUTSOURCING=""
  fi

  # Detect WorkshopOne mfa.key alongside live DB
  if [ "$WO_DB_MODE" = "single" ] && [ -f "$(dirname "$WO_SINGLE_DB")/mfa.key" ]; then
    OLD_MFA_KEY="$(dirname "$WO_SINGLE_DB")/mfa.key"
  elif [ -f "$OLD_WO_ROOT/data/mfa.key" ]; then
    OLD_MFA_KEY="$OLD_WO_ROOT/data/mfa.key"
  else
    OLD_MFA_KEY=""
  fi

  # Auto-detect Fuel-System-V2 SQLite DB from .env DATABASE_URL or known paths
  if [ -z "$OLD_FUEL_DB" ] && [ -r "$OLD_FUEL_ROOT/.env" ]; then
    local raw_db_url
    raw_db_url="$(read_env_val "$OLD_FUEL_ROOT/.env" "DATABASE_URL")"
    if [ -n "$raw_db_url" ]; then
      raw_db_url="${raw_db_url#file:}"
      raw_db_url="${raw_db_url%%\?*}"
      if [[ "$raw_db_url" == /* ]]; then
        OLD_FUEL_DB="$raw_db_url"
      elif [ -f "$OLD_FUEL_ROOT/prisma/$raw_db_url" ]; then
        OLD_FUEL_DB="$OLD_FUEL_ROOT/prisma/$raw_db_url"
      else
        OLD_FUEL_DB="$(resolve_rel_path "$OLD_FUEL_ROOT" "$raw_db_url")"
      fi
    fi
  fi
  if [ -z "$OLD_FUEL_DB" ] || [ ! -f "$OLD_FUEL_DB" ]; then
    if [ -f /var/lib/fuel-system/app.db ]; then
      OLD_FUEL_DB="/var/lib/fuel-system/app.db"
    elif [ -f "$OLD_FUEL_ROOT/data/app.db" ]; then
      OLD_FUEL_DB="$OLD_FUEL_ROOT/data/app.db"
    elif [ -z "$OLD_FUEL_DB" ]; then
      OLD_FUEL_DB="/var/lib/fuel-system/app.db"
    fi
  fi
}

ensure_unified_dirs_and_env() {
  id -u "$SERVICE_USER" >/dev/null 2>&1 || die "Service user '$SERVICE_USER' does not exist."
  [ -d "$UNIFIED_APP" ] || die "Unified app directory missing: $UNIFIED_APP"
  [ -x "$NODE_BIN" ] || die "Node binary missing or not executable: $NODE_BIN"

  mkdir -p "$UNIFIED_ROOT/data" "$UNIFIED_BACKUPS" "$UNIFIED_UPLOADS" "$UNIFIED_OUTSOURCING"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$UNIFIED_ROOT"

  if [ ! -f "$UNIFIED_APP/.env" ] || [ "$FORCE_ENV" -eq 1 ]; then
    log "Writing clean $UNIFIED_APP/.env (PORT=$UNIFIED_PORT, PUBLIC_ORIGIN=$PUBLIC_ORIGIN, DB_PATH=$UNIFIED_DB)"
    sudo -u "$SERVICE_USER" tee "$UNIFIED_APP/.env" >/dev/null <<EOF
PORT=$UNIFIED_PORT
HOST=127.0.0.1
NODE_ENV=production
PUBLIC_ORIGIN=$PUBLIC_ORIGIN
MULTIDB=0
DB_PATH=$UNIFIED_DB
UPLOAD_DIR=$UNIFIED_UPLOADS
BACKUP_DIR=$UNIFIED_BACKUPS
BACKUP_INTERVAL_MINUTES=30
BACKUP_RETENTION=96
EOF
  else
    local cur_origin
    cur_origin="$(read_env_val "$UNIFIED_APP/.env" "PUBLIC_ORIGIN")"
    if [ "$cur_origin" != "$PUBLIC_ORIGIN" ]; then
      warn "Existing $UNIFIED_APP/.env has PUBLIC_ORIGIN='${cur_origin}' instead of '$PUBLIC_ORIGIN'. Re-run with --force-env to update it cleanly."
    fi
  fi

  local resolved
  resolved="$(sudo -u "$SERVICE_USER" "$NODE_BIN" -e 'const c=require("'"$UNIFIED_APP"'/src/config"); console.log(c.host + "|" + c.port + "|" + c.dbPath + "|" + (process.env.PUBLIC_ORIGIN || "") + "|" + c.uploadDir + "|" + c.backupDir);')"
  local r_host r_port r_db r_origin
  IFS='|' read -r r_host r_port r_db r_origin _ _ <<< "$resolved"
  if [ "$r_host" != "127.0.0.1" ] || [ "$r_port" != "$UNIFIED_PORT" ] || [ "$r_db" != "$UNIFIED_DB" ]; then
    die "Resolved .env mismatch ($resolved). Expected host=127.0.0.1, port=$UNIFIED_PORT, dbPath=$UNIFIED_DB. Re-run with --force-env."
  fi
  if [ "$r_origin" != "$PUBLIC_ORIGIN" ]; then
    warn "Resolved PUBLIC_ORIGIN='$r_origin' differs from '$PUBLIC_ORIGIN'. Run with --force-env to update."
  fi
  log "Verified unified .env resolution: $resolved"
}

check_unified_dependencies() {
  [ -d "$UNIFIED_APP/node_modules/better-sqlite3" ] || die "Unified dependencies not installed. Run: sudo -u $SERVICE_USER env PATH=/usr/bin:/bin bash -c 'cd $UNIFIED_APP && /usr/bin/npm ci --omit=dev'"
  sudo -u "$SERVICE_USER" "$NODE_BIN" -e 'require("'"$UNIFIED_APP"'/node_modules/better-sqlite3");' >/dev/null 2>&1 \
    || die "better-sqlite3 failed to load under $NODE_BIN (ABI mismatch). Re-run: sudo -u $SERVICE_USER env PATH=/usr/bin:/bin bash -c 'cd $UNIFIED_APP && /usr/bin/npm ci --omit=dev'"
}

human_size() {
  local f="$1"
  if [ -f "$f" ]; then
    du -h "$f" 2>/dev/null | cut -f1
  else
    printf 'MISSING'
  fi
}

cmd_preflight() {
  detect_live_sources
  detect_erp_tls
  log "=== WorkshopOne Unified VPS Preflight Report ==="
  log "Unified domain:         $UNIFIED_DOMAIN ($PUBLIC_ORIGIN)"
  log "DNS check ($UNIFIED_DOMAIN): $(getent ahosts "$UNIFIED_DOMAIN" 2>/dev/null | head -n 1 || echo 'UNRESOLVED')"
  if [ -n "$DETECTED_ERP_CERT" ]; then
    log "ERP TLS cert:           $DETECTED_ERP_CERT (key: $DETECTED_ERP_KEY)"
  else
    log "ERP TLS cert:           MISSING (run 'sudo bash $0 setup-ssl' after updating Hostinger DNS, or save Cloudflare cert)"
  fi
  log "Unified target dir:     $UNIFIED_APP (node_modules present: $([ -d "$UNIFIED_APP/node_modules" ] && echo yes || echo NO))"
  log "Unified Node binary:    $NODE_BIN ($($NODE_BIN -v 2>/dev/null || echo 'missing'))"
  log "WorkshopOne DB mode:    $WO_DB_MODE (live port=$OLD_WO_PORT)"
  if [ "$WO_DB_MODE" = "single" ]; then
    log "  WO single DB:         $WO_SINGLE_DB ($(human_size "$WO_SINGLE_DB"))"
  else
    log "  WO core DB:           $WO_CORE_DB ($(human_size "$WO_CORE_DB"))"
    log "  WO CW DB:             $WO_CW_DB ($(human_size "$WO_CW_DB"))"
    [ -n "$WO_MTR_DB" ] && log "  WO MTR DB:            $WO_MTR_DB ($(human_size "$WO_MTR_DB"))"
  fi
  log "  WO uploads dir:       ${OLD_WO_UPLOADS:-<none>}"
  log "  WO outsourcing dir:   ${OLD_WO_OUTSOURCING:-<none>}"
  log "  WO MFA key:           ${OLD_MFA_KEY:-<none>}"
  log "Fuel-System-V2 DB:      $OLD_FUEL_DB ($(human_size "$OLD_FUEL_DB"))"
  log "Fuel PM2 mode:          $FUEL_PM2_MODE"
  log "ACME webroot:           $ACME_WEBROOT"
  log "Systemd status:"
  systemctl is-active "$OLD_WO_SERVICE" >/dev/null 2>&1 && log "  $OLD_WO_SERVICE: active" || log "  $OLD_WO_SERVICE: inactive"
  systemctl is-active "$OLD_FUEL_PM2_SERVICE" >/dev/null 2>&1 && log "  $OLD_FUEL_PM2_SERVICE: active" || log "  $OLD_FUEL_PM2_SERVICE: inactive"
  systemctl is-active pm2-root.service >/dev/null 2>&1 && log "  pm2-root.service: active (kept running for sibling PM2 apps)" || log "  pm2-root.service: inactive"
  systemctl is-active "$UNIFIED_SERVICE" >/dev/null 2>&1 && log "  $UNIFIED_SERVICE: active" || log "  $UNIFIED_SERVICE: inactive"
  if [ "$FUEL_PM2_MODE" = "fuelapp" ]; then
    log "Fuel PM2 status (PM2_HOME=$OLD_FUEL_PM2_HOME):"
    sudo -u "$OLD_FUEL_USER" PM2_HOME="$OLD_FUEL_PM2_HOME" "$OLD_FUEL_NPX" pm2 status 2>/dev/null || warn "Could not query PM2 under $OLD_FUEL_USER"
  elif [ "$FUEL_PM2_MODE" = "root" ]; then
    log "Root PM2 process status:"
    "$PM2_BIN" status 2>/dev/null || warn "Could not query root PM2"
  fi
  log "Nginx site files:"
  log "  erp:        $NGINX_ERP ($([ -f "$NGINX_ERP" ] && echo present || echo MISSING))"
  log "  storesdb:   $NGINX_STORESDB ($([ -f "$NGINX_STORESDB" ] && echo present || echo MISSING))"
  log "  fuelsystem: $NGINX_FUELSYSTEM ($([ -f "$NGINX_FUELSYSTEM" ] && echo present || echo MISSING))"
  log "Tools: sqlite3=$(command -v sqlite3 || echo MISSING), nginx=$(command -v nginx || echo MISSING)"
  df -h /opt /var/www "$UNIFIED_ROOT" 2>/dev/null || df -h /opt
}

backup_sqlite_safe() {
  local src="$1"
  local dst="$2"
  [ -f "$src" ] || die "Source SQLite DB not found: $src"
  rm -f "$dst" "${dst}-wal" "${dst}-shm"
  sqlite3 "$src" ".timeout 10000" ".backup $dst"
  [ -f "$dst" ] || die "Failed to snapshot SQLite DB: $src -> $dst"
}

cmd_rehearsal() {
  require_root
  require_cmd sqlite3
  require_cmd "$NODE_BIN"
  detect_live_sources
  ensure_unified_dirs_and_env
  check_unified_dependencies

  [ -f "$OLD_FUEL_DB" ] || die "Fuel V2 DB not found: $OLD_FUEL_DB"

  TMP_DIR="$(mktemp -d /tmp/wo-rehearsal-XXXXXX)"
  chmod 755 "$TMP_DIR"
  log "Created isolated zero-downtime rehearsal workspace: $TMP_DIR"

  local r_fuel="$TMP_DIR/rehearsal_fuel.db"
  local r_merged="$TMP_DIR/rehearsal_merged.db"
  local -a src_args=()

  log "Taking safe online SQLite .backup snapshot of Fuel-System-V2..."
  backup_sqlite_safe "$OLD_FUEL_DB" "$r_fuel"

  if [ "$WO_DB_MODE" = "single" ]; then
    local r_wo="$TMP_DIR/rehearsal_wo.db"
    log "Taking safe online SQLite .backup snapshot of WorkshopOne ($WO_SINGLE_DB)..."
    backup_sqlite_safe "$WO_SINGLE_DB" "$r_wo"
    src_args+=(--wo-db "$r_wo")
  else
    local r_core="$TMP_DIR/rehearsal_core.db"
    local r_cw="$TMP_DIR/rehearsal_cw.db"
    log "Taking safe online SQLite .backup snapshots of split WorkshopOne DBs..."
    backup_sqlite_safe "$WO_CORE_DB" "$r_core"
    backup_sqlite_safe "$WO_CW_DB" "$r_cw"
    src_args+=(--core-db "$r_core" --cw-db "$r_cw")
    if [ -n "$WO_MTR_DB" ]; then
      local r_mtr="$TMP_DIR/rehearsal_mtr.db"
      backup_sqlite_safe "$WO_MTR_DB" "$r_mtr"
      src_args+=(--mtr-db "$r_mtr")
    fi
  fi
  src_args+=(--fuel-db "$r_fuel")

  log "Running rehearsal --build-fresh merge in $TMP_DIR..."
  "$NODE_BIN" "$UNIFIED_APP/scripts/vps_cutover_merge.js" \
    --build-fresh \
    "${src_args[@]}" \
    --target-db "$r_merged"

  log "Running mandatory --verify-only parity check on rehearsal DB..."
  "$NODE_BIN" "$UNIFIED_APP/scripts/vps_cutover_merge.js" \
    --verify-only \
    "${src_args[@]}" \
    --target-db "$r_merged"

  log "REHEARSAL PASSED: readyForCutover=true with zero impact on live services."
}

confirm_phrase() {
  local phrase="$1"
  local label="$2"
  if [ "$AUTO_YES" -eq 1 ]; then
    return 0
  fi
  printf '\n[cutover] About to run: %s\n' "$label"
  printf '[cutover] Type %s to continue: ' "$phrase"
  local reply=""
  read -r reply
  [ "$reply" = "$phrase" ] || die "Confirmation aborted."
}

stop_old_services() {
  detect_fuel_pm2

  if systemctl is-active "$OLD_WO_SERVICE" >/dev/null 2>&1; then
    log "Stopping $OLD_WO_SERVICE (clean WAL checkpoint)..."
    systemctl stop "$OLD_WO_SERVICE"
  else
    log "$OLD_WO_SERVICE is already stopped."
  fi

  if [ "$FUEL_PM2_MODE" = "fuelapp" ]; then
    log "Stopping Fuel-System-V2 via PM2 (user=$OLD_FUEL_USER, PM2_HOME=$OLD_FUEL_PM2_HOME)..."
    sudo -u "$OLD_FUEL_USER" PM2_HOME="$OLD_FUEL_PM2_HOME" "$OLD_FUEL_NPX" pm2 stop fuelsystem || warn "PM2 stop returned non-zero (process may already be stopped)"
    if systemctl is-active "$OLD_FUEL_PM2_SERVICE" >/dev/null 2>&1; then
      log "Stopping systemd unit $OLD_FUEL_PM2_SERVICE..."
      systemctl stop "$OLD_FUEL_PM2_SERVICE"
    fi
  elif [ "$FUEL_PM2_MODE" = "root" ]; then
    log "Stopping ONLY PM2 app 'fuelsystem' under root PM2 (leaving pm2-root.service running for sibling apps like hydraulic-system)..."
    "$PM2_BIN" stop fuelsystem || warn "PM2 stop fuelsystem returned non-zero (process may already be stopped)"
    "$PM2_BIN" save || warn "PM2 save returned non-zero"
  else
    warn "No PM2 installation detected; assuming Fuel-System-V2 is stopped externally."
  fi
}

write_erp_unified_nginx() {
  detect_acme_webroot
  local tmp_out
  tmp_out="$(mktemp)"
  local realip_line=""
  if [[ "$DETECTED_ERP_CERT" == /etc/ssl/cloudflare/* ]] && [ -f /etc/nginx/cloudflare-real-ip.conf ]; then
    realip_line="    include /etc/nginx/cloudflare-real-ip.conf;"
  fi

  if [ -n "$DETECTED_ERP_CERT" ] && [ -n "$DETECTED_ERP_KEY" ]; then
    log "Writing HTTPS + HTTP Nginx config for $UNIFIED_DOMAIN -> 127.0.0.1:$UNIFIED_PORT ($DETECTED_ERP_CERT)"
    cat >"$tmp_out" <<EOF
# $UNIFIED_DOMAIN -> WorkshopOne Unified (127.0.0.1:$UNIFIED_PORT)
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $UNIFIED_DOMAIN;

$realip_line
    ssl_certificate     $DETECTED_ERP_CERT;
    ssl_certificate_key $DETECTED_ERP_KEY;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:$UNIFIED_PORT;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;

        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    client_max_body_size 25m;
}

server {
    listen 80;
    listen [::]:80;
    server_name $UNIFIED_DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type "text/plain";
    }

    location / {
        return 301 https://$UNIFIED_DOMAIN\$request_uri;
    }
}
EOF
  else
    warn "No origin TLS cert found for $UNIFIED_DOMAIN (--allow-http active): configuring HTTP-only proxy on :80"
    cat >"$tmp_out" <<EOF
# $UNIFIED_DOMAIN -> WorkshopOne Unified (127.0.0.1:$UNIFIED_PORT, HTTP bootstrap mode)
server {
    listen 80;
    listen [::]:80;
    server_name $UNIFIED_DOMAIN;

$realip_line
    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type "text/plain";
    }

    location / {
        proxy_pass http://127.0.0.1:$UNIFIED_PORT;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    client_max_body_size 25m;
}
EOF
  fi

  install -m 644 "$tmp_out" "$NGINX_ERP"
  rm -f "$tmp_out"
  ln -sf "$NGINX_ERP" "$NGINX_ERP_ENABLED"
}

write_storesdb_redirect_nginx() {
  detect_acme_webroot
  local src_conf="$NGINX_STORESDB"
  local tmp_out
  tmp_out="$(mktemp)"

  if [ -f "$src_conf" ]; then
    local top_realip=""
    if grep -Eq '^[[:space:]]*include[[:space:]]+/etc/nginx/cloudflare-real-ip\.conf;' "$src_conf"; then
      top_realip="include /etc/nginx/cloudflare-real-ip.conf;"
    fi
    local ssl_cert ssl_key
    ssl_cert="$(awk '/^[[:space:]]*ssl_certificate[[:space:]]+/{sub(/;/,"",$2); print $2; exit}' "$src_conf" || true)"
    ssl_key="$(awk '/^[[:space:]]*ssl_certificate_key[[:space:]]+/{sub(/;/,"",$2); print $2; exit}' "$src_conf" || true)"

    local ssl_def="" ssl6_def="" http_def="" http6_def=""
    grep -Eq 'listen[[:space:]]+443[^;]*default_server' "$src_conf" && ssl_def=" default_server"
    grep -Eq 'listen[[:space:]]+\[::\]:443[^;]*default_server' "$src_conf" && ssl6_def=" default_server"
    grep -Eq 'listen[[:space:]]+80[^;]*default_server' "$src_conf" && http_def=" default_server"
    grep -Eq 'listen[[:space:]]+\[::\]:80[^;]*default_server' "$src_conf" && http6_def=" default_server"

    {
      echo "# storesdb.ec-workshops.online -> redirect to Unified ERP (https://$UNIFIED_DOMAIN)"
      [ -n "$top_realip" ] && echo "$top_realip"
      if [ -n "$ssl_cert" ] && [ -n "$ssl_key" ] && [ -f "$ssl_cert" ] && [ -f "$ssl_key" ]; then
        cat <<EOF

server {
    listen 443 ssl http2${ssl_def};
    listen [::]:443 ssl http2${ssl6_def};
    server_name storesdb.ec-workshops.online;

    ssl_certificate     $ssl_cert;
    ssl_certificate_key $ssl_key;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        return 302 https://${UNIFIED_DOMAIN}\$request_uri;
    }
}
EOF
      fi
      cat <<EOF

server {
    listen 80${http_def};
    listen [::]:80${http6_def};
    server_name storesdb.ec-workshops.online 167.71.206.10 _;

    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type "text/plain";
    }

    location / {
        return 302 https://${UNIFIED_DOMAIN}\$request_uri;
    }
}
EOF
    } >"$tmp_out"
    install -m 644 "$tmp_out" "$NGINX_STORESDB"
    rm -f "$tmp_out"
    ln -sf "$NGINX_STORESDB" "$NGINX_STORESDB_ENABLED"
    return 0
  fi

  rm -f "$tmp_out"
  cp "$UNIFIED_APP/deploy/nginx-storesdb-redirect.conf" "$NGINX_STORESDB"
  chmod 644 "$NGINX_STORESDB"
  ln -sf "$NGINX_STORESDB" "$NGINX_STORESDB_ENABLED"
}

write_fuelsystem_redirect_nginx() {
  detect_acme_webroot
  local src_conf="$NGINX_FUELSYSTEM"
  local tmp_out
  tmp_out="$(mktemp)"

  if [ -f "$src_conf" ]; then
    local ssl_cert ssl_key
    ssl_cert="$(awk '/^[[:space:]]*ssl_certificate[[:space:]]+/{sub(/;/,"",$2); print $2; exit}' "$src_conf" || true)"
    ssl_key="$(awk '/^[[:space:]]*ssl_certificate_key[[:space:]]+/{sub(/;/,"",$2); print $2; exit}' "$src_conf" || true)"

    if [ -n "$ssl_cert" ] && [ -n "$ssl_key" ] && [ -f "$ssl_cert" ] && [ -f "$ssl_key" ]; then
      log "Preserving active origin TLS certs in $NGINX_FUELSYSTEM redirect ($ssl_cert)"
      cat >"$tmp_out" <<EOF
# fuelsystem.ec-workshops.online -> Unified Fuel Operations redirect (HTTP + HTTPS)
server {
    listen 80;
    listen [::]:80;
    server_name fuelsystem.ec-workshops.online;

    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type "text/plain";
    }

    location / {
        return 302 $FUEL_REDIRECT_URL;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name fuelsystem.ec-workshops.online;

    ssl_certificate     $ssl_cert;
    ssl_certificate_key $ssl_key;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        return 302 $FUEL_REDIRECT_URL;
    }
}
EOF
      install -m 644 "$tmp_out" "$NGINX_FUELSYSTEM"
      rm -f "$tmp_out"
      ln -sf "$NGINX_FUELSYSTEM" "$NGINX_FUELSYSTEM_ENABLED"
      return 0
    fi
  fi

  cat >"$tmp_out" <<EOF
# fuelsystem.ec-workshops.online -> Unified Fuel Operations redirect (HTTP)
server {
    listen 80;
    listen [::]:80;
    server_name fuelsystem.ec-workshops.online;

    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type "text/plain";
    }

    location / {
        return 302 $FUEL_REDIRECT_URL;
    }
}
EOF
  install -m 644 "$tmp_out" "$NGINX_FUELSYSTEM"
  rm -f "$tmp_out"
  ln -sf "$NGINX_FUELSYSTEM" "$NGINX_FUELSYSTEM_ENABLED"
}

restore_nginx_from_backup() {
  local bak_nginx="$1"
  [ -d "$bak_nginx" ] || return 0
  log "Restoring Nginx site configs from $bak_nginx..."
  [ -f "$bak_nginx/storesdb" ] && cp "$bak_nginx/storesdb" "$NGINX_STORESDB"
  [ -f "$bak_nginx/fuelsystem" ] && cp "$bak_nginx/fuelsystem" "$NGINX_FUELSYSTEM"
  if [ -f "$bak_nginx/erp" ]; then
    cp "$bak_nginx/erp" "$NGINX_ERP"
    ln -sf "$NGINX_ERP" "$NGINX_ERP_ENABLED"
  elif [ -f "$bak_nginx/erp.absent" ]; then
    rm -f "$NGINX_ERP_ENABLED" "$NGINX_ERP"
  fi
}

cmd_setup_ssl() {
  require_root
  require_cmd nginx
  require_cmd curl
  detect_acme_webroot

  local resolved_ips my_ip
  resolved_ips="$(getent ahosts "$UNIFIED_DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  if [ "$SKIP_DNS_CHECK" -eq 0 ]; then
    [ -n "$resolved_ips" ] || die "$UNIFIED_DOMAIN does not resolve in DNS yet. Edit Hostinger DNS A record 'erp' -> your VPS IP, wait for propagation, and re-run (or pass --skip-dns-check)."
    my_ip="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    if [ -n "$my_ip" ] && ! printf '%s\n' "$resolved_ips" | grep -Fxq "$my_ip"; then
      die "$UNIFIED_DOMAIN currently resolves to [$(printf '%s' "$resolved_ips" | tr '\n' ' ')], NOT this server ($my_ip). Update your Hostinger DNS A record for 'erp' to '$my_ip' (edit the existing record rather than adding a duplicate), wait 1-5 minutes for propagation, and re-run (or pass --skip-dns-check)."
    fi
    log "Verified $UNIFIED_DOMAIN resolves cleanly (${my_ip:-$(printf '%s' "$resolved_ips" | tr '\n' ' ')})."
  else
    warn "Skipping DNS IP check (--skip-dns-check); current DNS: [$(printf '%s' "$resolved_ips" | tr '\n' ' ')]"
  fi

  if ! command -v certbot >/dev/null 2>&1; then
    log "Installing certbot..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update && apt-get install -y certbot
  fi

  mkdir -p "$ACME_WEBROOT"
  chmod 755 "$ACME_WEBROOT"

  if [ ! -f "$NGINX_ERP" ] || ! grep -q '\.well-known/acme-challenge' "$NGINX_ERP"; then
    log "Installing temporary :80 ACME challenge responder in $NGINX_ERP (webroot=$ACME_WEBROOT, zero impact on existing sites)..."
    cat >"$NGINX_ERP" <<EOF
# Temporary HTTP-01 responder for Let's Encrypt issuance ($UNIFIED_DOMAIN)
server {
    listen 80;
    listen [::]:80;
    server_name $UNIFIED_DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type "text/plain";
    }

    location / {
        return 503;
    }
}
EOF
    chmod 644 "$NGINX_ERP"
    ln -sf "$NGINX_ERP" "$NGINX_ERP_ENABLED"
    nginx -t
    systemctl reload nginx
  fi

  local -a email_args=()
  if [ -n "$CERTBOT_EMAIL" ]; then
    email_args=(--email "$CERTBOT_EMAIL")
  else
    email_args=(--register-unsafely-without-email)
  fi

  log "Requesting Let's Encrypt TLS certificate for $UNIFIED_DOMAIN (webroot=$ACME_WEBROOT)..."
  certbot certonly \
    --webroot -w "$ACME_WEBROOT" \
    -d "$UNIFIED_DOMAIN" \
    --non-interactive --agree-tos \
    "${email_args[@]}"

  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat >/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/usr/bin/env bash
nginx -t && systemctl reload nginx
EOF
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

  detect_erp_tls
  [ -n "$DETECTED_ERP_CERT" ] || die "certbot succeeded but expected TLS files were not detected."
  log "SSL SETUP COMPLETE: cert=$DETECTED_ERP_CERT key=$DETECTED_ERP_KEY"
}

cmd_cutover() {
  require_root
  require_cmd sqlite3
  require_cmd nginx
  require_cmd curl
  require_cmd "$NODE_BIN"

  detect_erp_tls
  if [ -z "$DETECTED_ERP_CERT" ] && [ "$ALLOW_HTTP" -eq 0 ]; then
    die "No TLS certificate found for $UNIFIED_DOMAIN before stopping live services. Run 'sudo bash $0 setup-ssl --email <you>' after updating Hostinger DNS (for Let's Encrypt), OR save Cloudflare Origin Cert to /etc/ssl/cloudflare/${UNIFIED_DOMAIN}.pem & .key, OR pass --allow-http."
  fi

  detect_live_sources
  ensure_unified_dirs_and_env
  check_unified_dependencies
  [ -f "$OLD_FUEL_DB" ] || die "Fuel V2 DB not found: $OLD_FUEL_DB"

  confirm_phrase "CUTOVER" "Stop old WorkshopOne ($OLD_WO_SERVICE) + Fuel V2 (PM2), archive cold snapshots, merge into $UNIFIED_DB, verify parity, bring up https://$UNIFIED_DOMAIN on :$UNIFIED_PORT, and redirect storesdb + fuelsystem"

  # Step 1: Optional maintenance broadcast
  if [ "$SKIP_BROADCAST" -eq 0 ]; then
    local bscript=""
    if [ -f "$OLD_WO_APP/scripts/broadcast_maintenance.js" ]; then
      bscript="$OLD_WO_APP/scripts/broadcast_maintenance.js"
    elif [ -f "$UNIFIED_APP/scripts/broadcast_maintenance.js" ]; then
      bscript="$UNIFIED_APP/scripts/broadcast_maintenance.js"
    fi
    if [ -n "$bscript" ] && systemctl is-active "$OLD_WO_SERVICE" >/dev/null 2>&1; then
      log "Broadcasting ${BROADCAST_SECONDS}s maintenance notice on 127.0.0.1:$OLD_WO_PORT..."
      PORT="$OLD_WO_PORT" "$NODE_BIN" "$bscript" "$BROADCAST_SECONDS" \
        "System upgrading to unified ERP (https://${UNIFIED_DOMAIN}). Please save and finish your entry now." --no-wait \
        || warn "Maintenance broadcast endpoint unavailable on :$OLD_WO_PORT; waiting manually..."
      sleep "$BROADCAST_SECONDS"
    fi
  fi

  # Step 2: Stop both old services cleanly so WAL logs flush completely
  stop_old_services

  # Step 3: Archive frozen pre-cutover cold snapshots + Nginx backups
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  CUTOVER_BAK="/opt/backups/pre-cutover-$stamp"
  mkdir -p /opt/backups && chmod 0755 /opt/backups
  mkdir -p "$CUTOVER_BAK/nginx"
  ln -sfn "$CUTOVER_BAK" /opt/backups/pre-cutover-latest

  log "Archiving frozen cold SQLite snapshots into $CUTOVER_BAK..."
  chown "root:$SERVICE_GROUP" "$CUTOVER_BAK"
  chmod 0750 "$CUTOVER_BAK"
  backup_sqlite_safe "$OLD_FUEL_DB" "$CUTOVER_BAK/fuelsystem_app.db"
  local -a merge_args=()
  if [ "$WO_DB_MODE" = "single" ]; then
    backup_sqlite_safe "$WO_SINGLE_DB" "$CUTOVER_BAK/workshopone.db"
    merge_args+=(--wo-db "$CUTOVER_BAK/workshopone.db")
  else
    backup_sqlite_safe "$WO_CORE_DB" "$CUTOVER_BAK/core.db"
    backup_sqlite_safe "$WO_CW_DB" "$CUTOVER_BAK/CW.db"
    merge_args+=(--core-db "$CUTOVER_BAK/core.db" --cw-db "$CUTOVER_BAK/CW.db")
    if [ -n "$WO_MTR_DB" ]; then
      backup_sqlite_safe "$WO_MTR_DB" "$CUTOVER_BAK/MTR.db"
      merge_args+=(--mtr-db "$CUTOVER_BAK/MTR.db")
    fi
  fi
  chown "root:$SERVICE_GROUP" "$CUTOVER_BAK"/*.db
  chmod 0640 "$CUTOVER_BAK"/*.db
  merge_args+=(--fuel-db "$CUTOVER_BAK/fuelsystem_app.db")

  [ -f "$NGINX_STORESDB" ] && cp "$NGINX_STORESDB" "$CUTOVER_BAK/nginx/storesdb"
  [ -f "$NGINX_FUELSYSTEM" ] && cp "$NGINX_FUELSYSTEM" "$CUTOVER_BAK/nginx/fuelsystem"
  if [ -f "$NGINX_ERP" ]; then
    cp "$NGINX_ERP" "$CUTOVER_BAK/nginx/erp"
  else
    touch "$CUTOVER_BAK/nginx/erp.absent"
  fi

  if [ -n "$OLD_MFA_KEY" ] && [ -f "$OLD_MFA_KEY" ]; then
    install -m 0600 "$OLD_MFA_KEY" "$CUTOVER_BAK/mfa.key"
    local target_mfa_key
    target_mfa_key="$(dirname "$UNIFIED_DB")/mfa.key"
    if [ ! -f "$target_mfa_key" ]; then
      install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$OLD_MFA_KEY" "$target_mfa_key"
      log "Preserved 2FA key -> $target_mfa_key"
    fi
  fi

  # Step 4: Execute final production merge & attachment sync
  local -a file_args=()
  if [ -n "$OLD_WO_UPLOADS" ] && [ -d "$OLD_WO_UPLOADS" ]; then
    file_args+=(--wo-uploads "$OLD_WO_UPLOADS" --target-uploads "$UNIFIED_UPLOADS")
  fi
  if [ -n "$OLD_WO_OUTSOURCING" ] && [ -d "$OLD_WO_OUTSOURCING" ]; then
    file_args+=(--wo-outsourcing "$OLD_WO_OUTSOURCING" --target-outsourcing "$UNIFIED_OUTSOURCING")
  fi

  log "Running final production --build-fresh merge into $UNIFIED_DB..."
  sudo -u "$SERVICE_USER" "$NODE_BIN" "$UNIFIED_APP/scripts/vps_cutover_merge.js" \
    --build-fresh \
    "${merge_args[@]}" \
    --target-db "$UNIFIED_DB" \
    "${file_args[@]}"

  # Step 5: Mandatory parity gate before touching services or Nginx
  log "Enforcing mandatory --verify-only parity check..."
  if ! sudo -u "$SERVICE_USER" "$NODE_BIN" "$UNIFIED_APP/scripts/vps_cutover_merge.js" \
    --verify-only \
    "${merge_args[@]}" \
    --target-db "$UNIFIED_DB"; then
    die "Parity check failed! Unified service and Nginx were NOT switched. Run 'sudo bash $0 rollback' to restore old services."
  fi

  # Step 6: Install & start unified systemd service and wait for /api/health
  log "Installing $UNIFIED_SERVICE systemd unit and starting server on 127.0.0.1:$UNIFIED_PORT..."
  cp "$UNIFIED_APP/deploy/workshopone-unified.service" "/etc/systemd/system/${UNIFIED_SERVICE}.service"
  chmod 644 "/etc/systemd/system/${UNIFIED_SERVICE}.service"
  systemctl daemon-reload
  systemctl enable --now "$UNIFIED_SERVICE"

  local healthy=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$UNIFIED_PORT/api/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [ "$healthy" -ne 1 ]; then
    journalctl -u "$UNIFIED_SERVICE" -n 40 --no-pager >&2 || true
    die "Unified service failed health check on http://127.0.0.1:$UNIFIED_PORT/api/health. Nginx NOT modified."
  fi
  log "Unified health check passed on http://127.0.0.1:$UNIFIED_PORT/api/health"

  # Step 7: Switch Nginx traffic safely (with automatic backup restore if nginx -t fails)
  log "Configuring unified Nginx vhost ($NGINX_ERP) for $UNIFIED_DOMAIN -> 127.0.0.1:$UNIFIED_PORT..."
  write_erp_unified_nginx

  log "Configuring $NGINX_STORESDB redirect to https://$UNIFIED_DOMAIN..."
  write_storesdb_redirect_nginx

  log "Configuring $NGINX_FUELSYSTEM redirect to $FUEL_REDIRECT_URL..."
  write_fuelsystem_redirect_nginx

  if ! nginx -t; then
    warn "nginx -t failed! Restoring previous Nginx site configs..."
    restore_nginx_from_backup "$CUTOVER_BAK/nginx"
    die "Nginx configuration test failed; previous Nginx configs restored."
  fi
  systemctl reload nginx

  # Step 8: Disable old auto-start services while keeping files cold and leaving sibling apps online
  systemctl disable "$OLD_WO_SERVICE" 2>/dev/null || true
  if [ "$FUEL_PM2_MODE" = "fuelapp" ]; then
    systemctl disable "$OLD_FUEL_PM2_SERVICE" 2>/dev/null || true
  elif [ "$FUEL_PM2_MODE" = "root" ]; then
    log "Keeping pm2-root.service active for sibling PM2 apps (hydraulic-system); 'fuelsystem' remains stopped and saved."
  fi

  # Step 9: Smoke checks
  log "Running final local & Host-header smoke checks..."
  curl -fsS "http://127.0.0.1:$UNIFIED_PORT/api/health" && echo ""
  curl -sI -H "Host: $UNIFIED_DOMAIN" http://127.0.0.1/ | head -n 5 || true
  curl -sI -H "Host: storesdb.ec-workshops.online" http://127.0.0.1/ | head -n 5 || true
  curl -sI -H "Host: fuelsystem.ec-workshops.online" http://127.0.0.1/ | head -n 5 || true
  log "CUTOVER COMPLETE! Live URL: $PUBLIC_ORIGIN | Cold backups preserved at: $CUTOVER_BAK"
}

cmd_rollback() {
  require_root
  require_cmd nginx

  local bak_dir="/opt/backups/pre-cutover-latest"
  if [ ! -d "$bak_dir" ]; then
    bak_dir="$(find /opt/backups -maxdepth 1 -type d -name 'pre-cutover-*' | sort | tail -n 1 || true)"
  fi

  confirm_phrase "ROLLBACK" "Stop $UNIFIED_SERVICE, restore Nginx site configs from ${bak_dir:-<none>}, and restart $OLD_WO_SERVICE + Fuel-System-V2"

  log "Stopping and disabling $UNIFIED_SERVICE..."
  systemctl stop "$UNIFIED_SERVICE" 2>/dev/null || true
  systemctl disable "$UNIFIED_SERVICE" 2>/dev/null || true

  if [ -n "$bak_dir" ] && [ -d "$bak_dir/nginx" ]; then
    restore_nginx_from_backup "$bak_dir/nginx"
    nginx -t && systemctl reload nginx
  else
    warn "No saved Nginx backup directory found; verify $NGINX_ERP, $NGINX_STORESDB, and $NGINX_FUELSYSTEM manually."
  fi

  log "Re-enabling and starting $OLD_WO_SERVICE..."
  systemctl enable --now "$OLD_WO_SERVICE"

  detect_fuel_pm2
  if [ "$FUEL_PM2_MODE" = "fuelapp" ]; then
    if systemctl list-unit-files | grep -q "^${OLD_FUEL_PM2_SERVICE}.service"; then
      systemctl enable --now "$OLD_FUEL_PM2_SERVICE" || true
    fi
    log "Starting Fuel-System-V2 via PM2 under $OLD_FUEL_USER..."
    sudo -u "$OLD_FUEL_USER" PM2_HOME="$OLD_FUEL_PM2_HOME" "$OLD_FUEL_NPX" pm2 start fuelsystem || warn "PM2 start returned non-zero"
  elif [ "$FUEL_PM2_MODE" = "root" ]; then
    log "Starting Fuel-System-V2 via root PM2..."
    "$PM2_BIN" start fuelsystem || warn "PM2 start returned non-zero"
    "$PM2_BIN" save || warn "PM2 save returned non-zero"
  fi

  log "ROLLBACK COMPLETE."
}

# Parse CLI arguments
SUBCOMMAND="${1:-}"
[ -n "$SUBCOMMAND" ] || { usage; exit 1; }
if [ "$SUBCOMMAND" = "-h" ] || [ "$SUBCOMMAND" = "--help" ]; then
  usage
  exit 0
fi
shift

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) AUTO_YES=1 ;;
    --skip-broadcast) SKIP_BROADCAST=1 ;;
    --wait)
      shift
      [ "$#" -gt 0 ] || die "--wait requires seconds argument"
      BROADCAST_SECONDS="$1"
      ;;
    --force-env) FORCE_ENV=1 ;;
    --email)
      shift
      [ "$#" -gt 0 ] || die "--email requires an email address argument"
      CERTBOT_EMAIL="$1"
      ;;
    --skip-dns-check) SKIP_DNS_CHECK=1 ;;
    --allow-http) ALLOW_HTTP=1 ;;
    --keep-tmp) KEEP_TMP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

case "$SUBCOMMAND" in
  preflight) cmd_preflight ;;
  setup-ssl) cmd_setup_ssl ;;
  rehearsal) cmd_rehearsal ;;
  cutover)   cmd_cutover ;;
  rollback)  cmd_rollback ;;
  *) usage; die "Unknown subcommand: $SUBCOMMAND" ;;
esac
