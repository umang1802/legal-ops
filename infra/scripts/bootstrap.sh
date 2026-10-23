#!/bin/bash
# EC2 user data (Amazon Linux 2023, arm64 or x86_64). Runs once, as root, on first boot.
# Installs Docker + Compose/Buildx, adds swap for builds, prepares directories and a GitHub deploy key.
# Log: /var/log/cloud-init-output.log
set -euxo pipefail

COMPOSE_VERSION=v2.29.7
BUILDX_VERSION=v0.17.1

dnf -y update
dnf -y install docker git
systemctl enable --now docker

# 4 GB swap: the pnpm install + builds need more memory than the 1 GB of RAM on a 1 GB instance (t3.micro / t4g.micro); builds will be slow.
# If a build is ever killed for lack of memory, resize the instance one step up (stop, change type, start).
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Pick the Compose/Buildx downloads that match this machine's CPU (t4g = aarch64, t3 = x86_64).
case "$(uname -m)" in
  aarch64) COMPOSE_ARCH=aarch64; BUILDX_ARCH=arm64 ;;
  x86_64)  COMPOSE_ARCH=x86_64;  BUILDX_ARCH=amd64 ;;
  *) echo "unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-${BUILDX_ARCH}" \
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
