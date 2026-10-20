#!/usr/bin/env bash
# Deploys LexForgeX on the EC2 host. Run in Session Manager:  sudo /opt/lexforgex/repo/infra/scripts/deploy.sh [branch|commit]
# No argument deploys the latest main. A commit hash deploys exactly that commit (use it to roll back).
# Order: fetch code → render env from SSM → build images → migrate the database → start/replace services → health check.
# Migrations run BEFORE new code starts, so a failed migration leaves the running version untouched.
set -euo pipefail

REPO=/opt/lexforgex/repo
REF="${1:-main}"
ENV_FILE=/etc/lexforgex/app.env
COMPOSE=(docker compose -f "$REPO/infra/docker-compose.prod.yml" --env-file "$ENV_FILE")

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
cd "$REPO"

echo "==> fetching $REF"
git fetch --prune origin
if git rev-parse -q --verify "origin/$REF^{commit}" >/dev/null; then TARGET="origin/$REF"; else TARGET="$REF"; fi
git checkout -q --detach "$TARGET"
REV=$(git rev-parse --short HEAD)
echo "    at $REV: $(git log -1 --format=%s)"

echo "==> rendering environment from SSM"
"$REPO/infra/scripts/render-env.sh"

echo "==> building images (a few minutes)"
docker build -f infra/docker/Dockerfile --target app -t "lexforgex-app:$REV" -t lexforgex-app:latest .
docker build -f infra/docker/Dockerfile --target web -t "lexforgex-web:$REV" -t lexforgex-web:latest .

echo "==> migrating the database"
"${COMPOSE[@]}" run --rm migrate

echo "==> starting services"
"${COMPOSE[@]}" up -d --remove-orphans

echo "==> waiting for the API to report healthy"
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T api wget -qO- http://127.0.0.1:4000/health/ready >/dev/null 2>&1; then
    echo "    healthy"
    "${COMPOSE[@]}" ps
    docker image prune -f >/dev/null
    echo "==> deployed $REV"
    exit 0
  fi
  sleep 5
done
echo "API did not become healthy. Logs:" >&2
"${COMPOSE[@]}" logs --tail 80 api >&2
exit 1
