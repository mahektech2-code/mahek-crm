#!/usr/bin/env bash
#
# Run ONCE on a fresh droplet, as root. Everything here is idempotent, so
# running it twice is safe if you are unsure whether it finished.
#
#   ssh root@<ip> 'bash -s' < deploy/bootstrap.sh
#
# What it does not do: pull the image, write .env, or start anything. Those
# need secrets, and secrets do not belong in a script committed to a repo.

set -euo pipefail

APP_DIR=/opt/mahekone
SWAP_SIZE=2G

echo "==> System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# `postgresql-client`, unversioned. Ubuntu 24.04 ships 16 and there is no
# `postgresql-client-17` in its repositories, so pinning the version aborts the
# whole script on a fresh box. Nothing here needs 17: backup.sh and restore.sh
# both run pg_dump and psql INSIDE the postgres container, which is 17 by
# definition. This is only for the occasional hand-run query.
apt-get install -y -qq ca-certificates curl gnupg ufw unattended-upgrades postgresql-client-17 jq

# ---------------------------------------------------------------------- swap
#
# THE SINGLE MOST IMPORTANT LINE ON A 1 GiB BOX.
#
# Without swap, memory pressure means the kernel picks a process and kills it —
# and it tends to pick Postgres, because Postgres is the biggest thing running.
# That is a database that vanishes mid-afternoon with nothing in the app's logs
# explaining why. With swap the same pressure means things get SLOW, which is
# visible, diagnosable, and fixable on your own schedule.
#
# Slow is a problem you fix on Wednesday. A dead database is an incident.
if [ ! -f /swapfile ]; then
  echo "==> Creating ${SWAP_SIZE} swap"
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "==> Swap already present"
fi

# Prefer real memory; reach for swap only under genuine pressure. The default
# (60) would swap out pages Postgres wants while memory is still free.
sysctl -w vm.swappiness=10
sysctl -w vm.vfs_cache_pressure=50
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
grep -q '^vm.vfs_cache_pressure' /etc/sysctl.conf || echo 'vm.vfs_cache_pressure=50' >> /etc/sysctl.conf

# -------------------------------------------------------------------- docker
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "==> Docker already installed"
fi

# Container logs are the other way a 25 GiB disk fills up quietly.
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
systemctl restart docker

# ------------------------------------------------------------------ firewall
#
# Postgres is not in this list and must never be. It publishes no port to the
# host at all, so even if ufw were off it would not be reachable — this is the
# second lock on a door that is already shut.
echo "==> Firewall"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   comment 'ssh'
ufw allow 80/tcp   comment 'http, redirects to https'
ufw allow 443/tcp  comment 'https'
ufw --force enable

# ------------------------------------------------------- unattended upgrades
#
# Nobody is going to remember to patch this box. The one thing that must not be
# automatic is a reboot in the middle of the working day.
echo "==> Automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
cat > /etc/apt/apt.conf.d/52unattended-upgrades-local <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
CONF

# ----------------------------------------------------------------- app files
echo "==> ${APP_DIR}"
mkdir -p "$APP_DIR" "$APP_DIR/backups"
chmod 750 "$APP_DIR"

echo
echo "Bootstrap complete."
echo
echo "Next, from your laptop:"
echo "  1. scp docker-compose.yml Caddyfile deploy/backup.sh deploy/restore.sh root@<ip>:${APP_DIR}/"
echo "  2. Write ${APP_DIR}/.env  (see .env.production.example — chmod 600 it)"
echo "  3. Install the backup cron: bash ${APP_DIR}/backup.sh --install-cron"
echo "  4. Push to main, or run the deploy workflow by hand"
