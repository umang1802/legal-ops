# Deployment handoff: LexForgeX app to AWS

**From:** Umang (with Claude Code), 20 Oct 2026
**To:** Aakash (with Claude Code)
**Goal:** get `https://app.lexforgex.com` live on AWS for the pilot. The pilot firm is Vidhimeya, with real client data.

Read this first, then `infra/docs/deploy-runbook.md`, which has the step-by-step instructions.

---

## 1. Where things stand

### Done and live
| Item | State |
|---|---|
| **Product name** | **LexForgeX** (domain `lexforgex.com`). The code still says "LegalOps" or "LegalForgeX" in places; the user-visible rename is planned work (Track 7). |
| **AWS account** | A new, dedicated account for LexForgeX. Region **ap-south-1 (Mumbai)** for everything except the CloudFront certificate (us-east-1). |
| **Domain** | `lexforgex.com`, registered at **GoDaddy**, with **DNS at GoDaddy**. GoDaddy email MX records sit on the root domain; don't remove them. |
| **Marketing site** | Live at **https://www.lexforgex.com**: S3 (private bucket) behind CloudFront `d3ssyoikxjjvrg.cloudfront.net`, ACM certificate in us-east-1 for `lexforgex.com` + `www`. The bare `lexforgex.com` is a GoDaddy 301 forward to www; it currently forwards to `http://`, and should be changed to `https://`. Source: `Eduforgex/lexforgex-web/`, not yet a git repo. |
| **SES** | Domain identity `lexforgex.com` in ap-south-1, Easy DKIM (3 CNAMEs) + custom MAIL FROM `mail.lexforgex.com` (MX + SPF). DNS checked correct. DMARC is GoDaddy's default (`p=quarantine`); a duplicate was removed. |
| **SES production access** | **Requested; AWS asked for details; the reply has been sent. Waiting.** See section 4 for what was promised. |
| **Code** | Tracks 1 and 2 are merged to `main` (PR #1, `5ca528b`): hearing updates and reminders, plus the platform admin console with TOTP and firm suspension. 163 API tests and 27 DB invariants pass. |

### Built but not deployed
- **Deployment files** on branch **`feature/aws-deploy`** in `umang1802/legal-ops`. They're uncommitted on Umang's machine; Umang will commit and merge.
  - `infra/docker/Dockerfile`: target `app` runs the API, worker and tools in one image; target `web` is Caddy with the web build.
  - `infra/docker-compose.prod.yml`: `api`, `worker`, `caddy`, plus one-off `migrate` and `admin` (profile `tools`).
  - `infra/caddy/Caddyfile`: auto-HTTPS for `$APP_DOMAIN`, `/api` and `/health` forwarded to the API, SPA fallback, cache headers, security headers.
  - `infra/scripts/bootstrap.sh`: EC2 user data. Installs Docker, Compose v2.29.7 and Buildx v0.17.1, adds 2 GB swap and a GitHub deploy key.
  - `infra/scripts/render-env.sh`: builds `/etc/lexforgex/app.env` from SSM `/lexforgex/prod/*` and generates `SESSION_SECRET` and `PLATFORM_SECRET_KEY` on first run.
  - `infra/scripts/deploy.sh`: fetch → render env → build → **migrate** → up → health check. Takes a branch or a commit (for rollback).
  - `infra/scripts/create-admin.sh`: creates the platform admin.
  - `infra/iam/lexforgex-app-policy.json`: SSM read and put on `/lexforgex/prod/*`, KMS via SSM, SES send.
- **Smoke-tested locally** with the production Compose file:
  - the images build on ARM
  - migrations apply
  - `/health/ready` is OK
  - Caddy serves the SPA and `/api` over TLS, with HSTS and nosniff
  - the admin script creates an admin
  - platform login works through the proxy (cookie `Secure`, path `/api/v1/platform`)

### Not started (that's you)
Runbook **Stages 1–9**: IAM role → security groups → RDS → SSM parameters → EC2 + Elastic IP → GoDaddy `app` A record → first deploy → first admin → email.

---

## 2. Architecture and decisions (already agreed; please don't re-open without Umang)

- **One EC2 `t4g.small`** (Amazon Linux 2023, arm64) running Docker Compose, plus **RDS PostgreSQL 16 `db.t4g.micro`**, single-AZ, private, encrypted, 7-day backups, deletion protection on. Budget is about $35–45 a month, with a budget alert at $60.
- **Secrets only in SSM Parameter Store** under `/lexforgex/prod/`. **Nobody edits `/etc/lexforgex/app.env` by hand**; it's regenerated on every deploy. *(This comes from EduForgeX, where the server's `.env` drifted from git.)*
- **No SSH.** Port 22 is closed and there's no key pair; admin access is through **SSM Session Manager**. Only 80 and 443 are open.
- **The server builds images itself**, pulling the private repo with a **read-only GitHub deploy key** generated on the box. There's no CI or ECR yet; GitHub Actions comes later.
- **Same origin is required.** The web app calls a relative `/api/v1`, and session cookies plus CSRF assume one origin. Keep the API and the SPA behind one hostname, which is what Caddy does.
- **The database connection** uses `sslmode=verify-full` with the RDS global CA bundle, which is baked into the image at `/etc/ssl/rds-global-bundle.pem`. RDS PG 16 forces SSL anyway.
- **Umang wants to do AWS changes through the console UI.** If you use the CLI, that's your call, but keep the runbook's resource names so the docs stay true: `lexforgex-app-role`, `lexforgex-app-sg`, `lexforgex-db-sg`, `lexforgex-prod` (RDS and EC2).

---

## 3. Next steps, in order

0. **Get `feature/aws-deploy` merged to `main`.** The server clones `main`, and the scripts live in the repo.
1. Follow `infra/docs/deploy-runbook.md`, Stages 1–8.
2. Add the GoDaddy **A record `app` → the Elastic IP before the first deploy**, or Caddy can't get its certificate. It retries, but it's quicker if DNS is already in place.
3. After the first deploy, check:
   - `https://app.lexforgex.com/health/ready` shows `{"database":"ok"}`
   - `https://app.lexforgex.com/platform/login` lets you sign in, with TOTP set up on first login
   - `sudo docker compose -f /opt/lexforgex/repo/infra/docker-compose.prod.yml --env-file /etc/lexforgex/app.env ps` shows api (healthy), worker and caddy
4. **Keep `EMAIL_PROVIDER=disabled`** until section 4 is done and SES is out of sandbox mode.
5. Hand Umang the platform admin login, or have Umang run `create-admin.sh` for themselves.

---

## 4. Promises made to AWS in the SES production-access reply (must be true before client emails go out)

AWS was told:
1. **The SES account-level suppression list is on** for bounces and complaints. Check: SES → Configuration → Suppression list.
2. **A configuration set publishes bounce, complaint and delivery events to SNS. The app consumes them and marks the address undeliverable**, so no further emails go to it.
   - **This is not built yet.** It needs a configuration set and an SNS topic, an HTTPS subscription to a new API endpoint (verify SNS signatures), and the code that marks the client or user email undeliverable and skips future sends. Then set `SES_CONFIGURATION_SET` in SSM.
   - The current code: `SesEmailProvider` in `apps/api/src/modules/notifications/providers.ts` already accepts a configuration set, and there's a `notification_events` table.
3. **CloudWatch alarms at a 3% bounce rate and a 0.05% complaint rate.** Not created yet.
4. **Client emails include a "to stop these emails, reply or contact the firm" footer**, and the sender shows the firm, e.g. "Sharma & Associates via LexForgeX". Not built yet: it's a template and footer change in `apps/api/src/modules/templates/render.ts` (`emailLayout`), and the sender name needs per-firm support (Track 5).

Items 2–4 are code and ops work, separate from the infrastructure deploy. Treat them as **blocking for switching `EMAIL_PROVIDER` to `ses`**, but not for the deploy itself.

---

## 5. Gotchas we hit (save yourself the time)

- **GoDaddy DNS Name field:** enter only the part before `.lexforgex.com`, e.g. `_abc._domainkey`, `_xyz.www`, `app`. Pasting the full name doubles the domain.
- **GoDaddy won't allow a CNAME on `@`.** The bare domain uses Forwarding. If we ever want the root on CloudFront or the app directly, move DNS to Route 53 first, and copy the MX and SES records across.
- **Never delete** any of these:
  - the ACM validation CNAMEs (AWS uses them for automatic renewal)
  - the 3 SES DKIM CNAMEs
  - the `mail` MX and TXT records
  - `_dmarc`
  - the GoDaddy MX records on the root
- **CloudFront alternate domain names** didn't stick in the creation wizard the first time; we had to add them under General → Settings → Edit. If `www` ever shows a TLS "unrecognized name" error, check there first.
- **`SESSION_SECRET` must never change** once set: changing it signs everyone out. **`PLATFORM_SECRET_KEY` must never change either**: changing it makes every platform admin's TOTP setup undecryptable. `render-env.sh` only generates them when they're missing.
- **The DB tools refuse `reset` and `seed` when `NODE_ENV=production`.** `deploy.sh` only runs `migrate`.
- **Migrations are forward-only.** Roll back code only to a commit that works with the current schema: `deploy.sh <commit>`.
- **Product name:** use **LexForgeX** in anything new. Some log lines still say "LegalOps"; that's harmless, and the rename is Track 7.

---

## 6. After go-live (for awareness, not part of this handoff)

- The bounce and complaint pipeline, alarms and email footer (section 4).
- Uptime alerting: health-check alarm plus worker-stalled alarm.
- A restore drill from RDS backup, and a staging copy.
- **Website demo form:** it currently opens a `mailto:` to `hello@lexforgex.com`, so make sure that mailbox exists. A real form endpoint can come later.
- Product roadmap: `docs/superpowers/plans/2026-10-17-legalforgex-phase1-roadmap.md`, Tracks 3–8. Spec: `docs/superpowers/specs/2026-10-17-legalforgex-phase1-design.md`.
