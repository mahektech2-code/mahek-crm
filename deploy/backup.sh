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
# to 10 GB and free to read back, which for a ~40 MB compressed dump means the
# offsite copy costs nothing at all.
#
#   bash backup.sh                 run once, now
#   bash backup.sh --install-cron  schedule it nightly at 01:15 IST
#
# Restoring is restore.sh, and you should run it once before you need it.

set -euo pipefail

APP_DIR=/opt/mahekone
STAMP=$(date +%Y-%m-%d_%H%M)
FILE="mahekone_${STAMP}.sql.gz"
LOCAL="${APP_DIR}/backups/${FILE}"
KEEP_LOCAL_DAYS=7
KEEP_REMOTE_DAYS=30

cd "$APP_DIR"

if [ "${1:-}" = "--install-cron" ]; then
  # 20:45 UTC = 02:15 IST. The host runs UTC, so the cron entry does too.
  #
  # It says AFTER the nightly and now genuinely is. It shipped at 01:15 IST
  # with a comment claiming the same thing, while the nightly ran at 01:43 —
  # so every dump was taken half an hour BEFORE the recompute it claimed to
  # follow, and held a database mid-way between yesterday's caches and
  # today's. Harmless for recovery, wrong in the one way a comment can be:
  # confidently.
  line="45 20 * * * /usr/bin/env bash ${APP_DIR}/backup.sh >> ${APP_DIR}/backups/backup.log 2>&1"
  # Both `|| true`s are load-bearing under `set -o pipefail`, and both fire on
  # a FRESH box — which is the only box this is ever run on. `crontab -l` fails
  # when there is no crontab yet, and `grep -v` exits 1 when it is handed no
  # lines at all. Either one aborts the script before it installs anything, and
  # the failure looks like a permissions problem rather than what it is.
  existing=$(crontab -l 2>/dev/null || true)
  printf '%s\n' "$(printf '%s\n' "$existing" | grep -v 'backup.sh' || true)" "$line" \
    | grep -v '^$' | crontab -
  echo "Installed: ${line}"
  exit 0
fi

set -a
# shellcheck disable=SC1091
. "${APP_DIR}/.env"
set +a

echo "[$(date -Is)] dumping"
# --no-owner so the dump restores cleanly into a database whose role names
# differ — which is exactly the case when restoring onto a fresh box, or back
# into a managed service if this decision is ever reversed.
docker compose exec -T postgres \
  pg_dump -U mahek -d mahekone --no-owner --clean --if-exists \
  | gzip -9 > "$LOCAL"

SIZE=$(du -h "$LOCAL" | cut -f1)
echo "[$(date -Is)] wrote ${FILE} (${SIZE})"

# A dump that is suspiciously small is how a broken backup looks: pg_dump
# writing an error into a gzip stream produces a file, and a file is what a
# careless check looks for. This one refuses to call that a success.
MIN_BYTES=1000000
ACTUAL=$(stat -c%s "$LOCAL")
if [ "$ACTUAL" -lt "$MIN_BYTES" ]; then
  echo "[$(date -Is)] FAILED: ${ACTUAL} bytes is too small to be the database" >&2
  exit 1
fi

# ------------------------------------------------------------------ offsite
if [ -n "${R2_ACCESS_KEY_ID:-}" ]; then
  echo "[$(date -Is)] uploading to R2"
  docker run --rm \
    -e RCLONE_CONFIG_R2_TYPE=s3 \
    -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
    -e RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    -e RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT" \
    -v "${APP_DIR}/backups:/backups:ro" \
    rclone/rclone:latest \
    copy "/backups/${FILE}" "R2:${R2_BUCKET}/" --s3-no-check-bucket
  echo "[$(date -Is)] uploaded"

  # Prune the remote by age. Free tier is 10 GB; a month of ~40 MB dumps is
  # about a gigabyte, so this is housekeeping rather than a real constraint.
  docker run --rm \
    -e RCLONE_CONFIG_R2_TYPE=s3 \
    -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
    -e RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    -e RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT" \
    rclone/rclone:latest \
    delete "R2:${R2_BUCKET}/" --min-age "${KEEP_REMOTE_DAYS}d" --s3-no-check-bucket || true
else
  # Said loudly rather than passed over. A backup that only exists on the
  # droplet is one power event away from not existing, and the whole point of
  # this file is to not be in that position.
  echo "[$(date -Is)] WARNING: R2 not configured — this backup exists ONLY on the droplet" >&2
fi

find "${APP_DIR}/backups" -name 'mahekone_*.sql.gz' -mtime "+${KEEP_LOCAL_DAYS}" -delete
echo "[$(date -Is)] done"
