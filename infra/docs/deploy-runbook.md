# LexForgeX: deploying the app to AWS (console runbook)

Target: `https://app.lexforgex.com` on one EC2 server in **ap-south-1 (Mumbai)**, with a private RDS Postgres database. Secrets live in SSM Parameter Store, and admin access is through Session Manager (no SSH).

```
Internet ──443──► EC2 t4g.small (Elastic IP) ─ Docker Compose
                   ├─ caddy   HTTPS (Let's Encrypt), serves the web app, proxies /api
                   ├─ api     Node API
                   └─ worker  reminders and email
                         │ 5432 (private, TLS)
                         ▼
                  RDS PostgreSQL 16 (db.t4g.micro, encrypted, 7-day backups)
Secrets: SSM Parameter Store /lexforgex/prod/*   Email: SES (ap-south-1)
```

Expected cost is about **$35–45 a month**. Do every step in **ap-south-1** unless a step says otherwise.

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
| `lexforgex-db-sg` | PostgreSQL 5432, **source = `lexforgex-app-sg`** (select the security group, not an IP) | All (default) |

There's no SSH rule: port 22 stays closed.

## Stage 3: Database (RDS)

**RDS → Create database**:
- **Standard create**, engine **PostgreSQL**, version **16.x** (latest 16).
- Template: **Free tier** if offered, otherwise **Dev/Test**. Then set:
  - Deployment: **Single-AZ DB instance**
  - DB instance identifier: `lexforgex-prod`
  - Master username: `lexforgex_admin`
  - Credentials management: **Self managed**, tick **Auto generate password**
  - Instance class: **db.t4g.micro** (Burstable)
  - Storage: **gp3, 20 GiB**. Under Storage autoscaling, set maximum **100 GiB**.
  - Connectivity:
    - **Don't connect to an EC2 compute resource**
    - VPC: default
    - **Public access: No**
    - Security group: remove `default`, choose **`lexforgex-db-sg`**
  - Database authentication: **Password authentication**
  - **Additional configuration**:
    - Initial database name: **`lexforgex`**
    - Backup retention: **7 days**
    - **Encryption enabled** (the default)
    - **Enable deletion protection**: ticked
- **Create database**. A banner appears: click **View credential details** and **copy the master password now**, because it's shown only once. Keep it in your password manager.
- When the status is **Available** (about 10 minutes), open the database and copy the **Endpoint**. It looks like `lexforgex-prod.xxxx.ap-south-1.rds.amazonaws.com`.

## Stage 4: Parameters (SSM Parameter Store)

**Systems Manager → Parameter Store → Create parameter**, once per row. Tier: Standard.

| Name | Type | Value |
|---|---|---|
| `/lexforgex/prod/DB_HOST` | String | the RDS endpoint from Stage 3 |
| `/lexforgex/prod/DB_USER` | String | `lexforgex_admin` |
| `/lexforgex/prod/DB_PASSWORD` | **SecureString** (KMS key: `alias/aws/ssm`) | the master password |
| `/lexforgex/prod/DB_NAME` | String | `lexforgex` |
| `/lexforgex/prod/APP_DOMAIN` | String | `app.lexforgex.com` |
| `/lexforgex/prod/EMAIL_PROVIDER` | String | `disabled` for now (Stage 9 switches it to `ses`) |
| `/lexforgex/prod/EMAIL_FROM` | String | `LexForgeX <notifications@lexforgex.com>` |
| `/lexforgex/prod/ACME_EMAIL` | String | an inbox you read, for HTTPS certificate notices |

**Don't create** `SESSION_SECRET` or `PLATFORM_SECRET_KEY`. The first deploy generates strong random values and stores them here as SecureStrings, so nobody ever types or sees them.

## Stage 5: The server (EC2)

**EC2 → Instances → Launch instances**:
- Name: `lexforgex-prod`
- AMI: **Amazon Linux 2023**, architecture **64-bit (Arm)**
- Instance type: **t4g.small**
- Key pair: **Proceed without a key pair**. Access is through Session Manager.
- Network settings → **Edit**: default VPC, any subnet, **Auto-assign public IP: Enable**. Select existing security group **`lexforgex-app-sg`**.
- Storage: **20 GiB gp3**. Under Advanced, set **Encrypted: Yes**.
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
| Restore the database | RDS → `lexforgex-prod` → **Actions → Restore to point in time** creates a new instance; point `DB_HOST` at it and redeploy. |

## Safety notes

- `NODE_ENV=production` makes the database tools refuse to `reset` or `seed`. Deploy only ever runs `migrate`.
- `SESSION_SECRET` must never change once set: changing it signs everyone out. `PLATFORM_SECRET_KEY` must never change either: changing it makes every platform admin's two-factor setup unusable.
- RDS isn't reachable from the internet; only the app server's security group can connect, over TLS, and the server checks the database's certificate.
