#!/usr/bin/env bash
# Creates (or with --reset, resets) a LexForgeX platform admin. Prints a one-time password.
#   sudo /opt/lexforgex/repo/infra/scripts/create-admin.sh --email you@lexforgex.com --name "Your Name" [--reset]
set -euo pipefail
exec docker compose -f /opt/lexforgex/repo/infra/docker-compose.prod.yml --env-file /etc/lexforgex/app.env run --rm admin "$@"
