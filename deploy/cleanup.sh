#!/usr/bin/env bash
#
# WHAT THE DROPLET CAN LET GO OF, once a week.
#
# This box is 24 GB and 1 GB of RAM, and nothing on it was ever tidying up
# after itself. Four things accumulate, and only one of them is a real cost
# today — but all four grow with every deploy, and the day disk runs out is
# the day Postgres cannot write, which is an outage rather than an
# inconvenience.
#
# Deliberately NOT here: the nightly database dumps. `backup.sh` already
# prunes them at KEEP_LOCAL_DAYS=7 and mirrors to R2, so they are somebody's
# considered retention policy rather than litter. A second thing deleting
# backups is how a backup policy quietly becomes two policies.
#
# Run with --dry-run to be told what would go without anything going.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/mahekone}
KEEP_APKS=${KEEP_APKS:-1}          # besides the live mbos.apk
KEEP_IMAGE_TAGS=${KEEP_IMAGE_TAGS:-2}   # the running build, and the one to roll back to
JOURNAL_KEEP=${JOURNAL_KEEP:-50M}
SYNC_LOG_MAX_MB=${SYNC_LOG_MAX_MB:-20}

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1
say() { printf '%s\n' "$*"; }
run() { if [[ $DRY -eq 1 ]]; then say "  would: $*"; else eval "$@"; fi; }

before=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
say "=== droplet cleanup $(date -Is) $( ((DRY)) && echo "(dry run)" )"
say "free before: ${before} MB"

# 1. OLD APK COPIES. The live file is `mbos.apk`, which is what the download
#    link serves; every release is also archived in R2 under a versioned name,
#    which is what makes these local copies redundant rather than the only
#    copy. One is kept so a bad release can be put back by hand without
#    waiting on a download.
say "-- old APK copies (keeping mbos.apk + newest ${KEEP_APKS})"
mapfile -t old_apks < <(ls -1t "${APP_DIR}"/downloads/mbos.apk.* 2>/dev/null | tail -n +$((KEEP_APKS + 1)) || true)
for f in "${old_apks[@]:-}"; do [[ -n "$f" ]] && run "rm -f '$f'" && say "  $(basename "$f")"; done
[[ ${#old_apks[@]} -eq 0 ]] && say "  nothing to remove"

# 2. DOCKER IMAGES, BY NAME AND NEVER BY SWEEP.
#    `docker image prune -a --filter until=…` was the obvious way and it is
#    wrong here: it removes any image no CONTAINER is running, and
#    `rclone/rclone:latest` is exactly that — nothing runs it, and `backup.sh`
#    invokes it every night with `docker run --rm`. Pruning it means the first
#    backup after cleanup re-pulls 132 MB before it can upload, at 20:45, on a
#    droplet whose disk we were tidying because it was tight. `postgres` and
#    `caddy` survive a sweep only because they happen to be running, which is
#    luck rather than a rule.
#
#    So: only the two images this deploy actually rotates, newest
#    ${KEEP_IMAGE_TAGS} of each kept — the running one, and the one before it,
#    because a rollback is `up` with the previous tag and a pruned image turns
#    that into a registry pull at the worst possible moment.
say "-- old builds (keeping newest ${KEEP_IMAGE_TAGS} of each rotated image)"
for repo in registry.digitalocean.com/mahekone/app ghcr.io/mahektech2-code/mahek-website; do
  mapfile -t stale < <(docker images --filter "reference=${repo}" \
      --format '{{.CreatedAt}}\t{{.ID}}\t{{.Repository}}:{{.Tag}}' 2>/dev/null \
    | sort -r | tail -n +$((KEEP_IMAGE_TAGS + 1)) | cut -f2,3 || true)
  for line in "${stale[@]:-}"; do
    [[ -z "$line" ]] && continue
    id=${line%%$'\t'*}; tag=${line#*$'\t'}
    # `docker rmi` refuses an image a container still uses, which is the
    # backstop: this can never remove what is running, whatever the sort said.
    run "docker rmi '$id' >/dev/null 2>&1 || true" && say "  $tag"
  done
done
say "-- dangling layers"
run "docker image prune -f >/dev/null"

# 3. JOURNAL. No retention was configured, so it grows until systemd's own
#    10%-of-disk default, which on 24 GB is 2.4 GB of logs nobody reads.
say "-- journal down to ${JOURNAL_KEEP}"
run "sudo journalctl --vacuum-size=${JOURNAL_KEEP} >/dev/null 2>&1 || journalctl --vacuum-size=${JOURNAL_KEEP} >/dev/null 2>&1 || true"

# 4. THE SYNC LOG. Appended every 30 minutes since the box was built and never
#    rotated. Truncated rather than deleted, and the tail is kept, because it
#    is the only record of what the half-hourly cycle has been doing and the
#    last few days of it are what somebody reads when a sync looks wrong.
say "-- sync.log if over ${SYNC_LOG_MAX_MB} MB"
log="${APP_DIR}/backups/sync.log"
if [[ -f "$log" ]]; then
  mb=$(( $(stat -c %s "$log") / 1024 / 1024 ))
  if (( mb > SYNC_LOG_MAX_MB )); then
    say "  ${mb} MB -> keeping the last 5000 lines"
    run "tail -n 5000 '$log' > '$log.tmp' && mv '$log.tmp' '$log'"
  else
    say "  ${mb} MB, leaving it"
  fi
fi

after=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
say "free after:  ${after} MB  (freed $(( after - before )) MB)"
