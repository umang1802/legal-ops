#!/bin/bash
# EC2 user data (Amazon Linux 2023, arm64). Runs once, as root, on first boot.
# Installs Docker + Compose/Buildx, adds swap for builds, prepares directories and a GitHub deploy key.
# Log: /var/log/cloud-init-output.log
set -euxo pipefail

COMPOSE_VERSION=v2.29.7
BUILDX_VERSION=v0.17.1

dnf -y update
dnf -y install docker git
systemctl enable --now docker

# 2 GB swap: the pnpm install + builds need more than the 2 GB of RAM on a t4g.small.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-aarch64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-arm64" \
  -o /usr/local/lib/docker/cli-plugins/docker-buildx
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-buildx

mkdir -p /opt/lexforgex /etc/lexforgex
chmod 700 /etc/lexforgex

# Read-only GitHub deploy key. Its public half is added to the repo's Deploy keys (see the runbook).
install -d -m 700 /root/.ssh
if [ ! -f /root/.ssh/lexforgex_deploy ]; then
  ssh-keygen -t ed25519 -N '' -C 'lexforgex-prod-deploy' -f /root/.ssh/lexforgex_deploy
fi
cat > /root/.ssh/config <<'CFG'
Host github.com
  IdentityFile /root/.ssh/lexforgex_deploy
  IdentitiesOnly yes
CFG
chmod 600 /root/.ssh/config
ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts

echo 'LexForgeX bootstrap complete' > /opt/lexforgex/BOOTSTRAPPED
