#!/usr/bin/env bash
#
# Bring the stack up. ONE definition of that, called by the deploy workflow on
# the droplet and by the `stack` job in CI.
#
# It is a script rather than a line in a workflow because of what happened when
# it was a line in a workflow. `deploy.yml` said `docker compose up -d app`,
# which starts the app and everything it DEPENDS on — postgres. Caddy depends
# on the app rather than the other way round, so it was never in that graph and
# was never started. The app came up healthy, migrations applied, every step of
# the deploy reported success, and nothing was listening on 443.
#
# With one definition, the smoke test in CI exercises the same command the
# droplet runs. Two copies of it is how they drifted.
#
# Run from the directory holding docker-compose.yml and .env — /opt/mahekone on
# the droplet, a staging directory in CI, which is deliberately the same shape.

set -euo pipefail

# Wait until one service's container says healthy. Echoes nothing on success.
healthy() {
  local service="$1" id state
  for _ in $(seq 1 60); do
    id=$(docker compose ps -q "$service" || true)
    state=$([ -n "$id" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo missing)
    [ "$state" = "healthy" ] && return 0
    sleep 2
  done
  echo "$service never reported healthy (last: $state)" >&2
  return 1
}

# ONE AT A TIME, WHERE THERE ARE TWO. With `app2` already running
# (COMPOSE_PROFILES=scale in .env), recreating both at once would leave Caddy
# nothing to send to for the half minute the new image takes to boot. So the
# first is replaced and waited for while the second serves, then the second
# while the first does — and Caddy skips whichever is down (Caddyfile,
# `fail_duration`). With one app there is nobody to hand over to, and the full
# `up` below is the old behaviour unchanged. The first time `app2` is switched
# on it is not running yet, so that deploy is the ordinary one too.
if [ -n "$(docker compose ps -q --status running app2 2>/dev/null || true)" ]; then
  echo "two app processes: replacing them one at a time…"
  docker compose up -d --no-deps app
  healthy app
  docker compose up -d --no-deps app2
  healthy app2
fi

# `up -d` with no service named reconciles EVERY service against the compose
# file. It is a no-op for anything already correct, so an ordinary deploy where
# only the app image changed costs nothing extra.
docker compose up -d --remove-orphans

# Waiting is part of bringing it up, not a separate concern. `up -d` returns as
# soon as the containers are created, which is well before Postgres will accept
# a connection or the app will answer — and a migration fired at that moment
# fails against a database that was about to be ready.
echo "waiting for containers to report healthy…"
for i in $(seq 1 60); do
  unhealthy=$(docker compose ps --format '{{.Service}} {{.Health}}' \
    | awk '$2 != "healthy" && $2 != "" {print $1}' || true)
  if [ -z "$unhealthy" ]; then
    echo "all healthy after $((i * 2))s"
    exit 0
  fi
  sleep 2
done

echo "still not healthy: ${unhealthy}" >&2
docker compose ps
exit 1
