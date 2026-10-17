# LegalOps

Mobile-friendly practice operations for Indian litigation firms: cases, hearings, tasks, client email, billing and collections.

**Status:** Phases 1–4 complete. Built so far:

- Auth, multi-tenancy, RBAC (assigned-only matters)
- Firm settings (simple/GST tax) and team
- Clients, matters, cases, parties, courts, timeline, search
- Hearings (outcome → next date → tasks), calendar, tasks, a live dashboard
- **Billing:** invoices (simple or GST with CGST/SGST/IGST, reverse charge, pure-agent reimbursements), gapless per-FY numbering, payments across invoices with TDS and advances, reversals, credit notes, write-offs, expenses, fee agreements with milestones, collections/aging, and print-ready invoices and receipts

Next: Phase 5 (outbox worker, SES email, workflow engine, reminders). Pilot status is in [docs/pilot/](docs/pilot/).

## Read first

- [docs/decisions.md](docs/decisions.md): decisions that override the PRD (tax modes, payment allocation, client access, matter visibility, pilot)
- [docs/gap-analysis.md](docs/gap-analysis.md): spec gaps and the phase plan
- [docs/prd/](docs/prd/): original PRD, agent prompt, and the (superseded) schema

## Layout

```
apps/web             React + Vite + Tailwind. Responsive web dashboard: bottom nav < 1024px, sidebar ≥ 1024px
apps/api             Express 5 + TypeScript, /api/v1, cookie sessions
apps/worker          (Phase 5) outbox relay, scheduler, email
packages/db          SQL migrations, runner, seed, DB invariant tests
packages/types       Roles, permission matrix, API DTOs (shared by API + web)
packages/validation  Zod schemas (shared by API + web forms)
packages/ui          Design-system primitives
```

## Run locally

Prerequisites: Node 22+, pnpm 12, Docker.

```bash
pnpm install
cp .env.example .env
pnpm dev:deps     # Postgres :5433, Redis :6380, MinIO :9000
pnpm db:reset     # drop + migrate + seed (dev only; refuses in production)
pnpm dev:api      # http://localhost:4100
pnpm dev:web      # http://localhost:5190 (proxies /api to the API)
```

Ports are offset from the defaults so they don't collide with other local stacks.

### Seed logins (development only)

Firm **Sharma & Associates**; the password for all users is `LegalOps!dev2026` (see `packages/db/src/seed.ts`).

| Email               | Role    |
| ------------------- | ------- |
| partner@example.com | owner   |
| lawyer@example.com  | lawyer  |
| clerk@example.com   | staff   |
| finance@example.com | finance |

Seeded practice data includes hearings today and tomorrow, one hearing awaiting its outcome, plus overdue, due-today and upcoming tasks. It also has clients Raj Sharma, ABC Industries Pvt Ltd and Priya Verma, with three matters and cases at the Delhi High Court and Saket District Court. _Verma Property Matter_ is assigned only to the partner, so `lawyer@example.com` can't see it: that's assigned-only visibility in action.

`other-partner@example.com` owns a second firm, **Verma Legal Chambers**, for tenant-isolation checks.

## Platform admins (LegalForgeX team)

The platform console at `/platform/login` is where the LegalForgeX team invites firms, keeps payment notes, and suspends or reactivates firms. It is a separate login from any firm account, and two-factor sign-in (an authenticator app) is required.

- Create an admin: `pnpm --filter @legalops/api platform:create-admin -- --email you@legalforgex.com --name "Your Name"`. The one-time password is printed once.
- On first sign-in the console shows a key to add to an authenticator app; the first valid code completes setup.
- Lost phone or password: `… platform:create-admin -- --email you@legalforgex.com --name "Your Name" --reset` issues a new password, clears two-factor setup and signs out existing sessions.
- Production needs `PLATFORM_SECRET_KEY` (≥32 characters); it encrypts the two-factor keys.

## Commands

| Command           | What it does                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm test`       | DB invariants (against dev DB, rolled back) + unit + API integration tests (`legalops_test` DB) |
| `pnpm lint`       | ESLint                                                                                          |
| `pnpm typecheck`  | `tsc` in every package                                                                          |
| `pnpm format`     | Prettier                                                                                        |
| `pnpm build`      | API bundle (`apps/api/dist`) + web static build (`apps/web/dist`)                               |
| `pnpm db:migrate` | Apply pending migrations                                                                        |

## Security model (Phase 1)

- **Sessions:** a random 256-bit token sits in an `HttpOnly; SameSite=Lax` cookie (`Secure` in production). Only its HMAC is stored. Membership and active status are re-checked on every request, so suspending someone cuts access immediately.
- **CSRF:** mutations need `Content-Type: application/json` (cross-site forms can't send it without a CORS preflight) plus an `X-CSRF-Token` header that matches the session.
- **Tenancy:** the org comes from the session, never from the request. Composite FKs in the DB make cross-tenant references impossible.
- **Matter visibility:** decided in one place, `apps/api/src/modules/access/matter-scope.ts`.
- **Passwords:** Argon2id. Timing is equalised for unknown emails. Login and reset are rate-limited.
- **Secrets in emails:** reset and invite tokens are generated by the worker at send time, so no secret ever sits in the outbox.

## Known limitations (Phase 1)

- Emails (invites, password reset) are **queued in the outbox but not sent**: the worker and SES adapter are Phase 5. The UI says so.
- The rate-limit store is in-memory (one API instance). Move it to Redis before scaling out.
- The PWA manifest is present, but there's no service worker or offline shell yet.
- Invoices and receipts are print-ready pages (browser "Save as PDF"); server-side PDF storage is deferred.
- GST reverse-charge defaults (D-010) must be confirmed by a CA before real invoices are issued.
- Court data refresh is not connected (`NoopCourtProvider`). Case dates are entered manually, and the UI says so.
- CSV import of clients/matters/cases is Phase 6.
