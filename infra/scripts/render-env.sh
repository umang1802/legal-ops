#!/usr/bin/env bash
# Writes /etc/lexforgex/app.env from SSM Parameter Store (/lexforgex/prod/*). Never edit app.env by hand:
# change the parameter in SSM and redeploy. SESSION_SECRET and PLATFORM_SECRET_KEY are generated and stored
# in SSM on the first run if they don't exist yet; they are never regenerated after that.
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
PREFIX="${SSM_PREFIX:-/lexforgex/prod}"
OUT=/etc/lexforgex/app.env

get() {
  local v
  v=$(aws ssm get-parameter --region "$REGION" --name "$PREFIX/$1" --with-decryption \
        --query Parameter.Value --output text 2>/dev/null) || v=""
  [ "$v" = "None" ] && v=""
  printf '%s' "$v"
}

require() {
  local v
  v=$(get "$1")
  if [ -z "$v" ]; then echo "ERROR: SSM parameter $PREFIX/$1 is missing" >&2; exit 1; fi
  printf '%s' "$v"
}

# Generate once, store in SSM, reuse forever (rotating SESSION_SECRET signs everyone out).
ensure_secret() {
  local v
  v=$(get "$1")
  if [ -z "$v" ]; then
    v=$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 64)
    aws ssm put-parameter --region "$REGION" --name "$PREFIX/$1" --type SecureString --value "$v" --no-overwrite >/dev/null
    echo "generated $PREFIX/$1" >&2
    v=$(require "$1") # re-read: another run may have won the race
  fi
  printf '%s' "$v"
}

urlencode() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

DB_HOST=$(require DB_HOST)
DB_USER=$(require DB_USER)
DB_PASSWORD=$(require DB_PASSWORD)
DB_NAME=$(get DB_NAME); DB_NAME=${DB_NAME:-lexforgex}
APP_DOMAIN=$(require APP_DOMAIN)
EMAIL_PROVIDER=$(get EMAIL_PROVIDER); EMAIL_PROVIDER=${EMAIL_PROVIDER:-disabled}
EMAIL_FROM=$(get EMAIL_FROM); EMAIL_FROM=${EMAIL_FROM:-LexForgeX <notifications@lexforgex.com>}
SES_CONFIGURATION_SET=$(get SES_CONFIGURATION_SET)
ACME_EMAIL=$(get ACME_EMAIL); ACME_EMAIL=${ACME_EMAIL:-hello@lexforgex.com}
SESSION_SECRET=$(ensure_secret SESSION_SECRET)
PLATFORM_SECRET_KEY=$(ensure_secret PLATFORM_SECRET_KEY)

umask 077
tmp=$(mktemp "$OUT.XXXXXX")
cat > "$tmp" <<ENV
NODE_ENV=production
PORT=4000
TRUST_PROXY=1
LOG_LEVEL=info
APP_DOMAIN=$APP_DOMAIN
APP_URL=https://$APP_DOMAIN
CORS_ALLOWED_ORIGINS=https://$APP_DOMAIN
ACME_EMAIL=$ACME_EMAIL
DATABASE_URL=postgres://$(urlencode "$DB_USER"):$(urlencode "$DB_PASSWORD")@$DB_HOST:5432/$DB_NAME?sslmode=verify-full&sslrootcert=/etc/ssl/rds-global-bundle.pem
SESSION_SECRET=$SESSION_SECRET
PLATFORM_SECRET_KEY=$PLATFORM_SECRET_KEY
EMAIL_PROVIDER=$EMAIL_PROVIDER
EMAIL_FROM=$EMAIL_FROM
AWS_REGION=$REGION
ENV
[ -n "$SES_CONFIGURATION_SET" ] && echo "SES_CONFIGURATION_SET=$SES_CONFIGURATION_SET" >> "$tmp"
mv "$tmp" "$OUT"
chmod 600 "$OUT"
echo "wrote $OUT (email: $EMAIL_PROVIDER, domain: $APP_DOMAIN)"
