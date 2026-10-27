# LexForgeX Phase 1 — Design Spec

**Date:** 2026-10-17
**Status:** Draft for review
**Codebase:** `legal-ops/` (LegalOps, Phases 1–5) — LexForgeX is a rebrand and evolution of it, not a rewrite.
**Pilot firm:** Vidhimeya

---

## 1. Intent

LexForgeX is a multi-tenant practice-management product for Indian law firms and independent lawyers. Phase 1 makes it sellable to the first handful of paying firms:

- LexForgeX's team negotiates and collects payment **offline**, then invites the firm.
- The firm onboards itself, invites its team (RBAC), adds clients and cases, assigns cases, records hearing outcomes.
- Lawyers and clients get automatic hearing reminders carrying the latest case update.
- Each firm sees its own branding on a shared LexForgeX domain.

**Success criteria**

1. A platform admin can invite a firm; its owner completes setup and creates a first case without help.
2. A hearing's internal notes can never reach a client by email.
3. For every scheduled hearing: the lead lawyer and team are reminded the day before and on the day; the client is reminded the day before and on the day; each reminder includes the latest update appropriate to the recipient.
4. A firm can hide any non-core case field without losing data; it can filter its cases by filterable fields.
5. A suspended firm can read and export everything but change nothing, and receives no reminders; reactivation sends nothing stale.
6. Every screen carries the firm's logo and accent colour; the product name shown everywhere is LexForgeX.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| L-01 | Evolve `legal-ops`; do not rebuild | Phases 1–5 already cover tenancy, RBAC, clients, matters/cases, hearings, tasks, billing, automations (103 API tests green, typecheck clean on 2026-10-17). |
| L-02 | No self-signup, no trial, no payment gateway in Phase 1 | Payment is negotiated manually; a platform admin invites the firm after payment. |
| L-03 | Platform super-admin is a **separate auth realm in the same app** | Separate `platform_admins` table, session cookie, login URL and API namespace. Firm users can never hold platform power; platform admins never hold a firm session. TOTP 2FA mandatory. |
| L-04 | Platform tooling = invite + suspend/reactivate + notes + field-request inbox + audit log | Suspension is the only enforcement lever while billing is manual; notes stand in for a billing system. |
| L-05 | White-label = **firm branding only** on a shared domain | Logo, accent colour, email sender name, reply-to; "Powered by LexForgeX". No custom domains, no resellers. |
| L-06 | Case form = **code-defined comprehensive master form**, per case type | Firms can only **hide** non-core fields/sections (data retained). New fields are requested in-app and added to the master form for everyone in a release. No firm-side field builder. |
| L-07 | Extra case fields stored in **one JSONB column** (`cases.details`) validated against the code registry | No migration per field; GIN index for filters, targeted expression indexes for hot filters. |
| L-08 | Filtering and search on master-form fields | Fields flagged `filterable` appear as list filters; text fields are searchable. |
| L-09 | **No automated court-data fetch** in Phase 1 | No official eCourts API; open-source scrapers bypass the portal CAPTCHA (legal/ToS risk) and break on portal changes. CNR field + "eCourts ↗" deep link only. The existing `CourtDataProvider` adapter stays for Phase 2. |
| L-10 | Hearing update split into **internal note** and **client summary** | Today `hearings.outcome` is emailed to clients verbatim. Client emails use only `client_summary`, falling back to a neutral line. |
| L-11 | Firm record created at invite time with status `invited` | Reuses the existing `invitations` table and accept-invite flow (an owner-role invitation). |
| L-12 | Suspended firms' due reminders are **skipped and recorded**, not deferred | Prevents a burst of stale reminders on reactivation. |
| L-13 | Logos: PNG/JPG only, ≤ 1 MB | SVG can carry script and is not rendered by Gmail/Outlook. |
| L-14 | Rebrand covers user-visible surfaces only | Internal package scope `@legalops/*`, Docker project and DB name unchanged. |
| L-15 | Brand colour drives the **accent only** | Neutrals and status colours stay system-controlled so no firm colour can break legibility or disguise warnings. |

---

## 3. Data model — migration `0006_legalforgex_phase1.sql`

### 3.1 Organizations

```sql
ALTER TABLE organizations
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('invited', 'active', 'suspended')),
  ADD COLUMN suspended_at TIMESTAMPTZ,
  ADD COLUMN suspended_reason TEXT,
  ADD COLUMN platform_notes TEXT,                 -- never returned by firm APIs
  ADD COLUMN logo_document_id UUID,               -- FK to documents (org-scoped composite)
  ADD COLUMN brand_color CHAR(7) CHECK (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN email_sender_name VARCHAR(120),
  ADD COLUMN email_reply_to CITEXT;
```

- Existing orgs default to `active`.
- `organizations.settings` gains:
  - `caseForm: { hiddenFields: string[], hiddenSections: string[] }`
  - `onboarding: { completedSteps: string[], dismissedChecklist: boolean }`
- Firm APIs must never select `platform_notes`, `suspended_reason` (firm sees a generic banner).

### 3.2 Platform realm

```sql
CREATE TABLE platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  password_hash TEXT NOT NULL,                    -- Argon2id, as firm users
  totp_secret_enc TEXT,                           -- encrypted at rest; NULL until enrolled
  totp_enrolled_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform_sessions (                  -- mirrors sessions: only the HMAC is stored
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_admin_id UUID NOT NULL REFERENCES platform_admins(id),
  token_hmac TEXT NOT NULL UNIQUE,
  mfa_verified_at TIMESTAMPTZ,                    -- NULL = password-only, platform APIs refuse
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip INET, user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform_audit_logs (                -- append-only (trigger, as audit_logs)
  id BIGSERIAL PRIMARY KEY,
  platform_admin_id UUID NOT NULL REFERENCES platform_admins(id),
  action VARCHAR(60) NOT NULL,                    -- firm.invited, firm.suspended, ...
  organization_id UUID REFERENCES organizations(id),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- Platform admins are created by a CLI script only (`pnpm platform:create-admin`); there is no platform signup.
- Platform session cookie name differs from the firm cookie; shorter idle timeout (30 min) and absolute lifetime (12 h).

### 3.3 Firm invitations

No new table. A platform invite inserts:
1. `organizations` row with `status='invited'`, `name` from the invite form.
2. `invitations` row with `role='owner'`, `invited_by = NULL`, and a new nullable column `invited_by_platform_admin_id UUID REFERENCES platform_admins(id)`.

`CHECK (invited_by IS NULL OR invited_by_platform_admin_id IS NULL)`.

### 3.4 Cases

```sql
ALTER TABLE cases ADD COLUMN details JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX idx_cases_details_gin ON cases USING gin (details jsonb_path_ops);
```

- `case_type` becomes a closed set: `civil, criminal, writ, arbitration, consumer, family, revenue, labour, tax, company, other`.
  - Migration maps existing free-text values case-insensitively by keyword; unmatched → `other` with the original text preserved in `details.legacy_case_type`.
  - Then `ALTER TABLE cases ADD CONSTRAINT ck_cases_case_type CHECK (case_type IN (...))`.
- Hot filters get expression indexes as identified during build (e.g. `(details->>'police_station')`); start with none beyond GIN and add only with evidence.

### 3.5 Field requests

```sql
CREATE TABLE field_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  requested_by UUID NOT NULL REFERENCES users(id),
  case_type VARCHAR(30),                          -- NULL = all case types
  field_label VARCHAR(160) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'added', 'declined')),
  platform_reply TEXT,
  resolved_by UUID REFERENCES platform_admins(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.6 Hearings

```sql
ALTER TABLE hearings ADD COLUMN client_summary TEXT;
```

- `hearings.outcome` is reinterpreted as the **internal note**. It is never used by a client-audience template.
- Backfill: `client_summary` stays NULL for all existing hearings. Old internal text is never promoted to client-facing.

### 3.7 Workflows

- Two new system default workflows (§5.5).
- The one-time `defaultWorkflowsSeeded` flag is replaced by `settings.seededWorkflowKeys: string[]`. Seeding inserts only defaults whose key is **not** in that list, then appends the keys. Effect: each default is offered to a firm exactly once — new defaults reach existing firms, and a default a firm deliberately deleted never comes back.
- Migration initialises `seededWorkflowKeys` for every org that has `defaultWorkflowsSeeded = true` with the 13 existing keys. The two new keys are added lazily at the firm's next event (`ensureDefaultsOnce`), and newly added hearing recipes are then planned against every upcoming scheduled hearing (`planUpcomingHearings`), so the existing calendar is covered (D-013).

### 3.8 Storage

- Logos stored via the existing `documents` table, `document_type='firm_logo'`.
- `StorageAdapter` interface (`put`, `getSignedUrl`/`stream`, `delete`): `LocalDiskStorage` (dev) and `S3Storage` (prod), selected by env.
- Emails reference the logo by a long-lived public URL (served by an unauthenticated `GET /public/logos/:orgId/:hash` that streams only `firm_logo` documents). Content-hash in URL for cache busting.

---

## 4. Code-defined master form

### 4.1 Registry

`packages/types/src/case-form.ts` — single source of truth, consumed by API validation and the web form.

```ts
type FieldType = 'text' | 'longtext' | 'number' | 'date' | 'select' | 'multiselect' | 'boolean' | 'currency' | 'person';

type FieldDef = {
  key: string;                 // snake_case, stable forever; stored in cases.details
  label: string;
  type: FieldType;
  section: string;             // section key
  caseTypes: CaseType[] | 'all';
  core?: boolean;              // locked: cannot be hidden (core fields are real columns, not details)
  filterable?: boolean;
  searchable?: boolean;        // text types only
  options?: { value: string; label: string }[];   // select/multiselect
  help?: string;
};

type SectionDef = { key: string; label: string; caseTypes: CaseType[] | 'all'; order: number };
```

- **Core fields** (real columns, always shown, cannot be hidden): case type, title, court, case number, CNR, status, lead lawyer (via `matter_staff`), client (via matter), next hearing date (derived).
- **Rules**
  - A field key, once released, is never renamed or reused. Removal = mark `deprecated: true` (hidden everywhere, data kept).
  - API rejects unknown keys and wrong types (`422 validation_failed` with field path).
  - Values for hidden fields and for fields of a different case type are **preserved** on update; the API merges `details` rather than replacing it.

### 4.2 Content

The registry ships with a comprehensive Indian master form: shared sections (filing, stage, opposing counsel, valuation/fees, limitation) plus a section per case type (e.g. Criminal: FIR number, FIR date, police station, sections invoked, bail status; Arbitration: tribunal composition, seat, institution, claim value; Consumer: forum level, complaint value). **The content must be reviewed by a practising lawyer (Vidhimeya) before release** — this is a gating dependency, not a code task.

### 4.3 Firm configuration

- `GET/PUT /api/v1/organization/case-form` — returns registry + firm's hidden lists; PUT accepts `{ hiddenFields, hiddenSections }`. Rejects core keys. Permission: `organization.manage`.
- Hidden fields are excluded from the form, detail view and filter options, but **included in exports**.

### 4.4 Field requests

- Firm: `POST /api/v1/field-requests`, `GET /api/v1/field-requests` (own firm). Permission: `organization.manage`.
- On create: email to the platform inbox address (`PLATFORM_NOTIFY_EMAIL` env) and listed in the platform console.
- Platform: `GET /api/v1/platform/field-requests`, `PATCH /api/v1/platform/field-requests/:id` `{ status, reply }`.

### 4.5 List filters and search

- `listMattersSchema` gains `caseType` and `details` filters: `details[<key>]=<value>` for select/boolean (equality via `details @> '{...}'`), `details[<key>][from|to]` for dates/numbers.
- Only `filterable` and non-hidden keys accepted; others → 422.
- Search extends to `searchable` text fields in `details`.

---

## 5. Flows

### 5.1 Firm invite → onboarding

1. Platform admin submits **Invite firm** (`firm name`, `partner name`, `partner email`).
   - Creates `organizations(status='invited')` + owner `invitations` row, valid 7 days; sends invite email; writes `platform_audit_logs(firm.invited)`.
   - **Resend:** new token, previous token voided, expiry reset. **Revoke:** invitation revoked; organization remains `invited` and can be re-invited to a corrected email.
2. Partner opens link (`/accept-invite?token=…`):
   - New email → set name + password.
   - Email already a LexForgeX user → "Sign in to accept"; on success the firm is added to their org switcher.
   - In one transaction: invitation accepted, membership `owner` created, organization → `active`, default workflows and templates seeded. Double-accept is a no-op returning the existing state.
3. First login as owner of a firm whose onboarding is incomplete → `/setup` wizard:
   1. Firm details (name prefilled; legal name, address, state, GSTIN, tax mode)
   2. Branding (logo, colour, sender name, reply-to) — skippable
   3. Invite team — skippable
   4. Done
   Progress in `settings.onboarding.completedSteps`; resumable. Non-owners never see the wizard.
4. Dashboard shows a **Getting started** checklist (first client → first case → first hearing) until complete or dismissed.

### 5.2 Suspension

- **Suspend** (`reason` required) → `status='suspended'`, `suspended_at`, `suspended_reason`, audit entry.
- **Enforcement** — one middleware on the firm API router, after tenant resolution:
  - Any non-`GET`/`HEAD` request for a suspended org → `403 { code: 'firm_suspended' }`.
  - Allow-list: `POST /auth/logout`, `POST /auth/switch-organization`. Exports and print pages are `GET` and therefore unaffected.
  - Login still works; `/auth/me` exposes `organization.status` so the web app renders the banner and disables create/edit controls.
- **Worker:** `stillValid()` gains an org-status check; due actions for a suspended org are marked `skipped` with reason `Firm suspended`. Immediate (event-driven) actions are likewise skipped.
- **Reactivate** → `status='active'`, clear `suspended_*`, audit entry. Only actions due after reactivation fire (existing `STALE_GRACE_MS` logic already drops anything older than one hour).
- `invited` orgs: no member can log in to them (no members exist until acceptance).

### 5.3 Case form

- Create/edit case is a **full page** (`/cases/new`, `/cases/:id/edit`): case type first; then shared sections + that type's section, minus hidden; core fields required, others optional.
- Changing case type on an existing case shows: "Fields specific to {old type} will be hidden but kept." No data deleted.
- Case detail renders a card per non-empty, non-hidden section; CNR shows an **eCourts ↗** link to the public case-status page.

### 5.4 Hearing outcome

- Record outcome sheet: **Internal note** (team only) · **Update for client** (optional; hint "Emailed to the client") · **Next date**.
- Client-audience templates may use `{{hearing.client_summary}}` and the `previous.*` client-safe variables (`previous.date`, `previous.client_update`, `previous.client_update_phrase`). Team-only variables (`hearing.outcome`, `previous.internal_note`, `previous.internal_note_phrase`) are stripped before any client render and rejected when saving a client template.
- Neutral fallback when client summary is blank: "The hearing on {date} was adjourned." or "The hearing on {date} was held." The next date is stated by the template itself. The outcome email is sent only when a next date is recorded (default automation condition); the client summary also appears in the next hearing's reminders.

### 5.5 Reminder matrix (defaults; firm-editable times in Automations)

| Key | When | To | Content |
|---|---|---|---|
| `hearing_1d_team` *(new)* | Day before, 17:00 | Lead + matter team | Hearing details, last internal note, last client update |
| `hearing_1d_client` | Day before, 09:00 | Client | Hearing details, last client update |
| `hearing_morning_client` *(new)* | Day of, 07:30 | Client | "Your hearing is today at {court}" + details |
| `hearing_morning_lead` | Day of, 08:00 | Lead | Hearing details, last internal note, last client update |

- "Last update" = the most recent completed hearing on the same case.
- Existing 7-day and 3-day reminders remain.
- Reschedule/cancel handling is already implemented (engine cancels and re-plans on `HEARING_CHANGED`/`HEARING_CANCELLED`; `stillValid` re-checks the date at send time). No change needed beyond the suspension check.
- Templates `hearing_reminder_client` and `hearing_reminder_internal` updated to include the last-update blocks.

---

## 6. Screens

### 6.1 Platform console (`/platform/*`)

Distinct dark shell headed "LexForgeX Platform".

- **Login → TOTP** (enrolment forced on first login; QR + manual key; 6-digit verify).
- **Firms list:** name, status chip, owner, users, cases, last activity; search; **Invite firm**.
- **Firm detail:** status history, owner, counts, invitation (resend/revoke), **Notes** (autosave), **Suspend/Reactivate** (reason dialog).
- **Field requests:** inbox across firms; mark Added/Declined with reply.
- **Audit log:** filter by firm, admin, action.

### 6.2 Firm app — new

- **Accept invite** (extended for owner invites and existing users).
- **Setup wizard** `/setup`.
- **Settings → Branding:** logo upload (PNG/JPG ≤ 1 MB), colour picker with contrast guard (auto white/dark on-accent text; warning below WCAG AA 4.5:1 for text on the accent), sender name, reply-to, live preview of sidebar and sample email.
- **Settings → Case form:** tab per case type; sections and fields with show/hide toggles; core fields locked with tooltip; **Request a field**; "My requests" with status and platform reply.
- **Settings → Email templates:** list; editor with merge-field palette filtered by audience; preview against a real case; test-send to self; reset to default.
- **Dashboard → Approvals:** client emails awaiting approval; preview; Approve / Edit & approve / Reject; count badge in sidebar.

### 6.3 Firm app — changed

- Case create/edit: sheet → full page with sticky section index (desktop) / single scroll (mobile).
- Case detail: section cards from registry; eCourts link.
- Case list: filter bar with removable chips.
- Record outcome sheet: three fields.
- Suspended: global banner; create/edit controls disabled with tooltip.
- Branding: logo in sidebar, invoices, receipts, emails; firm accent colour applied to primary buttons, active nav, links; "Powered by LexForgeX" footer. Login page stays LexForgeX-branded.

### 6.4 Rebrand

Replace user-visible "LegalOps" with "LexForgeX": `index.html` title, app shell, auth pages, email layout/footers, print pages, README, docs. Package scope and infra names unchanged (L-14).

### 6.5 Design consistency

All new screens use `packages/ui` components and existing tokens. A dedicated visual design pass follows once tracks 1–7 are verified in the browser (track 8).

---

## 7. API surface summary

| Area | Endpoints |
|---|---|
| Platform auth | `POST /api/v1/platform/auth/login`, `POST …/totp/enroll`, `POST …/totp/verify`, `POST …/logout`, `GET …/me` |
| Platform firms | `GET/POST /api/v1/platform/firms`, `GET/PATCH /api/v1/platform/firms/:id` (notes), `POST …/:id/suspend`, `POST …/:id/reactivate`, `POST …/:id/invitation/resend`, `POST …/:id/invitation/revoke`, `POST …/:id/invitation` (re-invite) |
| Platform other | `GET/PATCH /api/v1/platform/field-requests[/:id]`, `GET /api/v1/platform/audit-logs` |
| Firm onboarding | `GET/PATCH /api/v1/organization/onboarding` |
| Branding | `PATCH /api/v1/organization` (colour, sender, reply-to), `PUT/DELETE /api/v1/organization/logo`, `GET /public/logos/:orgId/:hash` |
| Case form | `GET/PUT /api/v1/organization/case-form`, `POST/GET /api/v1/field-requests` |
| Invitations | `POST /api/v1/organization/members/invitations/:id/resend`, `…/revoke` (firm-side gap) |
| Existing, changed | `POST /cases`, `PATCH /cases/:id` (details, case_type enum); `GET /matters` (filters); `POST /hearings/:id/complete` (client_summary); templates render (audience-scoped context) |

Platform routes are mounted on a separate router with its own session middleware; it never runs the firm tenant middleware, and the firm router never accepts a platform cookie.

---

## 8. Error handling

- `firm_suspended` (403) — web shows banner and a toast on any blocked action; no retry.
- `validation_failed` (422) — field-path errors for `details.*`, rendered inline on the full-page form.
- Invite token expired/revoked/used → dedicated page with "Ask LexForgeX for a new invite".
- Logo upload: wrong type/size → 422 with message; storage failure → 503, existing logo unchanged.
- Platform session without MFA → 401 `mfa_required`; web redirects to TOTP step.
- Email send failures: existing retry/backoff in the notifications module; failed client updates remain visible in Communication centre.

---

## 9. Testing

Follow existing patterns: Vitest + supertest API integration tests (one server per file), SQL invariant tests in `packages/db/tests`, browser verification of every new/changed screen via the preview tooling.

1. **Realm isolation:** platform cookie → every firm route 401; firm cookie → every platform route 401; platform session without MFA → 401 on all platform routes except TOTP endpoints.
2. **Suspension sweep:** enumerate the Express router's registered non-GET firm routes and assert each returns `firm_suspended` for a suspended org (allow-list excepted). New routes are covered automatically.
3. **Suspension + worker:** due reminder during suspension → `skipped / Firm suspended`; reactivation sends nothing stale.
4. **Invites:** expiry; resend voids old token; revoke; existing-user accept; double-accept idempotent; org → `active` exactly once; defaults seeded once.
5. **Case form:** unknown key → 422; wrong type → 422; hidden-field values preserved across update; case-type change preserves values; filter correctness for select/date/boolean; cross-tenant `details` filter/search returns nothing from other firms; core keys cannot be hidden.
6. **Hearing → client:** rendered client email never contains internal note text (including firm-edited templates attempting `{{hearing.outcome}}`); neutral fallback; migration backfill leaves `client_summary` NULL.
7. **Reminder matrix:** all four default reminders fire at the right firm-local time via the dev tick clock; content per audience; reschedule moves them; backfill idempotent and adds keys to pre-existing orgs.
8. **Branding:** contrast-guard unit tests; upload type/size limits; public logo route serves only `firm_logo` documents.
9. **Invariants (SQL):** `platform_audit_logs` append-only; `case_type` check; invitation inviter XOR check.

---

## 10. Build order

| # | Track | Notes |
|---|---|---|
| 0 | User commits Phases 1–5 | Prerequisite; clean base |
| 1 | Hearing client-summary split + reminder matrix + workflow backfill | Fixes live privacy risk |
| 2 | Platform realm: admins, sessions, TOTP, org status, invite, suspend, console UI | Unblocks onboarding |
| 3 | Accept-invite extension + setup wizard + getting-started checklist + firm invite resend/revoke | |
| 4 | Case form: registry + content, `details`, `case_type` migration, full-page form, detail, settings page, filters, field requests | Largest; content needs lawyer review |
| 5 | Branding: storage adapter, logo, colour/contrast, branded email layout, theming, print pages | |
| 6 | Phase 5 leftovers: approvals UI, template editor (audience-scoped merge fields), browser verification of Communication + Automations, D-012 doc | |
| 7 | User-visible rebrand | |
| 8 | Visual design pass | After browser review of tracks 1–7 |

Each track ends with tests green, typecheck/lint clean, and browser verification of its screens.

---

## 11. Out of scope (Phase 1)

Payment gateway, subscriptions, trials · self-signup · automated court-data fetch · custom domains, resellers · WhatsApp · firm-side field builder · client portal · native mobile app · internal package/infra rename.

## 12. External dependencies

1. Master-form content review by a practising lawyer (Vidhimeya).
2. SES: verified sending domain (DKIM/SPF), production access out of sandbox.
3. S3 bucket and credentials for logo storage.
4. `PLATFORM_NOTIFY_EMAIL` inbox for field requests.
