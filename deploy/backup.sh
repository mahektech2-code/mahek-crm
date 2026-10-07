#!/usr/bin/env bash
#
# The backup that actually matters.
#
# DigitalOcean's daily backups snapshot the whole droplet, which is a fine way
# to get the machine back and a poor way to get a table back — you cannot open
# one, you cannot read it, and restoring means replacing the entire server. So
# there are two, doing different jobs: DO's snapshot restores the BOX, and this
# restores the DATA.
#
# It goes OFF the droplet. A backup living on the disk it is protecting is not
# a backup; it is a copy that dies in the same accident. Cloudflare R2 is free
# to 10 GB and free to read back.
#
#   bash backup.sh                 the nightly dump    -> R2 daily/    (30 days)
#                                  and on the 1st also -> R2 monthly/  (a year)
#   bash backup.sh --intraday      a daytime dump      -> R2 intraday/ (7 days)
#   bash backup.sh --verify        restore the newest dump into a scratch
#                                  database, compare it with the live one, and
#                                  drop it. Touches nothing live.
#   bash backup.sh --install-cron  schedule all three
#
# Restoring for real is restore.sh. `--verify` is the part of a restore that
# can run without taking the app down, every week, so a backup that stopped
# being restorable is found on a Monday rather than on the day it is needed.
#
# TWO OPTIONAL SETTINGS, both worth having (in .env):
#
#   BACKUP_GPG_RECIPIENT_FILE  a PUBLIC key file. Every copy sent to R2 is
#                              encrypted to it. The private half never comes
#                              near this box — DEPLOY.md, "Backups".
#   BACKUP_HEALTHCHECK_URL     pinged on start, success and failure. A
#                              healthchecks.io check (period 6h, grace 1h)
#                              emails somebody when a run fails OR when no run
#                              arrives at all, which a log file never can.

set -euo pipefail

APP_DIR=${APP_DIR:-/opt/mahekone}
KEEP_LOCAL_DAYS=7             # nightly dumps kept on the droplet
KEEP_LOCAL_INTRADAY_DAYS=2    # daytime dumps kept on the droplet
KEEP_REMOTE_DAYS=30           # R2 daily/
KEEP_REMOTE_INTRADAY_DAYS=7   # R2 intraday/
KEEP_REMOTE_MONTHLY_DAYS=400  # R2 monthly/
VERIFY_DB=restore_verify      # the scratch database --verify fills and drops

cd "$APP_DIR"

if [ "${1:-}" = "--install-cron" ]; then
  # The host runs UTC, so the cron entries do too.
  #
  # 20:45 UTC = 02:15 IST, AFTER the nightly (20:13 UTC), so the night's dump
  # holds the recomputed caches rather than a database half-way between two
  # days. The daytime dumps land at 08:15, 14:15 and 20:15 IST: the working
  # day is when the data no spreadsheet can give back is written — calls,
  # visits, receipts, approvals — and a nightly alone loses up to a whole day
  # of it. The verify is Monday 04:00 IST, the quietest hour of the week.
  lines=(
    "45 20 * * * /usr/bin/env bash ${APP_DIR}/backup.sh >> ${APP_DIR}/backups/backup.log 2>&1"
    "45 2,8,14 * * * /usr/bin/env bash ${APP_DIR}/backup.sh --intraday >> ${APP_DIR}/backups/backup.log 2>&1"
    "30 22 * * 0 /usr/bin/env bash ${APP_DIR}/backup.sh --verify >> ${APP_DIR}/backups/backup.log 2>&1"
  )
  # Both `|| true`s are load-bearing under `set -o pipefail`, and both fire on
  # a FRESH box — which is the only box this is ever run on. `crontab -l` fails
  # when there is no crontab yet, and `grep -v` exits 1 when it is handed no
  # lines at all. Either one aborts the script before it installs anything, and
  # the failure looks like a permissions problem rather than what it is.
  existing=$(crontab -l 2>/dev/null || true)
  printf '%s\n' "$(printf '%s\n' "$existing" | grep -v 'backup.sh' || true)" "${lines[@]}" \
    | grep -v '^$' | crontab -
  printf 'Installed: %s\n' "${lines[@]}"
  exit 0
fi

MODE=daily
case "${1:-}" in
  "") ;;
  --intraday) MODE=intraday ;;
  --verify) MODE=verify ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

set -a
# shellcheck disable=SC1091
. "${APP_DIR}/.env"
set +a

log() { echo "[$(date -Is)] ${MODE}: $*"; }

# One at a time. A verify restoring while a dump runs doubles the load on a
# 1 GiB box for no reason, and a daytime run that overruns must not race the
# next one. Taken BEFORE any healthcheck ping, so a run that steps aside
# reports nothing either way — the run holding the lock will.
exec 9>/tmp/mahekone-backup.lock
if ! flock -n 9; then
  log "another backup is running — stepping aside"
  exit 0
fi

# ----------------------------------------------------------------- alerting
# A failure that only reaches a log file is a failure nobody reads until the
# day they need the backup. Every exit that is not a success pings /fail with
# the reason; a run that never starts at all is caught by the check's own
# schedule, which is the half no script can ever report about itself.
hc() {
  [ -n "${BACKUP_HEALTHCHECK_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${2:-}" \
    "${BACKUP_HEALTHCHECK_URL%/}${1}" || log "could not reach the healthcheck"
}
REASON="exited early"
LOCAL=""
DUMP_OK=0
finish() {
  local rc=${1:-$?}
  # The encrypted copy exists only to be uploaded. Left behind by a failed
  # upload it matches no prune pattern below and would sit there for ever.
  if [ -n "$LOCAL" ]; then rm -f "${LOCAL}.gpg"; fi
  if [ "$rc" -eq 0 ]; then hc "" "${MODE} ok"; return; fi
  log "FAILED: ${REASON}"
  hc "/fail" "${MODE} failed: ${REASON}"
  # A dump that never passed its own checks is removed, or it sits in
  # backups/ as the newest file — the one a restore in a hurry, and
  # `--verify`, would both reach for first. A dump that passed and only
  # failed to UPLOAD is kept: it is a good backup that is merely not offsite.
  if [ -n "$LOCAL" ] && [ "$DUMP_OK" -eq 0 ]; then rm -f "$LOCAL"; fi
}
trap finish EXIT
hc "/start"

pg() { docker compose exec -T postgres psql -U mahek -v ON_ERROR_STOP=1 -q "$@"; }

r2() {
  docker run --rm \
    -e RCLONE_CONFIG_R2_TYPE=s3 \
    -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
    -e RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    -e RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT" \
    -v "${APP_DIR}/backups:/backups:ro" \
    rclone/rclone:latest "$@" --s3-no-check-bucket
}

# =================================================================== verify
if [ "$MODE" = "verify" ]; then
  # A backup that restores without error and holds a database recognisably
  # like the live one is the only definition of "the backup works" worth
  # having. A file existing is not one; a file of the right size is not one.
  REASON="no dump on the droplet to verify"
  DUMP=$(ls -1t "${APP_DIR}"/backups/mahekone_*.sql.gz 2>/dev/null | head -1 || true)
  [ -n "$DUMP" ]

  # A newest dump older than a day and a half means the schedule stopped,
  # whatever the dump itself says. The healthcheck asks the same question
  # from the other end; this asks it on a box where nobody set one up.
  REASON="newest dump $(basename "$DUMP") is more than 36 hours old"
  [ "$(( $(date +%s) - $(stat -c %Y "$DUMP") ))" -lt $(( 36 * 3600 )) ]

  # Dropped on the way out whatever happens — a scratch copy of every
  # customer's ledger left lying in the server is exactly the debris this
  # exists to prevent. The exit status is captured FIRST and PASSED to
  # `finish`, or the drop's own success would report a failed verify as a
  # passing one. Not `(exit $rc); finish`: under `set -e` that subshell ends
  # the trap on the spot, and a failed verify then pings nothing at all.
  trap 'rc=$?; pg -d postgres -c "drop database if exists ${VERIFY_DB}" </dev/null || true; finish "$rc"' EXIT
  log "restoring $(basename "$DUMP") into ${VERIFY_DB}"
  pg -d postgres -c "drop database if exists ${VERIFY_DB}" </dev/null
  pg -d postgres -c "create database ${VERIFY_DB}" </dev/null
  REASON="$(basename "$DUMP") did not restore cleanly"
  start=$(date +%s)
  gunzip -c "$DUMP" | pg -d "$VERIFY_DB" >/dev/null
  log "restored in $(( $(date +%s) - start ))s"

  # Tables that only grow, or nearly. A restored count far below the live
  # one is a dump missing data — truncated, or taken from the wrong database —
  # and that is the failure that restores "successfully".
  REASON="the restored copy is missing rows the live database has"
  bad=0
  for t in customers orders bills payment_receipts calls users audit_log attachments; do
    restored=$(pg -d "$VERIFY_DB" -Atc "select count(*) from ${t}" </dev/null)
    live=$(pg -d mahekone -Atc "select count(*) from ${t}" </dev/null)
    flag=ok
    if [ "$live" -gt 0 ] && [ $(( restored * 100 )) -lt $(( live * 90 )) ]; then flag=SHORT; bad=1; fi
    log "  ${t}: restored ${restored}, live ${live} ${flag}"
  done
  [ "$bad" -eq 0 ]

  # And the offsite half: a good dump on the droplet says nothing about R2.
  if [ -n "${R2_ACCESS_KEY_ID:-}" ]; then
    REASON="nothing in R2 daily/ from the last 36 hours"
    recent=$(r2 lsf "R2:${R2_BUCKET}/daily/" --max-age 36h)
    [ -n "$recent" ]
    log "R2 daily/ has: ${recent//$'\n'/ }"
  fi
  log "verified"
  exit 0
fi

# ===================================================================== dump
STAMP=$(date +%Y-%m-%d_%H%M)
if [ "$MODE" = "intraday" ]; then FILE="mahekone_${STAMP}_intraday.sql.gz"; else FILE="mahekone_${STAMP}.sql.gz"; fi
LOCAL="${APP_DIR}/backups/${FILE}"

log "dumping"
REASON="pg_dump failed"
# --no-owner so the dump restores cleanly into a database whose role names
# differ — which is exactly the case when restoring onto a fresh box, or back
# into a managed service if this decision is ever reversed.
docker compose exec -T postgres \
  pg_dump -U mahek -d mahekone --no-owner --clean --if-exists \
  | gzip -9 > "$LOCAL"
log "wrote ${FILE} ($(du -h "$LOCAL" | cut -f1))"

# A dump that is suspiciously small is how a broken backup looks: pg_dump
# writing an error into a gzip stream produces a file, and a file is what a
# careless check looks for. This one refuses to call that a success.
MIN_BYTES=1000000
ACTUAL=$(stat -c%s "$LOCAL")
REASON="${ACTUAL} bytes is too small to be the database"
[ "$ACTUAL" -ge "$MIN_BYTES" ]
# And gzip has to agree the stream is whole: a dump cut off by a full disk is
# large, plausible, and missing everything after the point it stopped.
REASON="${FILE} is not a complete gzip stream"
gzip -t "$LOCAL"
DUMP_OK=1

# ------------------------------------------------------------------ offsite
if [ -n "${R2_ACCESS_KEY_ID:-}" ]; then
  # ENCRYPTED BEFORE IT LEAVES. The dump is every customer's ledger, the HR
  # master with salaries in it, and every API key in `app_secrets` — so the
  # bucket holding a month of them is the most valuable thing MahekOne keeps
  # on somebody else's computer. Encrypted to a public key, a stolen R2 token
  # yields ciphertext. The private key lives with a person and never on this
  # box: a backup an intruder here could decrypt protects nothing from them.
  #
  # The LOCAL copy stays plain. It sits beside the live database it was taken
  # from, so encrypting it protects nothing, and it is what a restore in a
  # hurry reaches for first.
  SEND="$FILE"
  if [ -n "${BACKUP_GPG_RECIPIENT_FILE:-}" ]; then
    REASON="encryption failed — is ${BACKUP_GPG_RECIPIENT_FILE} a public key?"
    # A throwaway keyring per run: nothing is imported into the deploy user's
    # own, so there is no keyring here for anybody to find a key in.
    GNUPGHOME=$(mktemp -d)
    export GNUPGHOME
    gpg --batch --yes --quiet --trust-model always --compress-algo none \
      --recipient-file "$BACKUP_GPG_RECIPIENT_FILE" \
      --output "${LOCAL}.gpg" --encrypt "$LOCAL"
    rm -rf "$GNUPGHOME"; unset GNUPGHOME
    SEND="${FILE}.gpg"
  else
    # Said loudly rather than passed over, like the missing-R2 warning below.
    log "WARNING: BACKUP_GPG_RECIPIENT_FILE not set — the R2 copy is NOT encrypted"
  fi

  REASON="upload to R2 failed"
  log "uploading ${SEND} to R2 ${MODE}/"
  r2 copy "/backups/${SEND}" "R2:${R2_BUCKET}/${MODE}/"
  # The first nightly of each month is also kept for a year. Thirty days is
  # how long a mistake can go unnoticed before it becomes unrecoverable, and
  # "the customer master has been wrong since August" is found in October.
  if [ "$MODE" = "daily" ] && [ "$(date -u +%d)" = "01" ]; then
    log "first of the month — also to monthly/"
    r2 copy "/backups/${SEND}" "R2:${R2_BUCKET}/monthly/"
  fi
  log "uploaded"

  # Pruned by age, each prefix on its own clock. These deletes are EXPECTED
  # to be refused once the bucket has lock rules (DEPLOY.md) — the lock is
  # what stops anybody holding this box's token from deleting the backups,
  # and it stops this script too until an object is old enough. Hence
  # `|| true`. Root-level files are the layout from before the prefixes.
  r2 delete "R2:${R2_BUCKET}/" --max-depth 1 --min-age "${KEEP_REMOTE_DAYS}d" >/dev/null 2>&1 || true
  r2 delete "R2:${R2_BUCKET}/daily/" --min-age "${KEEP_REMOTE_DAYS}d" >/dev/null 2>&1 || true
  r2 delete "R2:${R2_BUCKET}/intraday/" --min-age "${KEEP_REMOTE_INTRADAY_DAYS}d" >/dev/null 2>&1 || true
  r2 delete "R2:${R2_BUCKET}/monthly/" --min-age "${KEEP_REMOTE_MONTHLY_DAYS}d" >/dev/null 2>&1 || true
else
  # A backup that only exists on the droplet is one power event away from not
  # existing, and the whole point of this file is to not be in that position.
  log "WARNING: R2 not configured — this backup exists ONLY on the droplet"
fi

find "${APP_DIR}/backups" -name 'mahekone_*_intraday.sql.gz' -mtime "+${KEEP_LOCAL_INTRADAY_DAYS}" -delete
find "${APP_DIR}/backups" -name 'mahekone_*.sql.gz' ! -name '*_intraday.sql.gz' -mtime "+${KEEP_LOCAL_DAYS}" -delete
log "done"
