# LexForgeX: deploying the app to AWS (console runbook)

Target: `https://app.lexforgex.com` on one EC2 server in **ap-south-1 (Mumbai)**, with PostgreSQL running in a container on the same server, its data in a Docker volume on the server's encrypted root disk. There is no RDS (changed 22 Oct 2026; see `infra/docs/HANDOFF.md`). Secrets live in SSM Parameter Store, and admin access is through Session Manager (no SSH).

```
Internet ──443──► EC2 t3.micro (Elastic IP) ─ Docker Compose
                   ├─ caddy   HTTPS (Let's Encrypt), serves the web app, proxies /api
                   ├─ api       Node API
                   ├─ worker    reminders and email
                   └─ postgres  PostgreSQL 16, private Docker network only (no published port)
                         │ data in a Docker volume on the encrypted root disk
                         ▼
                  Backups (to set up): daily EBS snapshots + nightly pg_dump to S3
Secrets: SSM Parameter Store /lexforgex/prod/*   Email: SES (ap-south-1)
```

Expected cost is about **$16–17 a month**. Do every step in **ap-south-1** unless a step says otherwise.

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

Before you start: Stage 4 is done, and `infra/scripts/bootstrap.sh` on `main` is the version with the 4 GB swap. Check the region selector (top right) says **Asia Pacific (Mumbai) ap-south-1**.

**Copy the user-data script first** (macOS; run from the repo folder). It puts the whole of `bootstrap.sh` on your clipboard, including the first line `#!/bin/bash`, which must stay:
```bash
pbcopy < infra/scripts/bootstrap.sh
```

**EC2 → Instances → Launch instances**, then fill in the page top to bottom:

| Section | What to choose |
|---|---|
| **Name and tags** | Name: `lexforgex-prod` |
| **Application and OS Images** | Quick Start tab **Amazon Linux** → **Amazon Linux 2023 AMI**. Architecture: **64-bit (x86)**, matching the instance that was actually launched. (If you ever choose a `t4g` type instead, pick **64-bit (Arm)** to match; an image and an instance type must have the same CPU type. `bootstrap.sh` handles both.) |
| **Instance type** | **t3.micro** (1 GB RAM, x86). If the first build is later killed for lack of memory, stop the instance, change the type to `t3.small` (same CPU type; you can't switch between x86 and Arm on an existing instance), and start it again; the Elastic IP and disk stay as they are. A `t4g.micro` (Arm) is about $2–3 a month cheaper if you ever rebuild. |
| **Key pair (login)** | **Proceed without a key pair (Not recommended)**. This is intended: there is no SSH, access is through Session Manager. |
| **Network settings → Edit** | VPC: the **default VPC**. Subnet: **No preference**. **Auto-assign public IP: Enable**. Firewall: **Select existing security group** → `lexforgex-app-sg` (and nothing else). Do not add an SSH rule. |
| **Configure storage** | One root volume: **30 GiB**, type **gp3**. Open **Advanced** and set **Encrypted: Yes** (default KMS key is fine) and **Delete on termination: No**. Do **not** add a second volume. |
| **Advanced details** | **IAM instance profile:** `lexforgex-app-role`. **Metadata version:** **V2 only (token required)**. **Termination protection:** **Enable** (free; stops an accidental terminate). **Detailed CloudWatch monitoring:** leave off (it costs extra). Leave the credit specification at its default. **User data:** paste the script (Cmd+V). Leave "User data has already been base64 encoded" unticked. |

Check the **Summary** panel on the right: 1 instance, `t3.micro`, the right security group. Then **Launch instance**.

**After launch**
1. Wait until **Instance state = Running** and **Status check = 2/2 checks passed** (a few minutes).
2. Wait a few more minutes. The first-boot script installs Docker and makes the swap file, then writes `/opt/lexforgex/BOOTSTRAPPED`. It can't be checked from the console; you check it in Stage 7.
3. Select the instance → **Connect → Session Manager**. The **Connect** button is enabled once the SSM agent has registered (it can take 2–5 minutes after launch). If it stays greyed out, check that the instance has the `lexforgex-app-role` profile (**Actions → Security → Modify IAM role**).

**Elastic IP.** **EC2 → Elastic IPs → Allocate Elastic IP address → Allocate**, select it → **Actions → Associate Elastic IP address** → Resource type **Instance**, choose `lexforgex-prod` → **Associate**. Note the IP address. (The temporary public IP the instance got at launch is released when you do this. An Elastic IP costs about $3.65 a month.)

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

## Stage 10: Matter documents (S3 bucket)

Uploaded case papers and orders are stored in a private S3 bucket. The browser uploads straight to S3 using short-lived signed links, so files never pass through the server. Until this stage is done, the app runs with document upload switched off: the Documents tab loads, and uploads fail with "Document storage isn’t set up on this server yet".

Cost: S3 storage is about $0.025 per GB a month in Mumbai; 50 GB of papers is about $1.25 a month.

1. **S3 → Create bucket** (region **ap-south-1**).
   - Name: `lexforgex-prod-documents`. If the name is taken, choose another, and use the same name in steps 4 and 6.
   - Object Ownership: **ACLs disabled**. **Block all public access: on** (all four boxes).
   - Bucket Versioning: **Disable**. The app never overwrites a file, and deleting in the app is a soft delete.
   - Default encryption: **SSE-S3**, Bucket Key enabled → **Create bucket**.
2. Open the bucket → **Permissions → Cross-origin resource sharing (CORS) → Edit**, paste, **Save**:
   ```json
   [
     {
       "AllowedOrigins": ["https://app.lexforgex.com"],
       "AllowedMethods": ["PUT", "GET"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   `ETag` must be exposed: the browser reads it from each uploaded part to finish the upload.
3. **Management → Create lifecycle rule**: name `abort-incomplete-uploads`, scope **Apply to all objects** (tick the acknowledgement), action **Delete expired object delete markers or incomplete multipart uploads** → tick **Delete incomplete multipart uploads**, days `1` → **Create rule**. This clears parts left by uploads that were abandoned midway (closed tab, lost connection), which S3 otherwise bills for indefinitely.
4. **Permissions → Bucket policy → Edit**: refuse any non-HTTPS access. Replace the bucket name if you changed it:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "HttpsOnly",
         "Effect": "Deny",
         "Principal": "*",
         "Action": "s3:*",
         "Resource": ["arn:aws:s3:::lexforgex-prod-documents", "arn:aws:s3:::lexforgex-prod-documents/*"],
         "Condition": { "Bool": { "aws:SecureTransport": "false" } }
       }
     ]
   }
   ```
5. **IAM → Roles → `lexforgex-app-role` → `lexforgex-app-access` → Edit → JSON**: paste the current `infra/iam/lexforgex-app-policy.json` (it adds the `MatterDocuments` statement) → **Save**. If you changed the bucket name, change it in the `MatterDocuments` resource too.
6. **Parameter Store → Create parameter**: `/lexforgex/prod/S3_BUCKET`, String, value `lexforgex-prod-documents`.
7. **Let the containers use the server's role.** The API runs inside Docker, which adds a network hop to the instance metadata service. **EC2 → Instances → `lexforgex-prod` → Actions → Instance settings → Modify instance metadata options**: keep IMDSv2 **Required** and set **Metadata response hop limit** to `2` → **Save**. If it already says 2, leave it.
8. Redeploy (Session Manager):
   ```bash
   sudo /opt/lexforgex/repo/infra/scripts/deploy.sh
   ```
   The output ends with `documents: lexforgex-prod-documents`.
9. Check: in the app, open a matter → **Documents → Upload**, add a PDF of more than 16 MB (it then uploads in several parts), wait for the tick, then click its name to view it. If the upload fails, the API log (`logs --tail 200 api`, see Day-to-day) names the cause: `AccessDenied` means step 5 or 6; `Could not load credentials` means step 7. If the browser console shows a CORS error, check step 2.

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
