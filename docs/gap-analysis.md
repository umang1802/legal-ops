# LegalOps V1 — Spec Gap Analysis

**Date:** 2026-10-02
**Inputs reviewed:** `prd/legalops_v1_prd.md` (63 sections), `prd/legalops_v1_coding_agent_prompt.md`, `prd/legalops_v1_schema.sql`

The spec is unusually strong on architecture (outbox, tenancy, financial immutability, provider abstractions). Most gaps are in three places:

1. **India-specific billing reality.** GST and TDS are missing, and both decide whether invoices are usable at all.
2. **Schema shortcomings.** Tables the features depend on are missing, and some constraints contradict the spec's own invariants.
3. **Internal contradictions** between the PRD, the agent prompt and the SQL file.

Severity: **P0** = will cause wrong data, security holes or a blocked pilot. **P1** = will cause rework. **P2** = polish or clarification.

---

## A. Product / strategy gaps (honest take)

| # | Gap | Why it matters | Recommendation |
|---|---|---|---|
| A1 | **No court-data sync in V1 (Noop provider)** | Indian firms pay for automatic eCourts date tracking (existing Indian practice-management tools already sell it). Without it, the "what changed in my cases?" north star depends on a clerk typing every date. That is *more* work than the paper diary it replaces. | Before building, validate that the pilot firm will enter hearings manually. Make "next date entry after hearing" a ≤10-second mobile flow (it is the real core loop). Put a court provider into the V1.5 plan with a named source. |
| A2 | **Email-only client comms in India** | Indian litigation clients mostly reply to WhatsApp, not email, so email reminders will have low engagement. You already have a Meta-verified WhatsApp setup (EduForgeX/Lemin). | Keep V1 email-only for cost and scope, but build the `NotificationChannel` interface for real (not just a type) and schedule WhatsApp as the *first* post-pilot item, not V2. |
| A3 | **No pilot firm named; baseline metrics need 2–4 weeks before rollout (§50)** | Without a firm, the 27-screen scope gets built against guesses. | Line up the pilot firm *now*. Start baseline collection in parallel with Phase 1. |
| A4 | **Scope vs. "one agent pass"** | 28 tables, 27 screens, workflow engine, portal, imports, reports and 5 E2E suites amount to roughly 3–4 months of solo work. The prompt's "do not stop at scaffolding" in a single run will produce wide-but-shallow code. | Run phase by phase with acceptance gates (see §F). Treat Phases 1–5 as pilot-critical and Phase 6 (portal/import/reports) as pilot-optional. |
| A5 | **Portfolio focus** | This would run alongside EduForgeX, QueueCare, DPDP and CareGraph. | Decide explicitly what pauses. |
| A6 | **DPDP Act 2023** | LegalOps stores client personal data and confidential matter data, so the firm is the data fiduciary. You already have DPDP product work. | Ship V1 with data residency (ap-south-1), export, retention and deletion, and a breach-log hook. Reuse DPDP-product thinking. Make no "compliant" claims (§32 already says so). |

---

## B. Billing / finance gaps (India-specific) — **highest risk**

| # | Sev | Gap | Recommendation |
|---|---|---|---|
| B1 | P0 | **GST is a single `tax_amount` number.** A valid Indian tax invoice needs: firm GSTIN, client GSTIN (if registered), SAC code (legal services, 9982xx), place of supply, CGST/SGST vs IGST split, and a **reverse-charge (RCM) flag**. Legal services from an advocate or firm to a business entity are generally under RCM, so the *client* pays GST and the invoice must say so. | Add `organizations.gstin`, `clients.gstin` and `clients.state_code`, and per-invoice `place_of_supply`, `is_reverse_charge`, `sac_code`, `cgst/sgst/igst` amounts. Add a tax-config per org. Have a CA confirm the rules before you code them. |
| B2 | P0 | **TDS (s.194J) is not modelled.** Corporate clients deduct ~10% TDS and pay the net amount. Under the current formula every corporate invoice stays `PARTIALLY_PAID` forever. | Add `tds_amount` on payments (or a settlement-component table). Then `amountPaid = Σ(cash + TDS)`. Track TDS-certificate (Form 16A) receipt as a task. |
| B3 | P0 | **`payments.invoice_id NOT NULL`.** Retainers and advances (an explicit fee-agreement type) are received *before* any invoice exists. One cheque often settles several invoices. The prompt also asks for "payment allocation" tests, but no allocation model exists. | Add a `payment_allocations(payment_id, invoice_id, amount)` table and make `payments.invoice_id` optional. Track unallocated balance as client advance/credit. Or explicitly scope V1 to 1 payment = 1 invoice and drop the allocation tests. |
| B4 | P0 | **Invoice numbering.** `invoice_number NOT NULL` on drafts means numbers are burned on drafts that never issue. GST needs consecutive numbering, and there is no counter table, so concurrent issue creates a race. | Make the number nullable until `issue`. Assign it from an `invoice_number_sequences(org_id, fiscal_year, next_value)` row locked `FOR UPDATE`. Reset per Indian FY (Apr–Mar), e.g. `LGL/2026-27/000001`. |
| B5 | P0 | **Overdue status conflicts with partial payment.** A partially-paid invoice past its due date is both PARTIALLY_PAID and OVERDUE. Storing `OVERDUE` also needs a cron to flip it, which the spec warns against ("stale cached field"). | Store only the *lifecycle* (`draft/issued/void/written_off`). **Derive** the payment state (`unpaid/partial/paid`) and `is_overdue`, computed in a view or service. The UI shows both badges. |
| B6 | P1 | **No credit notes or adjustments.** "Issued invoices modified only through controlled adjustment flows" names a flow that has no table. WRITTEN_OFF appears in the PRD but not in the prompt. | Add a `credit_notes` table (numbered, linked to the invoice, with ledger entries). Include `written_off` in the lifecycle. |
| B7 | P1 | **Billable expenses can be double-billed.** Expenses have no link to invoice items. | Add `invoice_items.expense_id`. Mark the expense `billed` on issue. |
| B8 | P1 | **Ledger is not enforced as append-only.** Nothing stops UPDATE/DELETE on `ledger_entries` or posted `payments`. The reversal model is ambiguous: the PRD says "reversal *and replacement* entry", while the schema mutates `status/reversed_at` in place. | Add DB triggers that block UPDATE/DELETE on `ledger_entries` and block changes to amount fields on `payments`. A reversal creates a contra ledger entry plus a status flip. Any correction is a new payment. |
| B9 | P1 | **Money in JS.** `pg` returns `numeric` as a string. Rounding for `quantity × unit_price` (quantity is `numeric(10,2)`) is not specified. | Do all app-side arithmetic in integer paise (or `decimal.js`), with round-half-up at the line level. Unit-test it. |
| B10 | P2 | `fee_milestones.invoice_id` has no FK (circular). Milestone `partially_paid` duplicates invoice state. | Add a deferred FK. Derive milestone payment state from the invoice. |
| B11 | P2 | Receipts have no numbering or table. The PDF engine is unspecified. | Add receipt numbers from a sequence. Use a lightweight PDF lib (pdfkit / @react-pdf) rather than headless Chrome on the API box. |

---

## C. Schema / data-model gaps

| # | Sev | Gap | Recommendation |
|---|---|---|---|
| C1 | P0 | **Child tables lack `organization_id`.** These are `matter_staff`, `case_parties`, `case_advocates` and `invoice_items`. This contradicts rule #1 ("every tenant-owned entity"). | Add `organization_id` to all of them. |
| C2 | P0 | **No cross-tenant FK integrity.** `matters.client_id` can point at a client in *another* org, and so can every other FK. App code is the only guard. | Add `UNIQUE (organization_id, id)` on parent tables. Use composite FKs `(organization_id, client_id) → clients(organization_id, id)`. Optionally add Postgres RLS with `app.current_org_id` as defence in depth. |
| C3 | P0 | **Auth tables missing.** These are sessions, password-reset tokens, email-verification tokens and invitations. `users.password_hash NOT NULL` breaks invited-but-not-accepted users. | Add `sessions`, `auth_tokens(type, token_hash, expires_at, used_at)` and `invitations`. Make `password_hash` nullable. Store token *hashes* only. |
| C4 | P0 | **Is a client a user?** The `client` role sits in the org role list and the matrix, but the portal is magic-link based. `organization_members.user_id → users` would force clients into the staff user table. | Clients are **not** users in V1. Use `client_portal_tokens(client_id, token_hash, expires_at, revoked_at)` and portal sessions. Drop `client` from `organization_members.role`. |
| C5 | P0 | **No workflow-execution dedupe.** "Do not duplicate notifications if the same event/rule/action already executed" has no unique key to enforce it. | Add a `workflow_executions` table (or columns on `scheduled_actions`) with `UNIQUE(workflow_id, action_index, target_type, target_id, run_key)`. `run_key` encodes the threshold, e.g. `due+7`. Add `notifications.idempotency_key UNIQUE`. |
| C6 | P0 | **Outbox claim columns missing.** The worker cannot claim rows safely across processes. | Add `locked_at` and `locked_by`. Claim with `FOR UPDATE SKIP LOCKED`. Add a partial index `WHERE status='pending'`. |
| C7 | P1 | **No enum CHECK constraints.** Case is inconsistent too: the spec uses `DRAFT` and `UPPER_SNAKE` while the SQL defaults to `'draft'`. | Pick lowercase snake in the DB with CHECK constraints, and map to UPPER only in API/UI if desired. Shared enums go in `packages/types`. |
| C8 | P1 | **Search indexes won't work.** `ILIKE '%x%'` cannot use the btree indexes provided. Phones like `+91 98xxx`, `098xxx` and `98xxx` won't match each other. | Use `pg_trgm` GIN indexes on name/title/case_number/cnr/invoice_number. Store a normalised `phone_e164` column (also used for dedupe warnings). |
| C9 | P1 | **Case-insensitive email uniqueness.** `users.email UNIQUE` lets `A@x.com` and `a@x.com` coexist. | Use `citext` or a unique index on `lower(email)`. |
| C10 | P1 | **Tables missing for named features:** task comments/activity (Screen 12), matter tags (the "add tag" workflow action has nowhere to write except `clients.tags`), user notification preferences (§17), reminder profiles (Screen 9), import jobs and row errors (§27), SES bounce/complaint events, document share records. | Add `task_comments`, `matters.tags`, `user_notification_prefs`, `import_jobs` + `import_job_rows` and `notification_events`. Fold reminder profiles into workflows. |
| C11 | P1 | **Hearing date-change history.** `HEARING_CHANGED` detection and "manual override of imported data with audit history" both need the before value. | Rely on `audit_logs.before_json`, and emit the outbox payload with `{before, after}`. |
| C12 | P1 | **Documents lack upload state.** Presign → complete needs `status (pending/available/failed)`, `checksum` and `updated_at`. Virus-scan status is also missing. | Add the columns. Run a cleanup job for orphaned `pending` objects. |
| C13 | P2 | `clients DELETE` and `expenses DELETE` endpoints vs. "financial records not physically deleted." | Soft-delete (archive) clients with matters. Void expenses rather than deleting them. |
| C14 | P2 | `next_hearing_date` on `cases` is denormalised and will drift. | Maintain it in the hearing service inside the same transaction, or derive it via a view. |

---

## D. Workflow / scheduling gaps

| # | Sev | Gap | Recommendation |
|---|---|---|---|
| D1 | P0 | **Two schedulers.** Both `scheduled_actions` (DB) and BullMQ delayed jobs (Redis) are named, which risks split-brain on Redis loss. | The DB is the source of truth. A poller enqueues due `scheduled_actions` into BullMQ for execution only. BullMQ never holds future state. |
| D2 | P0 | **Rescheduling and cancellation.** When a hearing date changes or the hearing is cancelled, pending reminders must be cancelled or recomputed. When an invoice is paid or voided, pending dunning must stop. Neither is specified. | Every scheduled action carries `target_type/target_id`. A target change cancels pending actions and re-plans. Conditions are re-checked at execution time (is the invoice still unpaid?). |
| D3 | P1 | **Send time of day.** "hearing.date − 1 day" doesn't say *when* it fires, and the dry-run example shows 09:00 IST. | Add an org setting `default_send_time` (09:00) in `organizations.timezone`, with a per-action override. |
| D4 | P1 | **Time-derived events** (`TASK_DUE_SOON`, `TASK_OVERDUE`, `INVOICE_DUE_SOON`, `INVOICE_OVERDUE`) have no producer. | A daily sweeper (per-org timezone) emits them, deduped by `(entity, threshold, date)`. |
| D5 | P1 | **Approval mode.** "Review/edit before send where approval mode is enabled" and "client updates requiring approval" on the dashboard have no status in the notification lifecycle. | Add notification status `awaiting_approval` plus approve/reject endpoints. This becomes a dashboard section. |
| D6 | P1 | **Recipient resolution.** "Lawyer", "staff", "partner" and "client" need deterministic rules. Examples: multiple owners; client with no email; client opted out (§17). | Define resolvers. When a client is skipped for opt-out or missing email, record a `skipped` notification row with the reason. Never drop it silently. |
| D7 | P2 | The morning-of-hearing lawyer reminder is in PRD §42 but missing from the prompt's defaults. `TASK_COMPLETED`, `NOTIFICATION_SENT` and `NOTIFICATION_FAILED` are in PRD §9.2 but not in the prompt's trigger list. | Use the PRD as the superset. |

---

## E. Auth / security / infra gaps

| # | Sev | Gap | Recommendation |
|---|---|---|---|
| E1 | P0 | **Lawyer data visibility is undefined.** The matrix says "assigned/all permitted cases according to firm settings", and several cells say "configurable", but no settings keys exist. | V1: org setting `lawyer_visibility = all | assigned` (assigned = responsible or in `matter_staff`). Document every "configurable" cell as a named setting with a default. |
| E2 | P0 | **Multi-org users with no active-org selection.** The PRD says a user may belong to several orgs. | Store the active org in the session. Add `POST /auth/switch-organization`. Every request resolves membership for (user, active org). |
| E3 | P1 | **CSRF.** It is in the PRD but missing from the prompt. | Use SameSite=Lax cookies plus a double-submit CSRF token for mutating routes. |
| E4 | P1 | **SES realities.** New accounts are in **sandbox** (verified recipients only), so production access must be requested before the pilot. "Delivered/Bounced" needs a configuration set plus an SNS webhook, which requires a public API endpoint. Per-firm sender domains (Onboarding step 5) mean per-tenant DKIM verification. | Pilot plan: one platform sending domain, firm name in the From display, firm email in Reply-To. Per-firm domains come later. Use ap-south-1. Request production access in week 1. |
| E5 | P1 | **Document access.** The bucket must be private, with short-lived signed GETs (≤5 min) issued only after an authz check. Portal downloads need the same treatment. | Done this way. Add a test that guesses a URL and gets denied. |
| E6 | P2 | **Backups and restore testing** are listed but have no owner or RPO/RTO. | Use RDS automated backups plus a monthly restore drill in the runbook. |

---

## F. Recommended execution plan

The spec's 7 phases are fine. Add **exit gates** so each phase is actually usable before the next:

| Phase | Exit gate |
|---|---|
| 0. Repo + infra | `docker compose up`, `pnpm i`, lint/typecheck/test green on an empty skeleton |
| 1. Foundation | Corrected schema migrated. Login/session/RBAC work. Tenant-isolation test passes. Mobile shell renders at 360 px. |
| 2. Clients/Matters/Cases | Pilot Test 1 passes (minus dashboard) |
| 3. Hearings/Tasks/Dashboard | Pilot Test 1 fully. Hearing completion → next date → task in under 3 taps. |
| 4. Billing | Pilot Tests 4–5. GST/TDS cases are unit-tested. Ledger triggers are in place. |
| 5. Outbox/Email/Workflows | Pilot Tests 2, 3 and 6 against **real SES** (sandbox-verified addresses) |
| 6. Docs/Portal/Import/Reports | Import of the pilot firm's real client list |
| 7. Hardening | Pilot Test 7. E2E suite. Restore drill. |

---

## G. Decisions needed before Phase 1 schema is written — RESOLVED 2026-10-02, see [decisions.md](decisions.md)

1. **GST/TDS:** model them in V1 (recommended, B1/B2), or ship "tax as a lump sum" and accept that invoices aren't GST-compliant?
2. **Payments:** support allocation and advances (B3), or keep the strict 1:1 payment→invoice rule?
3. **Client = user?** The recommendation is no, with magic-link tokens only (C4).
4. **Lawyer visibility default:** `all` or `assigned` (E1)?
5. **Pilot firm:** who is it, and do they currently track dates manually or with a tool (A1/A3)?
6. **Repo home:** resolved, `umang1802/legal-ops` cloned at `Eduforgex/legal-ops/`.
