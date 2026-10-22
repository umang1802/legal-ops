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
  - `infra/scripts/bootstrap.sh`: EC2 user data. Installs Docker, Compose v2.29.7 and Buildx v0.17.1, adds 4 GB swap and a GitHub deploy key.
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

### Deployment progress (updated 22 Oct 2026 by Aakash, with Claude Code)

AWS resources were created through the console, using the runbook names. Status below was reported by Aakash after doing each stage; it has **not** been independently re-checked by a tool. First step for whoever picks this up: open the console in ap-south-1 and confirm each resource exists as described.

| Stage | What | Status | Notes |
|---|---|---|---|
| 0 | `feature/aws-deploy` merged to `main` | **Done** | Deploy files are on `main` (`1114f7b`, `0544406`) |
| 1 | IAM role `lexforgex-app-role` + inline policy `lexforgex-app-access` | **Done** | Role has `AmazonSSMManagedInstanceCore`; inline policy is `infra/iam/lexforgex-app-policy.json` |
| 2 | Security groups | **Done** | `lexforgex-app-sg` = `sg-0430154b8d0211b3b` (80 and 443 from the internet, no 22). `lexforgex-db-sg` = `sg-0e719cadc62dba35f` was for RDS and is **now unused**: delete it once confirmed nothing refers to it (not deleted yet) |
| 3 | Database | **Changed: no separate AWS resource** | RDS was created and **deleted on 22 Oct 2026** (it never held data). Postgres now runs in Docker Compose on the EC2 server, with its data in a Docker volume on the root disk. Repo changes are made (22 Oct 2026, not yet tested end to end); see "Pending work" |
| 4 | SSM parameters under `/lexforgex/prod/` | **Next** | Only `APP_DOMAIN`, `EMAIL_PROVIDER`, `EMAIL_FROM` and `ACME_EMAIL` are needed. The database parameters are optional: `DB_HOST`/`DB_USER`/`DB_NAME` default to `postgres`/`lexforgex_admin`/`lexforgex`, and `DB_PASSWORD` is **generated on the first deploy**. If you already created `DB_PASSWORD` as a SecureString it is used, but it must be letters and digits only. Do **not** create `SESSION_SECRET` or `PLATFORM_SECRET_KEY` |
| 5 | EC2 `lexforgex-prod` (`t4g.micro`, 30 GiB encrypted root disk) + Elastic IP | Not started | Billable. `bootstrap.sh` swap raised to 4 GB for the small instance. If the first build is killed for lack of memory, resize to `t4g.small`. Backups should be in place before real client data goes in, not before launch |
| 6 | GoDaddy A record `app` → Elastic IP | Not started | Add before the first deploy |
| 7 | First deploy over Session Manager | Not started | Needs the deploy key added in GitHub |
| 8 | First platform admin and checks | Not started | |
| 9 | Email | **Blocked on purpose** | Keep `EMAIL_PROVIDER=disabled` until section 4 below is built and SES production access is granted |

**Constraints still in force:** single EC2 with Postgres on the same server (no RDS), secrets only in SSM, no SSH (Session Manager only), `EMAIL_PROVIDER=disabled`. Ask Umang before changing any of these. Ask the owner before any billable or destructive change that the runbook doesn't list (for example reserved instances, a bigger instance, deleting a volume or snapshot).

**Decisions made along the way**
- Ports 80 and 443 are open to the internet on purpose: users reach the app on 443, and Caddy needs 80 for certificate issuance and the HTTPS redirect. The IPv6 (`::/0`) rules are optional because the server only has an IPv4 Elastic IP.
- Moved from EC2 + RDS to EC2-only on 22 Oct 2026 (agreed with Umang, per Aakash): about 5 pilot users, and it saves roughly $15 a month. Instance is `t4g.micro` (1 GB RAM), chosen by Aakash on 22 Oct 2026 for cost; it was `t4g.small` in the original plan. Image builds run on the server and are the tight spot, so `bootstrap.sh` adds 4 GB of swap. Fallback if builds or queries run short of memory: resize to `t4g.small`, then `t4g.medium` (stop, change type, start; the Elastic IP and disk stay).
- Estimated monthly cost, approximate, ap-south-1 on-demand (check with the AWS Pricing Calculator): EC2 `t4g.micro` about $7, root EBS 30 GiB about $3, snapshots and S3 dumps about $1, public IPv4 (Elastic IP) about $3.65. **Total about $14.** Every public IPv4 address is billed, even when attached.

### Database change status (EC2-only) and pending work

**Done in the repo on 22 Oct 2026 (uncommitted; not yet run end to end, because Docker was not available where it was written):**
- `infra/docker-compose.prod.yml`: new `postgres:16-alpine` service with a named volume `pgdata`, a healthcheck and **no published port**. `api`, `worker`, `migrate` and `admin` wait for it to be healthy. It reads only `/etc/lexforgex/db.env`, so it does not see the app's other secrets.
- `infra/scripts/render-env.sh`: also writes `/etc/lexforgex/db.env`; `DATABASE_URL` points at host `postgres` with `sslmode=disable`; `DB_HOST`, `DB_USER`, `DB_NAME` default; `DB_PASSWORD` is generated once and stored in SSM like the other secrets. Tested with a fake `aws` command: first run generates, second run keeps the same password, an unsafe password is rejected, both files are mode 600.
- `infra/docker/Dockerfile`: removed the RDS CA bundle download.
- `infra/scripts/bootstrap.sh`: **no change needed** (no separate data disk).

**Still to do:**
1. **First real test.** Run the full stack once with Docker (locally with the prod Compose file as Umang did, or on the new server) and check migrations apply, `/health/ready` shows `"database":"ok"`, and the admin script works. Fix anything that breaks.
2. **Never change `DB_PASSWORD` after the first deploy.** Postgres only reads it when it creates its data directory; changing it later locks the app out. Never run `docker volume prune`, `docker system prune --volumes` or `docker compose down -v` on the server: they delete the database. (`deploy.sh` only uses `docker image prune`, which is safe.)
3. **Backups** (required before real client data): a Data Lifecycle Manager policy for daily snapshots of the root volume (7 kept), plus a nightly `pg_dump` to a private, encrypted S3 bucket. The S3 copy needs a bucket and extra permissions in `infra/iam/lexforgex-app-policy.json`. Both are small billable resources: confirm with the owner before creating them.
4. **Restore drill:** restore a backup into a throwaway database and check the app starts against it, before the pilot firm's data goes in.
5. **Root disk:** if the instance is terminated, a root disk with "delete on termination" on takes the database with it. The runbook sets it to No for that reason, but backups (item 3) are the real protection.
6. **Postgres updates:** minor versions come from re-pulling the image (`docker compose ... pull postgres` then `up -d postgres`). Do this occasionally; it is not automatic.
7. **Cleanup:** delete the unused security group `lexforgex-db-sg` (`sg-0e719cadc62dba35f`) once nothing refers to it. Check no RDS snapshot or other RDS leftovers remain in ap-south-1 that still bill.

### Remaining work (Stages 4–9)
Runbook **Stages 4–9**: SSM parameters → EC2 + Elastic IP → GoDaddy `app` A record → first deploy → first admin → email.

---

## 2. Architecture and decisions (already agreed; please don't re-open without Umang)

- **One EC2 `t4g.micro`** (Amazon Linux 2023, arm64) running Docker Compose, **including PostgreSQL 16 in a container on the same server** (EC2-only, no RDS). The database files live in a Docker volume (`lexforgex_pgdata`) on the server's **single encrypted 30 GiB gp3 root disk** (no separate data disk, to keep it simple and cheap). Backups (still to be set up) are daily EBS snapshots plus nightly `pg_dump` copies to an encrypted S3 bucket. Budget is about **$14 a month** (was $35–45 with RDS), with a budget alert at $60.
  - **Changed 22 Oct 2026:** the original design was EC2 + RDS (`db.t4g.micro`). Umang agreed to move the database onto the EC2 server, to save about $15 a month; the pilot is about 5 users. RDS `lexforgex-prod` was created and then deleted by Aakash on 22 Oct 2026, before any data was loaded.
  - **Trade-offs accepted:** no managed point-in-time restore, no automatic Postgres patching, and the app and database fail together if the instance dies. Backups and a tested restore are therefore required before real client data goes in (see "Database change status" below).
  - If load grows, move to `t4g.medium` (4 GB) or back to RDS. Ask Umang first.
- **Secrets only in SSM Parameter Store** under `/lexforgex/prod/`. **Nobody edits `/etc/lexforgex/app.env` by hand**; it's regenerated on every deploy. *(This comes from EduForgeX, where the server's `.env` drifted from git.)*
- **No SSH.** Port 22 is closed and there's no key pair; admin access is through **SSM Session Manager**. Only 80 and 443 are open.
- **The server builds images itself**, pulling the private repo with a **read-only GitHub deploy key** generated on the box. There's no CI or ECR yet; GitHub Actions comes later.
- **Same origin is required.** The web app calls a relative `/api/v1`, and session cookies plus CSRF assume one origin. Keep the API and the SPA behind one hostname, which is what Caddy does.
- **The database connection** (EC2-only design): the app reaches Postgres at host `postgres` over the private Docker network. The database port is **never published** on the host, so nothing outside the container network, including the internet, can reach it. TLS inside that private network is not used. The old `sslmode=verify-full` + RDS CA bundle setup (`infra/docker/Dockerfile` line 17, `infra/scripts/render-env.sh` line 64) no longer applies and is to be removed (see "Database change status").
- **Umang wants to do AWS changes through the console UI.** If you use the CLI, that's your call, but keep the runbook's resource names so the docs stay true: `lexforgex-app-role`, `lexforgex-app-sg`, `lexforgex-prod` (EC2). `lexforgex-db-sg` was for RDS and is no longer used (see below).

---

## 3. Next steps, in order

0. **Get `feature/aws-deploy` merged to `main`.** The server clones `main`, and the scripts live in the repo.
1. Follow `infra/docs/deploy-runbook.md`. Stages 1–2 are done and Stage 3 changed to EC2-only (see "Deployment progress" above). Continue from **Stage 4**, then Stages 5–8, and do the "Database change status" backup items before real client data goes in.
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
- A restore drill from the EBS snapshot and `pg_dump` backups (needed before real client data; see "Database change status"), and a staging copy.
- **Website demo form:** it currently opens a `mailto:` to `hello@lexforgex.com`, so make sure that mailbox exists. A real form endpoint can come later.
- Product roadmap: `docs/superpowers/plans/2026-10-17-legalforgex-phase1-roadmap.md`, Tracks 3–8. Spec: `docs/superpowers/specs/2026-10-17-legalforgex-phase1-design.md`.
