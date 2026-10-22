# LexForgeX: deploying the app to AWS (console runbook)

Target: `https://app.lexforgex.com` on one EC2 server in **ap-south-1 (Mumbai)**, with PostgreSQL running in a container on the same server, its data in a Docker volume on the server's encrypted root disk. There is no RDS (changed 22 Oct 2026; see `infra/docs/HANDOFF.md`). Secrets live in SSM Parameter Store, and admin access is through Session Manager (no SSH).

```
Internet ──443──► EC2 t4g.micro (Elastic IP) ─ Docker Compose
                   ├─ caddy   HTTPS (Let's Encrypt), serves the web app, proxies /api
                   ├─ api       Node API
                   ├─ worker    reminders and email
                   └─ postgres  PostgreSQL 16, private Docker network only (no published port)
                         │ data in a Docker volume on the encrypted root disk
                         ▼
                  Backups (to set up): daily EBS snapshots + nightly pg_dump to S3
Secrets: SSM Parameter Store /lexforgex/prod/*   Email: SES (ap-south-1)
```

Expected cost is about **$14 a month**. Do every step in **ap-south-1** unless a step says otherwise.

> **Progress (22 Oct 2026):** Stages 1–2 are done (IAM role, security groups). Stage 3 changed: RDS was dropped in favour of Postgres on the EC2 server, so there is nothing to create in AWS for it. The repo's Compose file and scripts are updated for it but have not yet been run end to end; do the backup items in `infra/docs/HANDOFF.md` ("Database change status") before real client data goes in. Resource IDs and decisions are in HANDOFF, "Deployment progress".

---

## Stage 1: IAM role for the server

1. **IAM → Roles → Create role**.
   - Trusted entity: **AWS service**. Use case: **EC2** → **Next**.
   - Attach **AmazonSSMManagedInstanceCore**. This allows Session Manager, the browser terminal → **Next**.
   - Role name: `lexforgex-app-role` → **Create role**.
2. Open `lexforgex-app-role` → **Add permissions → Create inline policy** → **JSON** tab.
   - Paste the contents of `infra/iam/lexforgex-app-policy.json`. It lets the server read and create its own SSM parameters and send email through SES.
   - **Next** → name `lexforgex-app-access` → **Create policy**.

## Stage 2: Security groups (firewall)

**EC2 → Security Groups → Create security group** (VPC: the default VPC):

| Name | Inbound rules | Outbound |
|---|---|---|
| `lexforgex-app-sg` | HTTP 80 from `0.0.0.0/0` and `::/0`; HTTPS 443 from `0.0.0.0/0` and `::/0` | All (default) |
| ~~`lexforgex-db-sg`~~ | **No longer needed** (it was for RDS). If it was created (`sg-0e719cadc62dba35f`), delete it once nothing refers to it. | |

There's no SSH rule: port 22 stays closed. Nothing opens port 5432: Postgres is reachable only inside the server's Docker network.

## Stage 3: Database (Postgres on the server)

Nothing to create in the AWS console for this stage. PostgreSQL 16 runs as a container (`postgres`) in the Docker Compose stack on the EC2 server. Its data lives in a Docker volume (`lexforgex_pgdata`) on the server's single encrypted root disk. There is no separate data disk, to keep things simple and cheap, so **losing the instance means losing the database unless backups exist**.

- The database port is never published and port 5432 is not opened in any security group. Only the `api`, `worker` and one-off tool containers can reach it, over the private Docker network.
- There is no managed backup or point-in-time restore. Backups are to be set up as daily EBS snapshots (7 kept) plus a nightly `pg_dump` to a private, encrypted S3 bucket. **Set these up, and test a restore, before real client data goes in** (HANDOFF, "Database change status").
- The previous design used RDS (`lexforgex-prod`, `db.t4g.micro`). It was deleted on 22 Oct 2026 before holding any data. Check the RDS console in ap-south-1 shows no instances, snapshots or other leftovers.

## Stage 4: Parameters (SSM Parameter Store)

**Systems Manager → Parameter Store → Create parameter**, once per row. Tier: Standard.

| Name | Type | Value |
|---|---|---|
| `/lexforgex/prod/DB_HOST` | String | *Optional.* Defaults to `postgres` (the Compose service name). Skip it. |
| `/lexforgex/prod/DB_USER` | String | *Optional.* Defaults to `lexforgex_admin`. Skip it. |
| `/lexforgex/prod/DB_PASSWORD` | SecureString | **Don't create it.** The first deploy generates it. If you already made one, it must be letters and digits only. **Never change it after the first deploy** |
| `/lexforgex/prod/DB_NAME` | String | *Optional.* Defaults to `lexforgex`. Skip it. |
| `/lexforgex/prod/APP_DOMAIN` | String | `app.lexforgex.com` |
| `/lexforgex/prod/EMAIL_PROVIDER` | String | `disabled` for now (Stage 9 switches it to `ses`) |
| `/lexforgex/prod/EMAIL_FROM` | String | `LexForgeX <notifications@lexforgex.com>` |
| `/lexforgex/prod/ACME_EMAIL` | String | an inbox you read, for HTTPS certificate notices |

**Don't create** `SESSION_SECRET`, `PLATFORM_SECRET_KEY` or `DB_PASSWORD`. The first deploy generates strong random values and stores them here as SecureStrings, so nobody ever types or sees them.

## Stage 5: The server (EC2)

**EC2 → Instances → Launch instances**:
- Name: `lexforgex-prod`
- AMI: **Amazon Linux 2023**, architecture **64-bit (Arm)**
- Instance type: **t4g.micro** (1 GB RAM; if the first build is killed for lack of memory, stop the instance, change the type to `t4g.small`, and start it again. The Elastic IP and disk stay as they are)
- Key pair: **Proceed without a key pair**. Access is through Session Manager.
- Network settings → **Edit**: default VPC, any subnet, **Auto-assign public IP: Enable**. Select existing security group **`lexforgex-app-sg`**.
- Storage: one **30 GiB gp3** root volume (it holds the OS, Docker images and the database). Under Advanced, set **Encrypted: Yes** and **Delete on termination: No**, so the database isn't lost if the instance is terminated by mistake. No second volume.
- **Advanced details**:
  - **IAM instance profile:** `lexforgex-app-role`
  - **Metadata version:** V2 only (token required)
  - **User data:** paste the whole of `infra/scripts/bootstrap.sh`
- **Launch instance**.

Then **EC2 → Elastic IPs → Allocate Elastic IP address → Allocate**, select it → **Actions → Associate** → instance `lexforgex-prod` → **Associate**. Note the IP.

## Stage 6: DNS (GoDaddy)

Add a record: **Type A**, **Name `app`**, **Value: the Elastic IP**, TTL 1 hour. Don't touch the other records.

Caddy requests the HTTPS certificate on first start, and that only succeeds once `app.lexforgex.com` points at the server. Add this record before Stage 7.

## Stage 7: First deploy (Session Manager, in the browser)

**EC2 → Instances → `lexforgex-prod` → Connect → Session Manager → Connect.** A terminal opens in the browser. Paste each command and press Enter.

1. Check first-boot setup finished. It should print `LexForgeX bootstrap complete`; if not, wait a minute and retry.
   ```bash
   cat /opt/lexforgex/BOOTSTRAPPED
   ```
2. Show the deploy key's public half:
   ```bash
   sudo cat /root/.ssh/lexforgex_deploy.pub
   ```
   Copy the whole line. In **GitHub → `umang1802/legal-ops` → Settings → Deploy keys → Add deploy key**: title `lexforgex-prod`, paste the key, **leave "Allow write access" unticked** → **Add key**.
3. Fetch the code:
   ```bash
   sudo git clone git@github.com:umang1802/legal-ops.git /opt/lexforgex/repo
   ```
4. Deploy (the first build takes about 5–8 minutes):
   ```bash
   sudo /opt/lexforgex/repo/infra/scripts/deploy.sh
   ```
   It ends with `==> deployed <commit>` and a table of three running services (api, worker, caddy).

## Stage 8: First admin, then check it works

1. Create your platform admin. It prints a one-time password; store it in your password manager.
   ```bash
   sudo /opt/lexforgex/repo/infra/scripts/create-admin.sh --email you@lexforgex.com --name "Your Name"
   ```
2. Open **https://app.lexforgex.com/platform/login**, sign in, and set up two-factor sign-in with your authenticator app.
3. Open **https://app.lexforgex.com/health/ready**. It should show `"database":"ok"`.

## Stage 9: Turn on email (after SES approves production access)

1. Optional test while SES is still in sandbox mode: verify your own email address in SES and send yourself a test.
2. **Before sending to real clients**, set up bounce and complaint handling. This is a follow-up task in the repo (SES configuration set, SNS topic, app endpoint, CloudWatch alarms).
3. In Parameter Store, change `/lexforgex/prod/EMAIL_PROVIDER` to `ses`, then redeploy:
   ```bash
   sudo /opt/lexforgex/repo/infra/scripts/deploy.sh
   ```

---

## Day-to-day

| Task | How |
|---|---|
| Deploy the latest `main` | `sudo /opt/lexforgex/repo/infra/scripts/deploy.sh` |
| Deploy another branch | `sudo /opt/lexforgex/repo/infra/scripts/deploy.sh feature/x` |
| See running services | `sudo docker compose -f /opt/lexforgex/repo/infra/docker-compose.prod.yml --env-file /etc/lexforgex/app.env ps` |
| Recent API logs | same command with `logs --tail 200 api` (or `worker`, `caddy`) |
| Change a setting | edit the parameter in SSM, then redeploy. **Never edit `/etc/lexforgex/app.env` by hand**; it's rewritten on every deploy. |
| Roll back | `sudo git -C /opt/lexforgex/repo log --oneline -10` to find the last good commit, then `sudo /opt/lexforgex/repo/infra/scripts/deploy.sh <commit>`. Migrations only move forward, so roll back only to a version that works with the current database schema. |
| Reset an admin's password or 2FA | `sudo …/create-admin.sh --email … --name … --reset` |
| Restore the database | No managed restore. Restore from the latest `pg_dump` in S3, or from a root-volume snapshot. Procedure to be written and tested during the restore drill (HANDOFF, "Database change status"). |

## Safety notes

- `NODE_ENV=production` makes the database tools refuse to `reset` or `seed`. Deploy only ever runs `migrate`.
- `SESSION_SECRET` must never change once set: changing it signs everyone out. `PLATFORM_SECRET_KEY` must never change either: changing it makes every platform admin's two-factor setup unusable.
- Postgres isn't reachable from the internet: its port is not published on the server and no security group opens 5432. Only the app containers can connect, over the private Docker network. The root disk is encrypted and set not to delete on termination.
- Never run `docker volume prune`, `docker system prune --volumes` or `docker compose down -v` on the server: they delete the database. And never change `DB_PASSWORD` after the first deploy.
