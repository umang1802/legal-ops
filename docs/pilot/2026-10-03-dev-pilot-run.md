# Pilot acceptance script: dev run, 2026-10-03

**Script:** PRD §62, "First Pilot Acceptance Script" (7 tests)
**Build:** Phases 1–2 (uncommitted working tree), local dev (API :4100, web :5190, Postgres 16)
**Data:** `pnpm db:reset` seed. Test 1 was run in the **empty** second firm, _Verma Legal Chambers_, so it started from zero like a real pilot firm.
**Device:** browser emulating a 375×812 phone (Android UA), since pilot users will mostly be on phones.

## Summary

| #   | Test               | Result              | Notes                                                                                              |
| --- | ------------------ | ------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Matter             | ⚠️ **Partial pass** | Client + matter + case number + court ✅. Hearing, dashboard and calendar steps need Phase 3.      |
| 2   | Hearing automation | ⛔ **Blocked**      | Needs hearings (Phase 3) and the email worker + workflow engine (Phase 5).                         |
| 3   | Hearing completed  | ⛔ **Blocked**      | Needs hearings and tasks (Phase 3); the client email needs Phase 5.                                |
| 4   | Invoice            | ⛔ **Blocked**      | Needs billing (Phase 4).                                                                           |
| 5   | Partial payment    | ⛔ **Blocked**      | Needs billing (Phase 4). The DB-level allocation/TDS math is already verified by `invariants.sql`. |
| 6   | Overdue            | ⛔ **Blocked**      | Needs billing (Phase 4) and the scheduler (Phase 5).                                               |
| 7   | Security           | ✅ **Pass**         | 37 cross-firm probes in both directions. No access, no leakage, no mutation.                       |

**Bottom line:** the build is not yet pilot-ready (2 of 7 tests can run). What exists is solid: tenant isolation held under direct API attack. Tests 1 and 3 become runnable after Phase 3, and all seven after Phase 5.

---

## Test 1: Matter

| Step (PRD)                          | What I did                                                                                  | Result                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Create `Sharma vs ABC`              | New matter form, as the owner of Verma Legal Chambers                                       | ✅ Created in one save, landed on the matter page                                                                                 |
| Add client Raj Sharma               | Picker search → "No matches" → New client (email + phone)                                   | ✅ Created inline. Firm A's own "Raj Sharma" did **not** appear in the picker or trigger a duplicate warning (correct isolation). |
| Add case number                     | `CS(OS) 512/2026`, case title                                                               | ✅                                                                                                                                |
| Add court                           | Searched "saket" → _Not in the list yet_ (Firm A's private court hidden) → Delhi High Court | ✅                                                                                                                                |
| Add hearing for 10 Oct              | —                                                                                           | ⛔ Hearings are Phase 3                                                                                                           |
| Expected: case visible in dashboard | —                                                                                           | ⛔ The dashboard has no data feed until Phase 3; it honestly shows "—"                                                            |
| Expected: hearing on calendar       | —                                                                                           | ⛔ Calendar is Phase 3                                                                                                            |

Timeline recorded _Matter opened_ and _Case added_. Outbox recorded `MATTER_CREATED` and `CASE_CREATED`.

## Test 7: Security

**Setup:** Firm A = Sharma & Associates (seeded). Firm B = Verma Legal Chambers (data created in Test 1). Each attacker is a **legitimately signed-in owner** with a valid session and CSRF token, which is stronger than the PRD's "attempt to access".

**B attacking A (25 probes, via the signed-in browser session):**

- Direct URLs in the UI to A's matter, case and client → "Page not found". It never reveals that the record exists.
- API reads by id (matter, timeline, case, client) → `404`.
- API writes/deletes by id (PATCH matter/case/client, add staff/party/case, DELETE party/client, PATCH/DELETE A's member) → `404`.
- Create a matter against A's client id → `422` (unknown client).
- Switch active org to A → `403`.
- Smuggle `organizationId` in PATCH /organization and POST /clients → `422` (unknown field rejected).
- Lists and search (`/matters?clientId=<A client>`, `/clients`, `/matters`, `/search?q=ABC|Priya`, `/organization/members`) → `200`, containing **only B's data**.

**A attacking B (7 probes, via curl with A's session):** GET/PATCH B's matter and case, timeline, add a party, create a case under B's matter → all `404`. Searching for B's matter title and B's client's phone number returns nothing.

**No mutation:** Firm A's data was fingerprinted (md5 over matters, cases, clients, parties, staff, members and the org row) before the probes. Afterwards, every pre-existing row hashes **identically** (`ad653b75…`). Postgres write counters show **0 updates and 0 deletes** on those tables. No injected rows ("pwned", "Injected", "Smuggle") exist.

> **Note on the run:** during the test, someone signed in as `partner@example.com` from a desktop Mac browser and created client _Aakash Yadav_ and matter _Aakash Yadav vs Prayagraj_ inside Firm A. This changed Firm A's overall hash, so I traced it through the audit log (actor, time, user agent) and excluded rows created after 13:13 UTC. The audit trail captured every one of those writes with actor and device, which is a useful incidental check of auditability.

---

## Findings and fixes

| #   | Severity | Finding                                                                                                                                                                                                                                                                              | Status                                                                                                                               |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | Medium   | **Owner-created matters get no lead lawyer.** The lead defaulted to the creator only for the `lawyer` role. Both matters owners created today had no lead (one had nobody assigned). Small chambers like Vidhimeya, where the partner does the work, would hit this on every matter. | **Fixed:** owner, admin or lawyer creators now default to lead ("Choose later" is still available). Verified in browser.             |
| F2  | Medium   | **Forbidden / not-found pages showed a loading skeleton for ~7s+** (and indefinitely while the tab was unfocused). TanStack Query retried `404` responses three times with backoff, pausing while unfocused.                                                                         | **Fixed:** 4xx responses are no longer retried; only network/5xx are. "Page not found" now appears immediately. Verified in browser. |
| F3  | Info     | When the API is down, the web app just sits on a spinner. (Seen at the start of the run because the dev servers had stopped overnight.)                                                                                                                                              | Open. Low priority for dev; production needs a health-checked process manager.                                                       |

## What it takes to run the remaining tests

| Phase                                        | Unblocks                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| 3: Hearings, calendar, tasks, live dashboard | Test 1 (fully), Test 3 except the client email                                 |
| 4: Billing                                   | Tests 4 and 5, and Test 6's status change                                      |
| 5: Outbox worker, SES, workflow engine       | Test 2, Test 3's email, Test 6's reminder, plus the queued invite/reset emails |

Tests 2 and 6 need a **test clock** ("move system/test clock past due date"). Plan for an injectable clock in the scheduler in Phase 5 rather than relying on real time.

---

## Addendum, after Phase 3 (same day)

| #      | Test              | Result                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ----------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | Matter            | ✅ **Pass**                         | Re-run in the empty firm: client, matter, case number, court, then **hearing for 10 Oct**. It appears on the October calendar and in the dashboard's "Next 7 days".                                                                                                                                                                                                                                             |
| 3      | Hearing completed | ⚠️ **Pass except the client email** | Recorded on a phone: _Adjourned_ → next date 22 Oct → task "Prepare written submissions" (auto-assigned to the matter lead). Timeline, next hearing and `HEARING_COMPLETED` event all created in one transaction. Run on a hearing dated in the past: the app refuses outcomes before the hearing date (D-009), so on the real 10 Oct listing, run it that day or later. **Client email queued** needs Phase 5. |
| 2, 4–6 | —                 | ⛔ Blocked                          | Unchanged: billing (Phase 4), email + scheduler (Phase 5).                                                                                                                                                                                                                                                                                                                                                      |

**Now passing:** Tests 1 and 7 fully; Test 3 except the email.

UX issues found while browser-testing Phase 3, all fixed:

- The calendar agenda started on Monday, so on a Saturday the user scrolled past five empty days. It is now a rolling 7 days starting today.
- Dates were too long for the narrow date column ("Thu, 1 Oct, 2026" wrapped to three lines). They are now compact ("Thu 1 Oct").
- Task badges read "Due Today" and "Overdue · Thu, 1 Oct, 2026". They now read "Due today" and "Overdue · since Thu 1 Oct".
- Quick-add "Hearing"/"Task" did nothing when you were already on that page. It now opens the form.

---

## Addendum, after Phase 4 (same day)

| #   | Test            | Result                         | Notes                                                                                                                                                                                                                         |
| --- | --------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Invoice         | ✅ **Pass except the email**   | ₹50,000 invoice due 15 Oct → total ₹50,000, outstanding ₹50,000, number `LGL/2026-27/…`, `INVOICE_CREATED` event queued. The email itself is sent in Phase 5.                                                                 |
| 5   | Partial payment | ✅ **Pass**                    | ₹20,000 recorded → paid ₹20,000, due ₹30,000, status _Partially paid_, receipt `RCPT/2026-27/…` printable. Verified by automated test and in the browser (seeded part-paid invoice settled from a phone).                     |
| 6   | Overdue         | ⚠️ **Status yes; reminder no** | A past-due invoice shows _Overdue · N days_, lands in the right aging bucket, and counts on the billing and main dashboards. The "reminder workflow runs once per threshold" part needs the Phase 5 scheduler and test clock. |

**Pilot status now:** Tests 1, 5 and 7 pass. Tests 3, 4 and 6 pass except their email/reminder step (Phase 5). Test 2 is blocked on Phase 5.

Fixed during Phase 4 browser testing:

- Billing tabs showed a scrollbar and sat above the page title.
- "Collected this month · incl. TDS" was truncated, and the note was then accidentally dropped (caught by lint).
- Simple-tax invoices said "(no GST)" on reimbursement lines.
- The main web bundle (664 KB) was split: billing, print and calendar are lazy-loaded, and vendor libraries are cached separately.
