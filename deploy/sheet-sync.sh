#!/usr/bin/env bash
#
# The sheet sync, driven from the droplet rather than from GitHub.
#
# WHY IT MOVED. `schedule:` in GitHub Actions is best-effort, and on a private
# repo belonging to a free account it is the lowest priority tier there is: a
# tick that cannot be served is DROPPED, never queued. `7,37 * * * *` promises
# forty-eight runs a day and delivered five or six — measured here, gaps of
# three to four hours, every run green. Nothing fails; the CRM is just quietly
# hours behind the workbook, and an order typed into the sheet at ten takes
# until two to appear in front of a telecaller.
#
# The original answer was an Apps Script trigger living beside the sheet, which
# is not best-effort. That needs edit access to the workbook, and we have view.
# The other answer was Vercel Cron, which is paid.
#
# Neither problem exists any more. There is a server now: it is always on, its
# cron is a real cron, and it can call the app it is hosting. The reason the
# schedule lived somewhere else was that there was nowhere else to put it.
#
#   bash sheet-sync.sh cycle     the half-hourly read modes, then publish
#   bash sheet-sync.sh nightly   the daily full compare, then the recomputes
#
# Both are safe to run twice: the route answers 409 when a sync of that source
# is already running, and this treats that as ordinary rather than as failure.

set -uo pipefail

APP_DIR=/opt/mahekone
cd "$APP_DIR"

set -a
# shellcheck disable=SC1091
. "${APP_DIR}/.env"
set +a

URL="https://${DOMAIN}/api/sheets/sync"
OWNER="${SYNC_OWNER_EMAIL:-}"

sync() {
  local mode="$1"
  # --max-time 310 sits just under the route's own five-minute ceiling, and
  # BLOCKS until the server answers. That is the whole reason the steps can be
  # sequential: the next mode does not start until this one has finished.
  local code
  code=$(curl -sS -o /tmp/sync-out.json -w '%{http_code}' --max-time 310 \
    -H "Authorization: Bearer ${CRON_SECRET}" "${URL}?mode=${mode}" || echo 000)

  case "$code" in
    200) echo "[$(date -Is)] ${mode}: $(head -c 300 /tmp/sync-out.json)" ;;
    # Two overlapping calls are the ordinary result of a slow run meeting a
    # fixed interval. Not a failure, and nothing should be woken up for it.
    409) echo "[$(date -Is)] ${mode}: already running, skipped" ;;
    000) echo "[$(date -Is)] ${mode}: no answer within 310s — the server may still be running it" >&2 ;;
    *)   echo "[$(date -Is)] ${mode}: HTTP ${code} $(head -c 200 /tmp/sync-out.json)" >&2 ;;
  esac
}

case "${1:-cycle}" in
  cycle)
    # ORDER MATTERS. The read modes land rows in the staging tables and
    # `project` publishes what has landed, so projecting first would ship the
    # previous cycle's data as though it were fresh.
    for m in append taken payments parties; do sync "$m"; done
    [ -n "$OWNER" ] && sync "project&owner=${OWNER}"
    ;;
  nightly)
    # `reconcile` is the only pass that sees an edit to an old row or a
    # deletion; `nightly` is the only thing that rebuilds the derived caches,
    # and it has to run after the projection has published what reconcile
    # found.
    sync reconcile
    [ -n "$OWNER" ] && sync "project&owner=${OWNER}"
    sync nightly
    ;;
  *)
    echo "usage: sheet-sync.sh [cycle|nightly]" >&2
    exit 2
    ;;
esac
