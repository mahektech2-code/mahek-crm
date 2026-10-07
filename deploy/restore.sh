#!/usr/bin/env bash
#
# Put a dump back.
#
# RUN THIS ONCE BEFORE YOU NEED IT. An untested backup is a belief, not a
# backup, and the moment you discover which one you have is the worst possible
# moment to find out. The drill is in DEPLOY.md and takes about ten minutes.
#
#   bash restore.sh backups/mahekone_2026-08-14_0115.sql.gz
#   bash restore.sh --list-r2
#   bash restore.sh --from-r2 daily/mahekone_2026-10-06_2045.sql.gz.gpg --key ~/backup-private.asc
#
# This DESTROYS the current contents of the database, which is the point: the
# dump was taken with --clean --if-exists, so it drops what it is replacing.
# It asks first.
#
# R2 copies end in .gpg once BACKUP_GPG_RECIPIENT_FILE is set, and decrypting
# one needs the PRIVATE key, which by design does not live on this box. Bring
# it for the restore with `--key` — scp it to /tmp, or better, decrypt on your
# own machine and scp the plain .sql.gz across instead — and delete it after.
# The local copies in backups/ are never encrypted, so a restore from the box
# itself needs no key at all.

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

USAGE='usage: restore.sh <file.sql.gz[.gpg]> | --from-r2 <prefix/name> | --list-r2   [--key <private key>]'
FROM_R2=""
DUMP=""
KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list-r2)
      # daily/, intraday/ and monthly/ — and, until they age out, the files
      # from before the prefixes, at the top.
      r2 lsl "R2:${R2_BUCKET}/" --s3-no-check-bucket | sort -k2,3
      exit 0 ;;
    --from-r2) FROM_R2="${2:?which file — run --list-r2}"; shift 2 ;;
    --key) KEY="${2:?--key needs the private key file}"; shift 2 ;;
    -*) echo "$USAGE" >&2; exit 2 ;;
    *) DUMP="$1"; shift ;;
  esac
done

if [ -n "$FROM_R2" ]; then
  echo "==> Fetching ${FROM_R2} from R2"
  r2 copy "R2:${R2_BUCKET}/${FROM_R2}" /backups/ --s3-no-check-bucket
  DUMP="${APP_DIR}/backups/$(basename "$FROM_R2")"
fi
[ -n "$DUMP" ] || { echo "$USAGE" >&2; exit 2; }
[ -f "$DUMP" ] || { echo "No such file: ${DUMP}" >&2; exit 1; }

if [ "${DUMP%.gpg}" != "$DUMP" ]; then
  [ -n "$KEY" ] || { echo "${DUMP} is encrypted — pass --key <private key file>" >&2; exit 1; }
  echo "==> Decrypting"
  # A throwaway keyring, deleted on the way out, so the private key is never
  # left imported on the box once the restore is done.
  GNUPGHOME=$(mktemp -d)
  export GNUPGHOME
  trap 'rm -rf "$GNUPGHOME"' EXIT
  gpg --batch --quiet --import "$KEY"
  read -rsp 'Passphrase for the backup key (Enter if it has none): ' PASS; echo
  printf '%s' "$PASS" | gpg --batch --yes --quiet --pinentry-mode loopback \
    --passphrase-fd 0 --output "${DUMP%.gpg}" --decrypt "$DUMP"
  unset PASS
  DUMP="${DUMP%.gpg}"
  echo "    decrypted to ${DUMP} — now delete ${KEY} from this box"
fi

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

# THE DATABASE IS EMPTIED FIRST, and this is not belt-and-braces.
#
# `pg_dump --clean` only drops what is IN the dump. Anything created after the
# dump was taken — a table a bad migration added, a table somebody made by hand
# — is not mentioned, so nothing drops it and it survives the restore. The
# restore then reports success and you are left with the dump's data plus
# debris, which is not the state you asked for.
#
# Found by drilling it: a marker table created after the backup was still there
# afterwards. The restore had "worked" and the database was not what the dump
# said it was.
#
# Dropping both schemas makes a restore mean what everybody assumes it means:
# the database is exactly the dump, and nothing else. The dump recreates
# `drizzle` itself; `public` has to be put back by hand because Postgres will
# not restore into a database with no public schema.
echo "==> Emptying the database, so the restore is exactly the dump"
docker compose exec -T postgres psql -U mahek -d mahekone -v ON_ERROR_STOP=1 -q <<'SQL'
drop schema if exists drizzle cascade;
drop schema if exists public cascade;
create schema public;
grant all on schema public to mahek;
SQL

echo "==> Restoring"
gunzip -c "$DUMP" | docker compose exec -T postgres psql -U mahek -d mahekone -v ON_ERROR_STOP=1

echo "==> Starting the app"
docker compose start app

echo
echo "Restored. Now check it is actually there:"
echo "  docker compose exec postgres psql -U mahek -d mahekone -c 'select count(*) from bills'"
echo "  docker compose exec postgres psql -U mahek -d mahekone -c 'select count(*) from customers'"
