# syntax=docker/dockerfile:1
# LexForgeX production images. Built on the server by infra/scripts/deploy.sh.
#   target "app": API, worker and one-off tools (migrations, admin CLI) — one image, different commands
#   target "web": Caddy serving the web build and proxying /api to the API

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @legalops/api build && pnpm --filter @legalops/web build

FROM node:22-alpine AS app
ENV NODE_ENV=production
WORKDIR /repo
# Amazon RDS CA bundle, so the database connection verifies the server certificate (sslmode=verify-full).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
COPY --from=build /repo /repo
USER node
CMD ["node", "apps/api/dist/server.js"]

FROM caddy:2.8.4-alpine AS web
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv/web
