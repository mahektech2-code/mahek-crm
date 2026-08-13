#!/usr/bin/env bash
#
# Put a dump back.
#
# RUN THIS ONCE BEFORE YOU NEED IT. An untested backup is a belief, not a
# backup, and the moment you discover which one you have is the worst possible
# moment to find out. The drill is in DEPLOY.md and takes about ten minutes.
#
#   bash restore.sh backups/mahekone_2026-08-14_0115.sql.gz
#   bash restore.sh --from-r2 mahekone_2026-08-14_0115.sql.gz
#   bash restore.sh --list-r2
#
# This DESTROYS the current contents of the database, which is the point: the
# dump was taken with --clean --if-exists, so it drops what it is replacing.
# It asks first.

set -euo pipefail

APP_DIR=/opt/mahekone
cd "$APP_DIR"

set -a
# shellcheck disable=SC1091
. "${APP_DIR}/.env"
set +a

r2() {
  docker run --rm \
    -e RCLONE_CONFIG_R2_TYPE=s3 \
    -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
    -e RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    -e RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT" \
    -v "${APP_DIR}/backups:/backups" \
    rclone/rclone:latest "$@"
}

if [ "${1:-}" = "--list-r2" ]; then
  r2 lsl "R2:${R2_BUCKET}/" --s3-no-check-bucket
  exit 0
fi

if [ "${1:-}" = "--from-r2" ]; then
  NAME="${2:?which file — run --list-r2}"
  echo "==> Fetching ${NAME} from R2"
  r2 copy "R2:${R2_BUCKET}/${NAME}" /backups/ --s3-no-check-bucket
  DUMP="${APP_DIR}/backups/${NAME}"
else
  DUMP="${1:?usage: restore.sh <file.sql.gz> | --from-r2 <name> | --list-r2}"
fi

[ -f "$DUMP" ] || { echo "No such file: ${DUMP}" >&2; exit 1; }

echo
echo "About to REPLACE the contents of mahekone with:"
echo "  ${DUMP}  ($(du -h "$DUMP" | cut -f1), $(date -r "$DUMP" -Is))"
echo
read -rp 'Type the word "replace" to go ahead: ' answer
[ "$answer" = "replace" ] || { echo "Stopped."; exit 1; }

# The app comes down first. Restoring underneath a running app means requests
# hitting half-dropped tables, and Server Actions writing into a database that
# is being replaced beneath them.
echo "==> Stopping the app"
docker compose stop app

echo "==> Restoring"
gunzip -c "$DUMP" | docker compose exec -T postgres psql -U mahek -d mahekone -v ON_ERROR_STOP=1

echo "==> Starting the app"
docker compose start app

echo
echo "Restored. Now check it is actually there:"
echo "  docker compose exec postgres psql -U mahek -d mahekone -c 'select count(*) from bills'"
echo "  docker compose exec postgres psql -U mahek -d mahekone -c 'select count(*) from customers'"
