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
| **Product name** | **LexForgeX** (domain `lexforgex.com`). User-visible text now says LexForgeX everywhere (rename done 27 Oct 2026). Internal names stay as they are on purpose: the `@legalops/*` package scope, the repo name, file paths and the dev seed password. |
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
  - the images build on ARM (the server is x86, so the first x86 build and run happens on the server; if anything differs, that is where it will show)
  - migrations apply
  - `/health/ready` is OK
  - Caddy serves the SPA and `/api` over TLS, with HSTS and nosniff
  - the admin script creates an admin
  - platform login works through the proxy (cookie `Secure`, path `/api/v1/platform`)

### Deployment progress (updated 23 Oct 2026 by Aakash, with Claude Code)

AWS resources were created through the console, using the runbook names. Status below was reported by Aakash after doing each stage; it has **not** been independently re-checked by a tool. First step for whoever picks this up: open the console in ap-south-1 and confirm each resource exists as described.

| Stage | What | Status | Notes |
|---|---|---|---|
| 0 | `feature/aws-deploy` merged to `main` | **Done** | Deploy files are on `main` (`1114f7b`, `0544406`) |
| 1 | IAM role `lexforgex-app-role` + inline policy `lexforgex-app-access` | **Done** | Role has `AmazonSSMManagedInstanceCore`; inline policy is `infra/iam/lexforgex-app-policy.json` |
| 2 | Security groups | **Done** | `lexforgex-app-sg` = `sg-0430154b8d0211b3b` (80 and 443 from the internet, no 22). `lexforgex-db-sg` = `sg-0e719cadc62dba35f` was for RDS and is **now unused**: delete it once confirmed nothing refers to it (not deleted yet) |
| 3 | Database | **Changed: no separate AWS resource** | RDS was created and **deleted on 22 Oct 2026** (it never held data). Postgres now runs in Docker Compose on the EC2 server, with its data in a Docker volume on the root disk. Repo changes are made (22 Oct 2026, not yet tested end to end); see "Pending work" |
| 4 | SSM parameters under `/lexforgex/prod/` | **Done** | `APP_DOMAIN`, `EMAIL_PROVIDER` (`disabled`), `EMAIL_FROM`, `ACME_EMAIL`. `DB_PASSWORD`, `SESSION_SECRET` and `PLATFORM_SECRET_KEY` are generated by the first deploy. Note: the server role can read parameters by name but cannot list `/lexforgex/prod` as a folder (`GetParametersByPath` is denied); that is expected and the deploy does not need it |
| 5 | EC2 `lexforgex-prod` + Elastic IP | **Done** | Instance `i-0f37263d330aa814e`, **`t3.micro` (x86_64)**, 30 GiB encrypted gp3 root, Elastic IP `13.126.25.104`, role `lexforgex-app-role`, no key pair. It was meant to be an Arm `t4g.micro`; the x86 type was launched by mistake and kept (about $2–3 a month dearer). User data was **not** set at launch, so `bootstrap.sh` was run by hand over Session Manager; the Compose and Buildx plugins were then replaced with the x86 builds. `bootstrap.sh` in the repo now picks the right download for either CPU (this change may still be uncommitted, check `git status`). Session Manager needed a reboot to connect the first time |
| 6 | GoDaddy A record `app` → `13.126.25.104` | **Done** | Resolves on public resolvers |
| 7 | First deploy over Session Manager | **Done** | GitHub deploy key `lexforgex-prod` (read-only) added to `umang1802/legal-ops`; repo cloned to `/opt/lexforgex/repo` at `a32e7bf`; `deploy.sh` ran on the x86 server. External checks on 23 Oct 2026: `https://app.lexforgex.com/` 200 with valid TLS, `/health/ready` returns `"database":"ok"`, `/platform/login` loads, HSTS and nosniff present. First successful x86 run of the stack |
| 8 | First platform admin and checks | **Done** | Admin created with `create-admin.sh`, signed in at `/platform/login`, TOTP two-factor set up. Credentials and the TOTP key are held by Aakash in a password manager; they are not in this repo. Use `create-admin.sh … --reset` to recover |
| 9 | Email | **Blocked on purpose** | Keep `EMAIL_PROVIDER=disabled` until section 4 below is built and SES production access is granted |

**Constraints still in force:** single EC2 with Postgres on the same server (no RDS), secrets only in SSM, no SSH (Session Manager only), `EMAIL_PROVIDER=disabled`. Ask Umang before changing any of these. Ask the owner before any billable or destructive change that the runbook doesn't list (for example reserved instances, a bigger instance, deleting a volume or snapshot).

**Decisions made along the way**
- Ports 80 and 443 are open to the internet on purpose: users reach the app on 443, and Caddy needs 80 for certificate issuance and the HTTPS redirect. The IPv6 (`::/0`) rules are optional because the server only has an IPv4 Elastic IP.
- Moved from EC2 + RDS to EC2-only on 22 Oct 2026 (agreed with Umang, per Aakash): about 5 pilot users, and it saves roughly $15 a month. Instance is a 1 GB-RAM micro, chosen by Aakash on 22 Oct 2026 for cost; it was `t4g.small` (Arm) in the original plan. The Arm `t4g.micro` was intended, but the instance was launched as an x86 `t3.micro` by mistake and it was kept (Aakash's choice, 23 Oct 2026): about $2–3 a month dearer than `t4g.micro`, and rebuilding as Arm later is possible. Image builds run on the server and are the tight spot, so `bootstrap.sh` adds 4 GB of swap. Fallback if builds or queries run short of memory: resize to `t3.small`, then `t3.medium` (stop, change type, start; the Elastic IP and disk stay; you can't switch between x86 and Arm on an existing instance).
- Estimated monthly cost, approximate, ap-south-1 on-demand (check with the AWS Pricing Calculator): EC2 `t3.micro` about $9, root EBS 30 GiB about $3, snapshots and S3 dumps about $1, public IPv4 (Elastic IP) about $3.65. **Total about $16–17.** Every public IPv4 address is billed, even when attached.

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

### Remaining work
1. **Backups and a restore test** (see the list above). Biggest gap: the database lives only on the server's root disk.
2. **Commit and push** any uncommitted changes to `bootstrap.sh` and these docs.
3. **Firm invites and password resets don't work until email is on** (see section 5). Decide whether to build the invite-link command as a stopgap. The first invited firm's invitation is in the failed state; resend it once email works, or issue a link by hand.
   **Stage 9, email**: blocked on section 4 below (bounce and complaint handling, alarms, email footer) and SES production access. Keep `EMAIL_PROVIDER=disabled`.
4. **Cleanup:** delete the unused `lexforgex-db-sg`; confirm no RDS snapshots remain; consider a billing alert at $60 if not already set.
5. **Matter documents (S3), new 29 Oct 2026.** Vidhimeya's bulk document upload needs a private S3 bucket: runbook **Stage 10** (bucket with CORS, a lifecycle rule and an HTTPS-only policy; IAM policy update; SSM `S3_BUCKET`; IMDS hop limit 2 so the API container can use the instance role; redeploy). Billable but small (about $0.025 per GB a month). Until it's done the app runs with uploads switched off. Code is on branch `feature/documents`.
6. **Per-firm features (branch `feature/firm-features`).** The next deploy runs migration `0014_organization_features`. Nothing changes for existing firms: every current feature stays on until someone switches it off on the firm's page in the platform console (Features card). No new AWS resources or SSM parameters.
7. **Firm logo (branch `feature/firm-logo`).** The next deploy runs migration `0015_organization_logo`. Logos are stored in the existing documents bucket under `org/<id>/branding/` (uploads land in `incoming/` first). **Two small AWS changes are needed first (runbook Stage 10, steps 3 and 5):** (1) paste the updated `infra/iam/lexforgex-app-policy.json` into the role's inline policy: it adds `s3:ListBucket` on the bucket, without which S3 answers missing files with "access denied" (this also affects documents); (2) add the lifecycle rule `expire-incoming` (prefix `incoming/`, expire after 1 day). Logos are served publicly at `/api/v1/public/logos/...` through Caddy's existing `/api/*` proxy, so email apps can load them.
8. **Housekeeping noticed during the rollout:** the GoDaddy bare-domain forward still goes to `http://` (should be `https://`); product name in the platform UI still says "LexForgeX" (Track 7).

---

## 2. Architecture and decisions (already agreed; please don't re-open without Umang)

- **One EC2 `t3.micro`** (Amazon Linux 2023, x86_64) running Docker Compose, **including PostgreSQL 16 in a container on the same server** (EC2-only, no RDS). The database files live in a Docker volume (`lexforgex_pgdata`) on the server's **single encrypted 30 GiB gp3 root disk** (no separate data disk, to keep it simple and cheap). Backups (still to be set up) are daily EBS snapshots plus nightly `pg_dump` copies to an encrypted S3 bucket. Budget is about **$16–17 a month** (was $35–45 with RDS), with a budget alert at $60.
  - **Changed 22 Oct 2026:** the original design was EC2 + RDS (`db.t4g.micro`). Umang agreed to move the database onto the EC2 server, to save about $15 a month; the pilot is about 5 users. RDS `lexforgex-prod` was created and then deleted by Aakash on 22 Oct 2026, before any data was loaded.
  - **Trade-offs accepted:** no managed point-in-time restore, no automatic Postgres patching, and the app and database fail together if the instance dies. Backups and a tested restore are therefore required before real client data goes in (see "Database change status" below).
  - If load grows, move to `t3.medium` (4 GB) or back to RDS. Ask Umang first.
- **Secrets only in SSM Parameter Store** under `/lexforgex/prod/`. **Nobody edits `/etc/lexforgex/app.env` by hand**; it's regenerated on every deploy. *(This comes from EduForgeX, where the server's `.env` drifted from git.)*
- **No SSH.** Port 22 is closed and there's no key pair; admin access is through **SSM Session Manager**. Only 80 and 443 are open.
- **The server builds images itself**, pulling the private repo with a **read-only GitHub deploy key** generated on the box. There's no CI or ECR yet; GitHub Actions comes later.
- **Same origin is required.** The web app calls a relative `/api/v1`, and session cookies plus CSRF assume one origin. Keep the API and the SPA behind one hostname, which is what Caddy does.
- **The database connection** (EC2-only design): the app reaches Postgres at host `postgres` over the private Docker network. The database port is **never published** on the host, so nothing outside the container network, including the internet, can reach it. TLS inside that private network is not used. The old `sslmode=verify-full` + RDS CA bundle setup (`infra/docker/Dockerfile` line 17, `infra/scripts/render-env.sh` line 64) no longer applies and is to be removed (see "Database change status").
- **Umang wants to do AWS changes through the console UI.** If you use the CLI, that's your call, but keep the runbook's resource names so the docs stay true: `lexforgex-app-role`, `lexforgex-app-sg`, `lexforgex-prod` (EC2). `lexforgex-db-sg` was for RDS and is no longer used (see below).

---

## 3. Next steps, in order

0. **Get `feature/aws-deploy` merged to `main`.** The server clones `main`, and the scripts live in the repo.
1. Follow `infra/docs/deploy-runbook.md`. Stages 1–2 are done and Stage 3 changed to EC2-only (see "Deployment progress" above). The app is **live at https://app.lexforgex.com** (Stages 1–8 done). **Not yet safe for real client data**: set up backups and test a restore first (see "Database change status"), then handle section 4 before enabling email.
2. Add the GoDaddy **A record `app` → the Elastic IP before the first deploy**, or Caddy can't get its certificate. It retries, but it's quicker if DNS is already in place.
3. After the first deploy, check:
   - `https://app.lexforgex.com/health/ready` shows `{"database":"ok"}`
   - `https://app.lexforgex.com/platform/login` lets you sign in, with TOTP set up on first login
   - `sudo docker compose -f /opt/lexforgex/repo/infra/docker-compose.prod.yml --env-file /etc/lexforgex/app.env ps` shows api (healthy), worker and caddy
4. **Keep `EMAIL_PROVIDER=disabled`** until section 4 is done and SES is out of sandbox mode.
5. Umang should run `create-admin.sh` for themselves (it prints a one-time password and they set up TOTP at first login), or Aakash hands over a login. Don't send passwords in chat or email.

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
- **With `EMAIL_PROVIDER=disabled`, no email goes out at all, so platform invites and password resets don't arrive.** Found 23 Oct 2026 when the first firm was invited from the platform console. What happens: the invite is queued as a notification, the worker tries to send it, the disabled provider throws a retryable error, and after 5 attempts (retries at 1, 2, 4 and 8 minutes) the notification is marked **failed**. The accept-invite link is created only at send time (`issueInvitationToken` in `apps/api/src/modules/notifications/notifications.service.ts`) and is never stored or logged, so there is no link to recover. The same applies to the "forgot password" flow and to hearing reminders. Options: (a) a small admin command that mints and prints the accept-invite link for a pending invite, to be sent to the partner over a trusted channel (not built yet; whoever opens the link gets owner access to that firm, so treat it as a secret); or (b) wait until email is enabled and use **Resend invite** in the platform console. Do **not** switch `EMAIL_PROVIDER` to `ses` as a shortcut: see section 4, and SES sandbox only delivers to verified addresses anyway. Before enabling email later, review the notification list for old queued items so nothing stale goes to a real client.
- **Product name:** use **LexForgeX** in anything new. The rename is done; internal package names (`@legalops/*`) still say legalops on purpose.

---

## 6. After go-live (for awareness, not part of this handoff)

- The bounce and complaint pipeline, alarms and email footer (section 4).
- Uptime alerting: health-check alarm plus worker-stalled alarm.
- A restore drill from the EBS snapshot and `pg_dump` backups (needed before real client data; see "Database change status"), and a staging copy.
- **Website demo form:** it currently opens a `mailto:` to `hello@lexforgex.com`, so make sure that mailbox exists. A real form endpoint can come later.
- Product roadmap: `docs/superpowers/plans/2026-10-17-legalforgex-phase1-roadmap.md`, Tracks 3–8. Spec: `docs/superpowers/specs/2026-10-17-legalforgex-phase1-design.md`.
