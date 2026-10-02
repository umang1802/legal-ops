# LegalOps — V1 Product Requirements & Engineering Specification

**Working title:** LegalOps
**Version:** V1 MVP
**Document status:** Build-ready specification
**Primary market:** Indian litigation law firms / chambers, initially small and mid-sized firms
**Primary communication channel:** Email
**Future channels:** WhatsApp, SMS, push notifications
**Primary platform:** Responsive mobile-first web app / PWA
**Core promise:** Keep cases, tasks, client communication and collections synchronized so that nothing falls through the cracks.

---

## 1. Product Thesis

LegalOps is not intended to be a generic legal ERP or AI lawyer. V1 focuses on operational coordination:

> **Case event → task/action → client communication → payment/action → audit trail**

The product should answer four questions immediately for a law firm:

1. What needs attention today?
2. What changed in my cases?
3. Which clients need an update or action?
4. Who owes us money, how much, and when is it due?

V1 deliberately launches with email instead of WhatsApp to keep implementation and operating costs low. The system must nevertheless be designed around a channel-independent notification layer so WhatsApp/SMS/push can be added later without changing core domain logic.

---

# 2. Goals and Non-Goals

## 2.1 V1 goals

### Case operations
- Centralize clients, matters, cases, hearings, tasks, documents and case activity.
- Allow lawyers/staff to quickly see upcoming hearings and overdue work.
- Maintain a chronological case timeline.
- Support manual case entry and CSV import.
- Prepare the domain model for future court-data synchronization without coupling V1 to one provider.

### Client communication
- Send transactional email updates/reminders automatically.
- Maintain reusable email templates.
- Schedule reminders based on relative dates.
- Record every notification attempt and delivery state.
- Keep a complete communication audit trail on the matter/client timeline.

### Billing and collections
- Track agreed fees, fee milestones, invoices, partial payments, adjustments and expenses.
- Calculate current balance and overdue amounts correctly.
- Support manual payment recording in V1.
- Generate invoices and receipts.
- Automate payment due/overdue reminders through email.
- Keep financial records immutable enough to support audit/reconciliation.

### Firm management
- Multi-tenant organization model.
- Role-based access control.
- Dashboard for hearings, tasks, communications and collections.
- Audit logs for sensitive actions.
- Responsive/mobile-first UX.

## 2.2 Explicit non-goals for V1

Do not build these unless required to make a core V1 flow work:

- WhatsApp Cloud API integration.
- SMS gateway.
- Native Android/iOS applications.
- Full legal research database.
- AI legal advice/chatbot.
- Automated legal drafting.
- Full accounting/ERP replacement.
- Payroll/HR.
- E-filing.
- Time tracking as a mandatory billing mechanism.
- Complex document management/version-control system.
- Automated court scraping that bypasses provider restrictions or CAPTCHAs.
- Client self-service account creation without firm invitation.
- Public-facing marketplace for lawyers.

---

# 3. Target Users

## 3.1 Firm Admin / Partner

Needs:
- Overall visibility.
- Financial health.
- Work allocation.
- Case changes.
- Auditability.
- Configurable automation.

## 3.2 Advocate / Lawyer

Needs:
- Today's hearings.
- Case history.
- Tasks.
- Client communications.
- Quick updates from mobile.
- Ability to record a hearing outcome quickly.

## 3.3 Clerk / Case Manager

Needs:
- Case calendar.
- Hearing preparation tasks.
- Document handling.
- Follow-ups.
- Client notifications.

## 3.4 Finance / Accounts

Needs:
- Invoices.
- Payments.
- Outstanding balances.
- Aging.
- Receipts.
- Payment reminders.

## 3.5 Client

V1 client experience should be lightweight and link-based rather than a mandatory app installation.

Needs:
- Receive case updates.
- See next hearing.
- See selected documents.
- See invoices/outstanding amount.
- Download invoice/receipt.
- Contact the firm.

Client portal access should be through secure, expiring links or invited accounts. The MVP can start with magic-link access rather than full client account management.

---

# 4. Roles & Permissions

## Roles

### Owner / Partner
Full access across the organization.

### Admin
Manage firm settings, users, templates, workflows and operational data.

### Lawyer
Access assigned/all permitted cases, hearings, tasks, client communication and matter billing according to firm settings.

### Staff / Clerk
Operational case access, hearings, tasks, documents and communication; financial access configurable.

### Finance
Financial modules, invoices, payments, expenses, reports; case data limited to what is needed for billing.

### Read-only
View permitted records only.

### Client
Only client-facing records exposed through portal/link access.

## Permission matrix

| Capability | Owner | Admin | Lawyer | Staff | Finance | Read-only | Client |
|---|---:|---:|---:|---:|---:|---:|---:|
| View dashboard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | limited |
| Manage users | ✓ | ✓ | - | - | - | - | - |
| Create clients | ✓ | ✓ | ✓ | ✓ | limited | - | - |
| Create matters/cases | ✓ | ✓ | ✓ | ✓ | - | - | - |
| Edit case details | ✓ | ✓ | ✓ | configurable | - | - | - |
| Create hearing | ✓ | ✓ | ✓ | ✓ | - | - | - |
| Complete hearing | ✓ | ✓ | ✓ | ✓ | - | - | - |
| Manage tasks | ✓ | ✓ | ✓ | ✓ | limited | - | - |
| Upload documents | ✓ | ✓ | ✓ | ✓ | finance-docs | - | selected |
| Create invoices | ✓ | ✓ | configurable | - | ✓ | - | - |
| Record payment | ✓ | ✓ | configurable | - | ✓ | - | - |
| View firm financial dashboard | ✓ | ✓ | configurable | - | ✓ | - | - |
| Configure workflows | ✓ | ✓ | - | - | - | - | - |
| Manage email templates | ✓ | ✓ | - | - | - | - | - |
| View audit logs | ✓ | ✓ | limited | - | financial scope | - | - |

All permission checks must be server-side. UI hiding is not security.

---

# 5. Core User Journeys

## Journey A — Create a new matter

1. User selects Add Matter.
2. Search existing client or create new client.
3. Add matter name/type.
4. Add one or more cases.
5. Add court and identifiers (case number/CNR where applicable).
6. Assign lawyer/staff.
7. Add fee agreement if available.
8. Optionally add next hearing.
9. Save.
10. System creates audit record and `MATTER_CREATED` domain event.

## Journey B — Schedule hearing

1. User opens matter.
2. Add hearing date/time/court/bench/notes.
3. Choose reminder profile or defaults.
4. Save hearing.
5. System creates `HEARING_SCHEDULED` event.
6. Workflow engine schedules notification jobs.
7. Upcoming hearing appears on dashboard/calendar.

## Journey C — Complete hearing

1. Lawyer opens today's hearing.
2. Records attendance/outcome.
3. Adds next date if available.
4. Adds next action/tasks.
5. Optionally attaches order/document.
6. System creates timeline events.
7. Configured client update email is generated.
8. User can review/edit before send where approval mode is enabled.

## Journey D — Create invoice

1. Open matter.
2. Add invoice.
3. Select fee milestone/items.
4. Apply tax if configured.
5. Set due date.
6. Save invoice.
7. System calculates totals.
8. Invoice becomes `ISSUED`.
9. `INVOICE_CREATED` event triggers email.
10. Timeline records notification.

## Journey E — Record payment

1. Open invoice or matter.
2. Record payment.
3. Enter amount/date/method/reference.
4. System validates amount <= remaining receivable unless overpayment is explicitly allowed.
5. Create payment + ledger entry in one transaction.
6. Recalculate invoice status.
7. Issue receipt.
8. Trigger `PAYMENT_RECEIVED` event.
9. Send client confirmation email.

## Journey F — Payment becomes overdue

1. Scheduler evaluates unpaid invoices each day.
2. Due date passes.
3. Invoice becomes overdue.
4. `INVOICE_OVERDUE` event emitted once per threshold.
5. Workflow sends configured reminder.
6. Further thresholds may escalate internally.
7. Timeline records each notification.

---

# 6. Functional Requirements

## 6.1 Authentication

### V1
- Email/password authentication.
- Password reset by email.
- Session management.
- Email verification.
- Optional organization invite flow.
- Role assignment.
- Account deactivation.

### Future
- Google/Microsoft SSO.
- Passkeys.
- 2FA/OTP.

### Security requirements
- Passwords hashed using Argon2id or bcrypt with a strong work factor.
- Secure, HTTP-only cookies preferred for browser sessions.
- CSRF protection if cookie auth is used.
- Rate limit login/reset endpoints.
- Never expose raw passwords or password reset tokens.

---

## 6.2 Organizations / Multi-tenancy

Every business record must belong to an `organization_id` unless it is explicitly global configuration.

Requirements:
- One user may eventually belong to multiple organizations.
- All queries scoped by organization.
- Never rely solely on client-provided organization ID.
- Derive active organization from authenticated membership/context.
- Audit tenant-boundary violations in internal monitoring.

---

## 6.3 Clients

Fields:
- Full name / legal entity name.
- Client type: person/company.
- Email(s).
- Phone(s).
- Address.
- Preferred communication channel.
- Notes.
- Tags.
- Active/inactive.

Features:
- Search.
- Filters.
- Client detail page.
- List of matters.
- Financial summary.
- Communication history.
- Documents shared with client.

Duplicate prevention:
- Warn on matching email/phone/name.
- Never silently merge records.

---

## 6.4 Matters

A matter is the firm's internal engagement/work item. A matter may contain one or more court cases or legal proceedings.

Fields:
- Matter title.
- Matter code/reference.
- Client.
- Practice area.
- Status.
- Priority.
- Responsible lawyer.
- Supporting staff.
- Start date.
- Close date.
- Internal notes.
- Client-visible summary.

Suggested statuses:
- Lead
- Active
- On Hold
- Closed
- Archived

Matter statuses are configurable in future, but V1 should use controlled enum values to simplify reporting.

---

## 6.5 Cases

A case represents a court/legal proceeding associated with a matter.

Fields:
- Case title.
- Case number.
- CNR.
- Court.
- Court type.
- Bench/judge.
- Case type.
- Filing date.
- Registration date.
- Status.
- Next hearing date.
- Source/provider metadata.
- Last synced at.
- External source URL if applicable.

External-source fields must support future providers.

Example:

```json
{
  "provider": "ecourts",
  "externalId": "CNR-...",
  "lastSyncedAt": "2026-10-02T08:10:00Z"
}
```

---

## 6.6 Parties / Advocates

A case can have many parties and advocates.

Party fields:
- Name.
- Type.
- Side: petitioner/plaintiff/respondent/defendant/other.
- Contact information.
- Client/not-client flag.

Advocate fields:
- Name.
- Organization.
- Enrollment/license identifier if the firm chooses to store it.
- Contact.
- Side.
- Lead/internal/external flag.

---

## 6.7 Hearings

Fields:
- Case ID.
- Scheduled date.
- Start time.
- End time.
- Courtroom/room if known.
- Bench/judge.
- Hearing type.
- Status.
- Outcome.
- Next hearing date.
- Notes.
- Source provider.
- External ID.
- Last synced at.

Statuses:
- Scheduled
- Completed
- Adjourned
- Cancelled
- Unknown

Requirements:
- Calendar view.
- List view.
- Today/upcoming views.
- Reminders.
- Date change detection.
- Ability to manually override imported data with audit history.

---

## 6.8 Tasks

Fields:
- Title.
- Description.
- Matter.
- Case.
- Assignee.
- Priority.
- Status.
- Due date/time.
- Created by.
- Completed by.
- Source event.

Statuses:
- Todo
- In Progress
- Blocked
- Done
- Cancelled

Task automation:
- Auto-create from workflow events.
- Escalate after configurable overdue period.
- Email assignee when created.
- Daily digest option.

---

## 6.9 Documents

V1 supports file storage and metadata; it is not a full document-management suite.

Requirements:
- Upload to object storage.
- MIME/type validation.
- File size limit configurable.
- Virus/malware scanning hook if infrastructure permits.
- Metadata record in PostgreSQL.
- Matter/case association.
- Visibility: internal/client-visible.
- Uploader.
- Created date.
- Optional document category.
- Signed/verified flag as metadata only; do not infer legal validity.

Recommended initial max upload: 25 MB per file, configurable.

Do not store file blobs directly in PostgreSQL.

---

# 7. Billing & Collections Specification

## 7.1 Fee agreements

A fee agreement records how a client/matter is expected to be billed.

Types:
- Fixed fee.
- Retainer.
- Milestone.
- Per appearance/event.
- Hybrid.

V1 can model these but only needs to fully automate fixed/milestone/retainer-style entries.

Fields:
- Matter.
- Description.
- Currency.
- Agreed amount.
- Tax included flag.
- Effective date.
- Notes.
- Status.

Do not store payment amounts as floating-point numbers. Use integer minor units or PostgreSQL `numeric(14,2)` consistently. Preferred implementation: `numeric(14,2)` with explicit currency.

---

## 7.2 Fee milestones

Example:

| Milestone | Amount | Due date | Status |
|---|---:|---|---|
| Retainer | ₹50,000 | 2026-10-05 | Paid |
| Filing | ₹50,000 | 2026-10-15 | Paid |
| Hearing | ₹50,000 | 2026-11-01 | Due |

Fields:
- Agreement ID.
- Name.
- Sequence.
- Amount.
- Due date.
- Status.
- Invoice ID.

Statuses:
- Planned
- Invoiced
- Partially Paid
- Paid
- Waived
- Cancelled

---

## 7.3 Invoices

Fields:
- Invoice number.
- Matter.
- Client.
- Issue date.
- Due date.
- Currency.
- Subtotal.
- Discount.
- Tax.
- Total.
- Amount paid.
- Amount due.
- Status.
- Notes.
- PDF/object-storage location.

Statuses:
- Draft
- Issued
- Partially Paid
- Paid
- Overdue
- Void
- Written Off

Invoice numbers must be organization-scoped and generated server-side.

Example format:

`LGL-2026-000001`

Firm-specific invoice prefixes can be configurable later.

---

## 7.4 Payments

V1 manual payment recording:

Methods:
- UPI
- Bank Transfer
- Cash
- Cheque
- Card
- Other

Fields:
- Invoice ID.
- Client ID.
- Matter ID.
- Amount.
- Currency.
- Payment date.
- Method.
- Transaction/reference number.
- Notes.
- Recorded by.
- Reversal/refund reference if applicable.

Payment must be immutable after posting except through a reversal/adjustment mechanism.

Never update a historical payment amount directly in-place. Create a reversal and replacement entry.

---

## 7.5 Expenses

Fields:
- Matter.
- Case.
- Category.
- Amount.
- Currency.
- Date.
- Vendor/description.
- Billable-to-client flag.
- Reimbursable flag.
- Supporting document.
- Status.

---

## 7.6 Ledger model

Use a transaction-like ledger rather than calculating everything only from invoice rows.

Every financial event creates ledger entries.

Examples:

```text
INVOICE_ISSUED
Accounts Receivable +50,000
Revenue/Fees      +50,000

PAYMENT_RECEIVED
Cash/Bank         +25,000
Accounts Receivable -25,000
```

V1 does not need to become a full double-entry accounting system, but the data model should preserve a transaction history.

The UI can expose a simplified client/matter ledger while retaining an append-only financial event history internally.

---

# 8. Email Notification System

## 8.1 Provider abstraction

Create:

```ts
interface EmailProvider {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}
```

Initial implementation:

```text
SesEmailProvider
```

Future providers can implement the same interface.

---

## 8.2 Templates

Template fields:
- Name.
- Event type.
- Subject template.
- HTML body.
- Plain-text body.
- Variable schema.
- Active flag.
- Organization-scoped or system default.

Example variables:

```text
client.name
matter.title
case.case_number
hearing.date
hearing.time
invoice.number
invoice.amount_due
payment.amount
firm.name
firm.email
```

Templates must be rendered server-side.

Never allow arbitrary unsanitized HTML from normal users to be rendered into email without sanitization.

---

## 8.3 Notification lifecycle

```text
PENDING
  ↓
QUEUED
  ↓
SENDING
  ↓
SENT
  ↓
DELIVERED / BOUNCED / FAILED
```

The provider may only support `SENT`, `BOUNCED`, `FAILED`; do not fabricate delivery status.

Store provider message ID when available.

Retry transient failures using exponential backoff with a maximum attempt count.

Permanent failures should not endlessly retry.

---

# 9. Workflow Engine

## 9.1 Why this exists

Workflows are the core differentiator and the foundation for future WhatsApp.

The workflow engine must be generic enough to react to domain events and execute actions.

### Example

```text
WHEN hearing is 3 days away
THEN send client email
AND create task for lawyer
```

---

## 9.2 Events

V1 events:

### Case events
- `MATTER_CREATED`
- `CASE_CREATED`
- `CASE_STATUS_CHANGED`
- `HEARING_SCHEDULED`
- `HEARING_CHANGED`
- `HEARING_CANCELLED`
- `HEARING_COMPLETED`
- `ORDER_ADDED`

### Task events
- `TASK_CREATED`
- `TASK_DUE_SOON`
- `TASK_OVERDUE`
- `TASK_COMPLETED`

### Financial events
- `INVOICE_CREATED`
- `INVOICE_DUE_SOON`
- `INVOICE_OVERDUE`
- `PAYMENT_RECEIVED`
- `INVOICE_PAID`

### Document events
- `DOCUMENT_UPLOADED`
- `DOCUMENT_SHARED_WITH_CLIENT`

### Communication events
- `NOTIFICATION_SENT`
- `NOTIFICATION_FAILED`

---

## 9.3 Conditions

V1 should support only practical operators:

- equals
- not equals
- greater than
- less than
- contains
- is empty
- is not empty
- date offset

Example:

```json
{
  "field": "invoice.amount_due",
  "operator": "greater_than",
  "value": 10000
}
```

---

## 9.4 Actions

V1:
- Send email.
- Create task.
- Update task.
- Add tag.
- Add timeline event.
- Notify internal users.

Future:
- Send WhatsApp.
- Send SMS.
- Push notification.
- Create payment link.
- AI summarize.
- AI extract.

---

## 9.5 Relative date triggers

The engine must support date-based scheduling without requiring a developer-created cron for every rule.

Example:

```text
hearing.date - 3 days
```

or

```text
invoice.due_date + 7 days
```

Store timezone at organization level. Default to `Asia/Kolkata` for the initial market, but do not hard-code timezone logic in business calculations.

---

# 10. Event Architecture

Every important mutation should create a durable domain event after the transaction commits.

Recommended pattern:

```text
HTTP request
   ↓
DB transaction
   ├── business record mutation
   └── outbox_event
   ↓ commit
Outbox worker
   ↓
Workflow engine
   ↓
Jobs queue
   ↓
Email / task / timeline actions
```

Do not send email directly inside the database transaction.

Use the **transactional outbox pattern** so an email is not lost if the application crashes after a DB write.

---

# 11. Scheduler / Jobs

Recommended V1 stack:

- Redis.
- BullMQ.
- Worker process.

Queues:

```text
workflow-events
scheduled-actions
email-send
email-retry
report-generation
maintenance
```

Scheduled jobs should be idempotent.

A job may run more than once. The business action must not produce duplicate invoices/payments/tasks/notifications.

Use idempotency keys where appropriate.

---

# 12. Dashboard Requirements

Dashboard is role-aware.

## Lawyer view

### Today
- Hearings today.
- Upcoming hearings.
- Tasks due.
- Overdue tasks.
- Client updates requiring approval.
- Recent case changes.

## Partner/Admin view

Everything above plus:
- Outstanding fees.
- Overdue fees.
- Payments received this month.
- Upcoming collection amounts.
- Firm workload.
- Recent operational exceptions.

## Finance view

- Invoice totals.
- Paid/unpaid.
- Overdue aging.
- Payments this month.
- Collections by lawyer/matter.

---

# 13. Reports

V1 reports should remain operational rather than accounting-ERP-grade.

### Case reports
- Active cases by lawyer.
- Hearings this week.
- Hearings this month.
- Case status breakdown.
- Cases without a next hearing.

### Task reports
- Open tasks.
- Overdue tasks.
- Tasks by assignee.

### Financial reports
- Invoiced this month.
- Collected this month.
- Outstanding.
- Overdue aging: 0–7, 8–30, 31–60, 61+ days.
- Outstanding by client.
- Outstanding by matter.

CSV export should be supported.

---

# 14. Search

Global search across:
- Client name.
- Matter title/reference.
- Case number.
- CNR.
- Invoice number.
- Phone/email.

V1 can use PostgreSQL indexes and `ILIKE`/full-text search. Do not introduce Elasticsearch/OpenSearch until scale actually requires it.

Search must always remain organization-scoped.

---

# 15. Client Portal / Secure Links

Client portal V1 should be intentionally minimal.

## Client landing page

Show:
- Firm name.
- Matter(s) available to client.
- Next hearing.
- Latest update.
- Outstanding amount.
- Recent invoices.
- Shared documents.

Actions:
- View matter.
- Download invoice.
- Download receipt.
- View document.
- Contact firm.

## Security

Prefer magic links with:
- Random high-entropy token.
- Expiry.
- Single-use or rotating session token.
- Server-side revocation.
- Minimal information in URL.

Do not expose numeric database IDs in authorization-sensitive URLs as the only protection.

---

# 16. Audit Logging

Audit all sensitive actions:

- Login/security changes.
- User role changes.
- Client creation/update/deletion.
- Matter/case changes.
- Hearing changes.
- Invoice creation/voiding.
- Payment posting/reversal.
- Financial adjustments.
- Workflow creation/update.
- Email template changes.
- Document upload/delete/share changes.

Audit fields:

```text
id
organization_id
actor_user_id
action
entity_type
entity_id
before_json
after_json
ip_address
user_agent
created_at
```

For privacy/security, avoid putting sensitive document contents into audit records.

---

# 17. Notifications and Preferences

Users should be able to configure:

- Email reminders on/off.
- Daily digest on/off.
- Task assignment emails.
- Hearing reminders.
- Financial alert visibility.

Organization-level defaults should be applied when a user has not explicitly configured a preference.

Client preferences:
- Email enabled.
- Email address verified.
- Communication opt-out.

Do not send automated client notifications if the client has opted out, except where the firm has a separate legally appropriate operational mechanism; the product should simply respect configured consent/preferences.

---

# 18. Mobile-First UX Principles

## Layout

- Design for 360–430 px width first.
- Desktop adapts upward.
- Bottom navigation on mobile.
- Sticky primary actions.
- Large touch targets.
- Minimal dense tables on mobile.
- Use cards and expandable sections.

## Performance

- Dashboard usable on mid-range mobile devices.
- Avoid loading all cases at once.
- Cursor/page pagination for large lists.
- Skeleton states instead of blocking spinners.
- Optimistic UI only where failure handling is clear.

## PWA

V1 should:
- Be installable.
- Have app icon/manifest.
- Support basic offline shell caching.
- Show friendly network-error states.
- Not attempt complex offline data mutation in V1.

---

# 19. Screen-by-Screen UI Specification

## Screen 1 — Login

Elements:
- Firm/product logo.
- Email.
- Password.
- Remember session.
- Sign in.
- Forgot password.

States:
- Invalid credentials.
- Account disabled.
- Rate-limited.

Mobile priority: single-column, keyboard-friendly.

---

## Screen 2 — Forgot Password

Email field → confirmation state → reset email.

Never reveal whether an email exists.

---

## Screen 3 — Accept Organization Invite

Display:
- Firm name.
- Invited role.
- Email.
- Set password.
- Accept invitation.

---

## Screen 4 — Onboarding

Step 1: Firm details.
Step 2: Add users.
Step 3: Configure default hearing reminders.
Step 4: Configure default invoice reminders.
Step 5: Email sender/domain settings.
Step 6: Optional CSV import.

Allow skip on noncritical steps.

---

## Screen 5 — Dashboard

Top:
- Greeting.
- Date.
- Notification bell.
- Search.

Summary cards:
- Today's hearings.
- Tasks due.
- Overdue tasks.
- Outstanding amount.
- Overdue amount.

Sections:
- Today's hearings.
- Needs attention.
- Recent case changes.
- Payment follow-ups.

Primary CTA: `Add Matter`.

---

## Screen 6 — Cases / Matters List

Search + filters:
- Status.
- Lawyer.
- Practice area.
- Next hearing.
- Priority.

Mobile: card list.
Desktop: table.

Card fields:
- Matter name.
- Client.
- Case no./CNR.
- Next hearing.
- Assigned lawyer.
- Status.
- Outstanding amount.

---

## Screen 7 — Matter Detail

Header:
- Matter title.
- Client.
- Status.
- Priority.
- Assigned lawyer.

Tabs:
1. Overview
2. Timeline
3. Hearings
4. Tasks
5. Documents
6. Billing
7. Communication

Overview:
- Case identifiers.
- Court.
- Next hearing.
- Responsible lawyer.
- Financial snapshot.

Quick actions:
- Add hearing.
- Add task.
- Add document.
- Create invoice.
- Record payment.
- Send client update.

---

## Screen 8 — Case / Proceeding Detail

Show:
- Case number.
- CNR.
- Court.
- Judge/bench.
- Parties.
- Advocates.
- Status.
- Next hearing.
- Last synced.

Timeline preview with latest events.

---

## Screen 9 — Hearing Detail / Edit

Fields:
- Date.
- Time.
- Courtroom.
- Bench/judge.
- Type.
- Notes.
- Reminder profile.

For completed hearing:
- Outcome.
- Adjourned/next date.
- Next action.
- Documents.

Buttons:
- Save.
- Mark completed.
- Cancel hearing.

---

## Screen 10 — Calendar

Views:
- Day.
- Week.
- Month.

Filters:
- Lawyer.
- Hearing status.
- Matter status.

Mobile defaults to agenda/list rather than full grid.

---

## Screen 11 — Tasks

Sections:
- My tasks.
- Team tasks.
- Overdue.
- Completed.

Task card:
- Priority.
- Title.
- Matter.
- Due date.
- Assignee.
- Status.

Quick complete action.

---

## Screen 12 — Task Detail

- Title.
- Description.
- Matter.
- Case.
- Assignee.
- Due date.
- Source event.
- Activity/comments.

Buttons:
- Start.
- Complete.
- Reassign.
- Change due date.

---

## Screen 13 — Clients

Search, filter, create.

Client cards:
- Name.
- Contact.
- Active matters.
- Outstanding.
- Last communication.

---

## Screen 14 — Client Detail

Sections:
- Contact information.
- Matters.
- Outstanding balance.
- Invoice history.
- Payment history.
- Shared documents.
- Communication history.

Actions:
- Edit.
- Add matter.
- Create invoice.
- Record payment.
- Send email.

---

## Screen 15 — Billing Dashboard

Cards:
- Invoiced this month.
- Received this month.
- Outstanding.
- Overdue.
- Due this week.

Charts should be lightweight and optional in V1.

List:
- Overdue invoices first.
- Due soon.
- Recent payments.

---

## Screen 16 — Invoices

Filters:
- Status.
- Client.
- Matter.
- Due date.

Table/card:
- Invoice no.
- Client.
- Matter.
- Total.
- Paid.
- Due.
- Due date.
- Status.

Actions:
- View.
- Send.
- Download.
- Record payment.
- Void.

---

## Screen 17 — Invoice Detail

Header:
- Invoice number.
- Status.
- Client.
- Matter.

Items:
- Description.
- Quantity.
- Rate.
- Amount.

Totals:
- Subtotal.
- Discount.
- Tax.
- Total.
- Paid.
- Balance.

Actions:
- Email invoice.
- Download PDF.
- Record payment.
- Void.

Payment history underneath.

---

## Screen 18 — Payment Entry

Fields:
- Invoice.
- Amount.
- Date.
- Method.
- Reference.
- Notes.

Show:
- Invoice total.
- Already paid.
- Remaining.

Prevent accidental overpayment by default.

---

## Screen 19 — Payment Detail

Show:
- Amount.
- Client.
- Matter.
- Invoice.
- Method.
- Reference.
- Date.
- Recorded by.
- Receipt.

Action:
- Download receipt.
- Reverse payment.

---

## Screen 20 — Collections / Aging

Tabs:
- Overview.
- 0–7 days.
- 8–30.
- 31–60.
- 61+.

Rows/cards:
- Client.
- Matter.
- Invoice.
- Amount due.
- Days overdue.
- Last reminder.

Action:
- Send reminder.
- View matter.
- View invoice.

---

## Screen 21 — Documents

List by matter.

Filters:
- Category.
- Internal/client-visible.
- Date.

Upload drawer:
- File picker.
- Category.
- Visibility.
- Matter/case.

---

## Screen 22 — Communication Center

Show:
- Outbound emails.
- Delivery state.
- Recipient.
- Subject.
- Related matter.
- Trigger event.
- Sent time.

Filters:
- Sent.
- Failed.
- Bounced.
- Scheduled.

Optional client communication timeline per matter.

---

## Screen 23 — Email Templates

List:
- Template name.
- Event.
- Active.
- Last modified.

Editor:
- Subject.
- HTML/body editor.
- Available variables.
- Preview.
- Test send.

Do not allow arbitrary script tags.

---

## Screen 24 — Automations

List workflows:

```text
Hearing — 3 days before
→ email client
→ create prep task
```

Buttons:
- Create workflow.
- Enable/disable.
- Duplicate.
- Edit.

---

## Screen 25 — Workflow Builder

Simple V1, not a React Flow-style visual programming system.

Steps:
1. Event.
2. Conditions.
3. Timing.
4. Actions.
5. Recipients.
6. Preview.
7. Activate.

Example UI:

```text
WHEN
[ Hearing date ] [ is ] [ 3 days away ]

IF
[ Case status ] [ is ] [ Active ]

THEN
[ Send email ] to [ Client ]
AND
[ Create task ] for [ Assigned lawyer ]
```

---

## Screen 26 — Reports

Cards and tabular reports with export.

Initial reports:
- Case workload.
- Hearings.
- Tasks.
- Invoices.
- Collections.
- Aging.

---

## Screen 27 — Settings

Sections:
- Firm profile.
- Users.
- Roles.
- Billing defaults.
- Email settings.
- Templates.
- Automations.
- Notification preferences.
- Data import/export.
- Audit log.

---

# 20. Data Model / Database Schema

Below is the canonical V1 schema. PostgreSQL is the reference database.

## 20.1 Conventions

- Use UUIDs for primary keys.
- Use `timestamptz` for timestamps.
- Use `date` for date-only domain values.
- All tenant-scoped tables contain `organization_id`.
- Use `created_at`, `updated_at` consistently.
- Soft-delete only where business/audit requirements justify it.
- Financial records are not physically deleted.

---

## 20.2 organizations

```sql
CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  legal_name VARCHAR(255),
  email VARCHAR(320),
  phone VARCHAR(40),
  address TEXT,
  city VARCHAR(120),
  state VARCHAR(120),
  country VARCHAR(120) NOT NULL DEFAULT 'India',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  invoice_prefix VARCHAR(20) NOT NULL DEFAULT 'LGL',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 20.3 users

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(320) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100),
  phone VARCHAR(40),
  is_active BOOLEAN NOT NULL DEFAULT true,
  email_verified_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 20.4 organization_members

```sql
CREATE TABLE organization_members (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX idx_org_members_org ON organization_members(organization_id);
CREATE INDEX idx_org_members_user ON organization_members(user_id);
```

## 20.5 clients

```sql
CREATE TABLE clients (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_type VARCHAR(20) NOT NULL DEFAULT 'person',
  name VARCHAR(255) NOT NULL,
  email VARCHAR(320),
  phone VARCHAR(40),
  alternate_phone VARCHAR(40),
  address TEXT,
  city VARCHAR(120),
  state VARCHAR(120),
  country VARCHAR(120) DEFAULT 'India',
  notes TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_notifications_enabled BOOLEAN NOT NULL DEFAULT true,
  email_verified_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_clients_org_name ON clients(organization_id, name);
CREATE INDEX idx_clients_org_email ON clients(organization_id, email);
CREATE INDEX idx_clients_org_phone ON clients(organization_id, phone);
```

## 20.6 matters

```sql
CREATE TABLE matters (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  title VARCHAR(255) NOT NULL,
  reference_code VARCHAR(100),
  practice_area VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  responsible_lawyer_id UUID REFERENCES users(id),
  start_date DATE,
  close_date DATE,
  internal_notes TEXT,
  client_summary TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_matters_org_status ON matters(organization_id, status);
CREATE INDEX idx_matters_org_client ON matters(organization_id, client_id);
CREATE INDEX idx_matters_org_lawyer ON matters(organization_id, responsible_lawyer_id);
```

## 20.7 matter_staff

```sql
CREATE TABLE matter_staff (
  matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  role VARCHAR(30) NOT NULL DEFAULT 'support',
  PRIMARY KEY (matter_id, user_id)
);
```

## 20.8 courts

```sql
CREATE TABLE courts (
  id UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  court_type VARCHAR(100),
  city VARCHAR(120),
  state VARCHAR(120),
  country VARCHAR(120) DEFAULT 'India',
  external_provider VARCHAR(50),
  external_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

System/global courts can have null `organization_id`; tenant-specific custom courts may have an organization ID.

## 20.9 cases

```sql
CREATE TABLE cases (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID NOT NULL REFERENCES matters(id),
  court_id UUID REFERENCES courts(id),
  title VARCHAR(255) NOT NULL,
  case_number VARCHAR(150),
  cnr VARCHAR(150),
  case_type VARCHAR(100),
  filing_date DATE,
  registration_date DATE,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  judge_bench VARCHAR(255),
  next_hearing_date DATE,
  external_provider VARCHAR(50),
  external_id VARCHAR(255),
  external_url TEXT,
  last_synced_at TIMESTAMPTZ,
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cases_org_cnr ON cases(organization_id, cnr);
CREATE INDEX idx_cases_org_case_number ON cases(organization_id, case_number);
CREATE INDEX idx_cases_org_next_hearing ON cases(organization_id, next_hearing_date);
CREATE INDEX idx_cases_org_matter ON cases(organization_id, matter_id);
```

## 20.10 case_parties

```sql
CREATE TABLE case_parties (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  party_type VARCHAR(100),
  side VARCHAR(50),
  is_client BOOLEAN NOT NULL DEFAULT false,
  email VARCHAR(320),
  phone VARCHAR(40),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_case_parties_case ON case_parties(case_id);
```

## 20.11 advocates

```sql
CREATE TABLE advocates (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  firm_name VARCHAR(255),
  phone VARCHAR(40),
  email VARCHAR(320),
  side VARCHAR(50),
  is_internal BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 20.12 case_advocates

```sql
CREATE TABLE case_advocates (
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  advocate_id UUID NOT NULL REFERENCES advocates(id) ON DELETE CASCADE,
  PRIMARY KEY (case_id, advocate_id)
);
```

## 20.13 hearings

```sql
CREATE TABLE hearings (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  case_id UUID NOT NULL REFERENCES cases(id),
  scheduled_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  courtroom VARCHAR(100),
  bench_judge VARCHAR(255),
  hearing_type VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
  outcome TEXT,
  next_hearing_date DATE,
  notes TEXT,
  source_provider VARCHAR(50),
  external_id VARCHAR(255),
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_hearings_org_date ON hearings(organization_id, scheduled_date);
CREATE INDEX idx_hearings_case_date ON hearings(case_id, scheduled_date);
CREATE INDEX idx_hearings_org_status ON hearings(organization_id, status);
```

## 20.14 tasks

```sql
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID REFERENCES matters(id),
  case_id UUID REFERENCES cases(id),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  assignee_id UUID REFERENCES users(id),
  created_by UUID REFERENCES users(id),
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  status VARCHAR(30) NOT NULL DEFAULT 'todo',
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  source_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_org_due ON tasks(organization_id, due_at);
CREATE INDEX idx_tasks_org_assignee_status ON tasks(organization_id, assignee_id, status);
```

## 20.15 documents

```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID REFERENCES matters(id),
  case_id UUID REFERENCES cases(id),
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  mime_type VARCHAR(100),
  size_bytes BIGINT,
  storage_provider VARCHAR(50) NOT NULL,
  storage_key TEXT NOT NULL,
  visibility VARCHAR(30) NOT NULL DEFAULT 'internal',
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_documents_org_matter ON documents(organization_id, matter_id);
CREATE INDEX idx_documents_org_case ON documents(organization_id, case_id);
```

## 20.16 fee_agreements

```sql
CREATE TABLE fee_agreements (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID NOT NULL REFERENCES matters(id),
  agreement_type VARCHAR(30) NOT NULL,
  description TEXT,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  agreed_amount NUMERIC(14,2),
  tax_included BOOLEAN NOT NULL DEFAULT false,
  effective_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 20.17 fee_milestones

```sql
CREATE TABLE fee_milestones (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  fee_agreement_id UUID NOT NULL REFERENCES fee_agreements(id),
  name VARCHAR(255) NOT NULL,
  sequence_no INT,
  amount NUMERIC(14,2) NOT NULL,
  due_date DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'planned',
  invoice_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 20.18 invoices

```sql
CREATE TABLE invoices (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  matter_id UUID NOT NULL REFERENCES matters(id),
  invoice_number VARCHAR(100) NOT NULL,
  issue_date DATE NOT NULL,
  due_date DATE,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  subtotal NUMERIC(14,2) NOT NULL,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(14,2) NOT NULL,
  amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(14,2) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  notes TEXT,
  pdf_storage_key TEXT,
  created_by UUID REFERENCES users(id),
  issued_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, invoice_number)
);

CREATE INDEX idx_invoices_org_due ON invoices(organization_id, due_date);
CREATE INDEX idx_invoices_org_status ON invoices(organization_id, status);
CREATE INDEX idx_invoices_org_client ON invoices(organization_id, client_id);
CREATE INDEX idx_invoices_org_matter ON invoices(organization_id, matter_id);
```

## 20.19 invoice_items

```sql
CREATE TABLE invoice_items (
  id UUID PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description VARCHAR(500) NOT NULL,
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(14,2) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  fee_milestone_id UUID REFERENCES fee_milestones(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 20.20 payments

```sql
CREATE TABLE payments (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  matter_id UUID NOT NULL REFERENCES matters(id),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  payment_date DATE NOT NULL,
  payment_method VARCHAR(30) NOT NULL,
  reference_number VARCHAR(255),
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'posted',
  recorded_by UUID REFERENCES users(id),
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_org_date ON payments(organization_id, payment_date);
CREATE INDEX idx_payments_org_invoice ON payments(organization_id, invoice_id);
CREATE INDEX idx_payments_org_client ON payments(organization_id, client_id);
```

## 20.21 expenses

```sql
CREATE TABLE expenses (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID REFERENCES matters(id),
  case_id UUID REFERENCES cases(id),
  category VARCHAR(100),
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  expense_date DATE NOT NULL,
  description TEXT,
  vendor_name VARCHAR(255),
  billable_to_client BOOLEAN NOT NULL DEFAULT false,
  reimbursable BOOLEAN NOT NULL DEFAULT true,
  document_id UUID REFERENCES documents(id),
  status VARCHAR(20) NOT NULL DEFAULT 'recorded',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 20.22 ledger_entries

```sql
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID REFERENCES matters(id),
  client_id UUID REFERENCES clients(id),
  invoice_id UUID REFERENCES invoices(id),
  payment_id UUID REFERENCES payments(id),
  entry_type VARCHAR(50) NOT NULL,
  debit_account VARCHAR(50),
  credit_account VARCHAR(50),
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  reference_type VARCHAR(50),
  reference_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_org_matter ON ledger_entries(organization_id, matter_id);
CREATE INDEX idx_ledger_org_client ON ledger_entries(organization_id, client_id);
CREATE INDEX idx_ledger_org_created ON ledger_entries(organization_id, created_at);
```

## 20.23 timeline_events

```sql
CREATE TABLE timeline_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID REFERENCES matters(id),
  case_id UUID REFERENCES cases(id),
  client_id UUID REFERENCES clients(id),
  event_type VARCHAR(80) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  actor_user_id UUID REFERENCES users(id),
  source_type VARCHAR(50),
  source_id UUID,
  visibility VARCHAR(20) NOT NULL DEFAULT 'internal',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_timeline_org_matter_date ON timeline_events(organization_id, matter_id, created_at DESC);
CREATE INDEX idx_timeline_org_case_date ON timeline_events(organization_id, case_id, created_at DESC);
```

## 20.24 outbox_events

```sql
CREATE TABLE outbox_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  event_type VARCHAR(100) NOT NULL,
  aggregate_type VARCHAR(80) NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_pending ON outbox_events(status, available_at);
```

## 20.25 workflows

```sql
CREATE TABLE workflows (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  trigger_type VARCHAR(100) NOT NULL,
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflows_org_trigger ON workflows(organization_id, trigger_type, is_active);
```

## 20.26 scheduled_actions

```sql
CREATE TABLE scheduled_actions (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  workflow_id UUID REFERENCES workflows(id),
  action_type VARCHAR(50) NOT NULL,
  target_type VARCHAR(50),
  target_id UUID,
  run_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
  attempts INT NOT NULL DEFAULT 0,
  executed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scheduled_actions_due ON scheduled_actions(status, run_at);
```

## 20.27 email_templates

```sql
CREATE TABLE email_templates (
  id UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  event_type VARCHAR(100),
  subject_template TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT,
  variables_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 20.28 notifications

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  channel VARCHAR(30) NOT NULL,
  notification_type VARCHAR(80) NOT NULL,
  recipient_user_id UUID REFERENCES users(id),
  client_id UUID REFERENCES clients(id),
  matter_id UUID REFERENCES matters(id),
  template_id UUID REFERENCES email_templates(id),
  subject TEXT,
  destination TEXT,
  provider_message_id TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  attempts INT NOT NULL DEFAULT 0,
  source_event_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_org_created ON notifications(organization_id, created_at DESC);
CREATE INDEX idx_notifications_org_status ON notifications(organization_id, status);
CREATE INDEX idx_notifications_matter_created ON notifications(matter_id, created_at DESC);
```

## 20.29 audit_logs

```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  actor_user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id UUID,
  before_json JSONB,
  after_json JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_org_date ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_org_entity ON audit_logs(organization_id, entity_type, entity_id);
```

---

# 21. API Specification

Base URL:

```text
/api/v1
```

Auth should use secure browser sessions. APIs should return consistent envelopes.

Success example:

```json
{
  "data": {},
  "meta": {}
}
```

Error example:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": []
  }
}
```

Use conventional HTTP status codes:

- 200 OK
- 201 Created
- 204 No Content
- 400 Bad Request
- 401 Unauthorized
- 403 Forbidden
- 404 Not Found
- 409 Conflict
- 422 Validation Error
- 429 Rate Limited
- 500 Internal Error

All list endpoints should support pagination.

Recommended query params:

```text
?page=1&pageSize=25&sort=-createdAt&search=sharma
```

For very large datasets, add cursor pagination later.

---

## 21.1 Auth APIs

### POST `/auth/login`

Request:

```json
{
  "email": "lawyer@example.com",
  "password": "secret"
}
```

### POST `/auth/logout`

### GET `/auth/me`

### POST `/auth/forgot-password`

### POST `/auth/reset-password`

### POST `/auth/verify-email`

### POST `/auth/invitations/accept`

---

## 21.2 Organization APIs

### GET `/organization`

### PATCH `/organization`

### GET `/organization/members`

### POST `/organization/members/invite`

### PATCH `/organization/members/:memberId`

### DELETE `/organization/members/:memberId`

---

## 21.3 Dashboard

### GET `/dashboard`

Return role-aware aggregates:

```json
{
  "data": {
    "today": {
      "hearings": 7,
      "tasksDue": 12,
      "overdueTasks": 3,
      "outstanding": 484000,
      "overdue": 78000
    },
    "hearings": [],
    "tasks": [],
    "recentChanges": [],
    "collectionFollowUps": []
  }
}
```

Keep dashboard aggregation server-side to prevent the frontend from making dozens of requests.

---

## 21.4 Clients

### GET `/clients`

### POST `/clients`

### GET `/clients/:clientId`

### PATCH `/clients/:clientId`

### DELETE `/clients/:clientId`

### GET `/clients/:clientId/matters`

### GET `/clients/:clientId/invoices`

### GET `/clients/:clientId/payments`

### GET `/clients/:clientId/notifications`

### POST `/clients/:clientId/send-email`

---

## 21.5 Matters

### GET `/matters`

Filters:

```text
status
lawyerId
clientId
practiceArea
priority
nextHearingFrom
nextHearingTo
```

### POST `/matters`

### GET `/matters/:matterId`

### PATCH `/matters/:matterId`

### POST `/matters/:matterId/staff`

### DELETE `/matters/:matterId/staff/:userId`

### GET `/matters/:matterId/timeline`

### GET `/matters/:matterId/summary`

---

## 21.6 Cases

### GET `/cases`

### POST `/cases`

### GET `/cases/:caseId`

### PATCH `/cases/:caseId`

### GET `/cases/:caseId/parties`

### POST `/cases/:caseId/parties`

### PATCH `/cases/:caseId/parties/:partyId`

### DELETE `/cases/:caseId/parties/:partyId`

### GET `/cases/:caseId/advocates`

### POST `/cases/:caseId/advocates`

### POST `/cases/:caseId/refresh`

For V1, `/refresh` may be a stub/provider adapter that returns `NOT_CONFIGURED` if no court provider is installed. Do not expose fake success.

---

## 21.7 Hearings

### GET `/hearings`

Query:

```text
from
until
lawyerId
status
caseId
```

### POST `/hearings`

### GET `/hearings/:hearingId`

### PATCH `/hearings/:hearingId`

### POST `/hearings/:hearingId/complete`

Request:

```json
{
  "outcome": "Adjourned",
  "nextHearingDate": "2026-10-22",
  "notes": "Written submissions required"
}
```

### POST `/hearings/:hearingId/cancel`

---

## 21.8 Tasks

### GET `/tasks`

### POST `/tasks`

### GET `/tasks/:taskId`

### PATCH `/tasks/:taskId`

### POST `/tasks/:taskId/complete`

### POST `/tasks/:taskId/reassign`

---

## 21.9 Documents

### POST `/documents/presign-upload`

Request:

```json
{
  "fileName": "order.pdf",
  "contentType": "application/pdf",
  "sizeBytes": 234234,
  "matterId": "uuid"
}
```

Response:

```json
{
  "data": {
    "documentId": "uuid",
    "uploadUrl": "...",
    "storageKey": "..."
  }
}
```

### POST `/documents/:documentId/complete-upload`

### GET `/documents`

### GET `/documents/:documentId`

### DELETE `/documents/:documentId`

### POST `/documents/:documentId/share-with-client`

Files should upload directly to object storage using signed URLs; the API should not proxy large file bodies through the application server.

---

# 22. Billing APIs

## Fee agreements

### GET `/fee-agreements`
### POST `/fee-agreements`
### GET `/fee-agreements/:id`
### PATCH `/fee-agreements/:id`

## Milestones

### POST `/fee-agreements/:id/milestones`
### PATCH `/fee-milestones/:id`

## Invoices

### GET `/invoices`

Filters:

```text
status
clientId
matterId
dueFrom
dueTo
```

### POST `/invoices`

Example:

```json
{
  "clientId": "uuid",
  "matterId": "uuid",
  "issueDate": "2026-10-02",
  "dueDate": "2026-10-10",
  "items": [
    {
      "description": "Professional fees",
      "quantity": 1,
      "unitPrice": 50000
    }
  ],
  "discountAmount": 0,
  "taxAmount": 0,
  "notes": ""
}
```

### GET `/invoices/:id`
### PATCH `/invoices/:id`

Draft invoices may be edited. Issued invoices should be modified only through controlled adjustment flows.

### POST `/invoices/:id/issue`

### POST `/invoices/:id/send`

### POST `/invoices/:id/void`

### GET `/invoices/:id/pdf`

### GET `/invoices/:id/payments`

## Payments

### POST `/payments`

### GET `/payments`

### GET `/payments/:id`

### POST `/payments/:id/reverse`

### GET `/payments/:id/receipt`

## Expenses

### GET `/expenses`
### POST `/expenses`
### GET `/expenses/:id`
### PATCH `/expenses/:id`
### DELETE `/expenses/:id`

---

# 23. Communication APIs

### GET `/notifications`

Filters:

```text
channel
status
clientId
matterId
from
until
```

### GET `/notifications/:id`

### POST `/notifications/send-email`

Request:

```json
{
  "clientId": "uuid",
  "matterId": "uuid",
  "templateId": "uuid",
  "variables": {
    "customNote": "Please carry the original document."
  }
}
```

The API should resolve standard variables server-side from the matter/client rather than trusting the client to provide all sensitive values.

---

# 24. Email Template APIs

### GET `/email-templates`
### POST `/email-templates`
### GET `/email-templates/:id`
### PATCH `/email-templates/:id`
### DELETE `/email-templates/:id`
### POST `/email-templates/:id/test-send`

---

# 25. Workflow APIs

### GET `/workflows`
### POST `/workflows`
### GET `/workflows/:id`
### PATCH `/workflows/:id`
### POST `/workflows/:id/enable`
### POST `/workflows/:id/disable`
### POST `/workflows/:id/test`

Workflow test should show a dry-run:

```text
Would send email to: Client email
Would create task: Prepare hearing file
Would schedule action: 2026-10-15 09:00 IST
```

It must not send/modify production data unless explicitly requested.

---

# 26. Reports APIs

### GET `/reports/case-workload`
### GET `/reports/hearings`
### GET `/reports/tasks`
### GET `/reports/invoices`
### GET `/reports/collections`
### GET `/reports/aging`

All reports support date range and relevant filters.

CSV export:

### GET `/reports/:reportType/export?format=csv`

---

# 27. Import / Export APIs

## CSV import

### POST `/imports/clients/validate`
### POST `/imports/clients/commit`
### POST `/imports/matters/validate`
### POST `/imports/matters/commit`

Import process:

```text
Upload CSV
→ Parse
→ Validate
→ Show row errors
→ User confirms
→ Commit transactionally / in batches
→ Return import report
```

Never partially import silently.

Export:

### GET `/exports/clients`
### GET `/exports/matters`
### GET `/exports/financials`

---

# 28. Error Handling Requirements

Frontend should distinguish:

### User errors
- Invalid form.
- Duplicate invoice.
- Payment exceeds remaining balance.

### Permission errors
- 403 with a human-readable message.

### Infrastructure errors
- Retry where safe.
- Do not show stack traces to users.

### External provider errors
Use provider-neutral messages:

> `Court data refresh is temporarily unavailable.`

Do not claim synchronization succeeded unless it did.

---

# 29. Validation Rules

## Client
- Name required.
- Email required if email automation is to be used for that client.
- Validate email format.

## Matter
- Client required.
- Title required.
- Responsible lawyer optional at creation but strongly recommended.

## Case
- Matter required.
- Case title required.
- At least one identifier recommended; do not require CNR because not every case may have one.

## Hearing
- Date required.
- Completed hearing should not normally have a future completion timestamp.

## Invoice
- At least one item.
- All amounts >= 0.
- Total must equal item sum - discount + tax.
- Due date cannot precede issue date.

## Payment
- Amount > 0.
- Payment date required.
- Invoice must exist and be accessible in same organization.
- Default amount <= current amount due.

---

# 30. Financial Calculation Rules

All financial calculations must be deterministic and covered by automated tests.

Example:

```text
subtotal = Σ(item.amount)
discount = specified discount
tax = specified tax
total = subtotal - discount + tax
amountPaid = Σ(posted, non-reversed payments)
amountDue = total - amountPaid
```

Never derive payment status from a stale cached field without a reconciliation mechanism.

Invoice status rule examples:

```text
draft → DRAFT
issued + amountPaid = 0 + due date future → ISSUED
issued + amountPaid > 0 + amountDue > 0 → PARTIALLY_PAID
amountDue = 0 → PAID
due date < today && amountDue > 0 → OVERDUE
```

If invoice is voided, no new payment should be posted against it unless an explicit reversal/reopen flow exists.

---

# 31. Security Requirements

V1 must include:

- Tenant isolation.
- Server-side authorization.
- Secure session management.
- Password hashing.
- Rate limiting.
- Input validation using a schema library such as Zod.
- Output encoding/sanitization for HTML contexts.
- SQL parameterization.
- Signed object-storage URLs.
- File type/size validation.
- Audit logs.
- Secret management through environment/secret manager.
- No secrets in source control.
- Security headers.
- HTTPS only in deployed environments.
- CORS allowlist.
- CSRF protection where needed.
- Backups.
- Restore testing.

Production logs must not contain:
- Passwords.
- Session tokens.
- Payment secrets.
- Full client confidential documents.
- Raw reset tokens.

---

# 32. Privacy & Data Handling

The application must support firm-controlled data retention/export/deletion policies.

V1 should maintain:
- Privacy policy page/configuration.
- User activity audit.
- Client email preferences.
- Data export.
- Organization-level deletion/offboarding capability gated by owner/admin.

The product should not make unsupported legal claims such as “fully compliant” or “legally privileged” without legal review.

---

# 33. Observability

Use structured logs with:
- request ID.
- organization ID.
- user ID when available.
- route.
- status.
- latency.

Metrics:
- API latency.
- API error rate.
- queue depth.
- job failures.
- email sent/failed/bounced.
- scheduled jobs overdue.
- DB connection pool utilization.

Health endpoints:

`GET /health/live`

`GET /health/ready`

Readiness should check dependencies required to serve traffic.

---

# 34. Testing Strategy

## Unit tests

Required for:
- Invoice calculations.
- Payment allocation.
- Invoice status transitions.
- Workflow condition evaluation.
- Relative-date scheduling.
- Permission checks.
- Template rendering.

## Integration tests

- Auth flow.
- Matter CRUD.
- Hearing scheduling.
- Invoice issue.
- Payment recording.
- Outbox processing.
- Email job creation.

## End-to-end tests

At minimum:

### E2E 1
Login → create client → matter → case → hearing → see dashboard.

### E2E 2
Create invoice → issue → notification created → record partial payment → outstanding updates.

### E2E 3
Hearing completed → next hearing entered → task created → client email queued.

### E2E 4
Invoice overdue → workflow fires → reminder notification created.

### E2E 5
Organization A cannot access Organization B records.

---

# 35. Acceptance Criteria

V1 is not ready until all of the following are true:

## Case operations
- User can create client, matter, case.
- User can add parties.
- User can schedule hearing.
- Hearing appears on dashboard/calendar.
- User can complete hearing and record next date.
- Timeline shows meaningful changes.

## Tasks
- User can create/assign/complete task.
- Workflow can auto-create task.
- Overdue tasks visible.

## Billing
- User can create invoice.
- Invoice totals are mathematically correct.
- Issued invoice receives unique organization-scoped number.
- Partial payment updates balance correctly.
- Paid invoice becomes PAID.
- Due invoice becomes OVERDUE when applicable.
- Payment reversal restores receivable balance.
- Receipt can be downloaded.

## Email
- Template can be created/edited.
- Template variables render correctly.
- Test email can be sent.
- Workflow can schedule email.
- Notification status is tracked.
- Failed emails can be retried where safe.

## Security
- Tenant isolation tested.
- Unauthorized routes return 403/404 appropriately.
- Sensitive actions audited.
- Files cannot be accessed by guessing object-storage URLs.

## UX
- Core workflows work at 360 px width.
- No horizontal scrolling on core screens.
- Loading, empty, error and success states exist.
- Destructive actions require confirmation.

---

# 36. Seed Data / Demo Mode

Provide a development seed script that creates:

Organization:
`Sharma & Associates`

Users:
- partner@example.com — Owner
- lawyer@example.com — Lawyer
- clerk@example.com — Staff
- finance@example.com — Finance

Clients:
- Raj Sharma
- ABC Industries Pvt Ltd
- Priya Verma

Matters:
- Sharma v ABC
- ABC Contract Dispute
- Verma Property Matter

Cases with upcoming hearings.

Invoices with:
- unpaid.
- partially paid.
- overdue.
- paid.

Tasks:
- due today.
- overdue.
- upcoming.

This is required so screenshots/demo and manual testing are easy.

---

# 37. Suggested Backend Structure

```text
server/
  src/
    config/
    middleware/
    modules/
      auth/
      organizations/
      clients/
      matters/
      cases/
      hearings/
      tasks/
      documents/
      billing/
      payments/
      expenses/
      notifications/
      workflows/
      reports/
      imports/
      audit/
    integrations/
      email/
        email-provider.ts
        ses-provider.ts
      courts/
        court-provider.ts
        noop-provider.ts
      payments/
        payment-provider.ts
    jobs/
    events/
    db/
    utils/
    app.ts
    server.ts
```

Keep domain logic in services/use-cases, not controllers.

Avoid a giant `utils.ts` or giant `service.ts`.

---

# 38. Suggested Frontend Structure

```text
src/
  app/
  routes/
  components/
    ui/
    layout/
    forms/
    tables/
    cards/
  features/
    dashboard/
    clients/
    matters/
    cases/
    hearings/
    tasks/
    documents/
    billing/
    payments/
    communication/
    workflows/
    reports/
    settings/
  lib/
    api/
    auth/
    dates/
    formatting/
    permissions/
  hooks/
  styles/
```

Use a query library such as TanStack Query for server state.

Use a form/schema stack such as React Hook Form + Zod.

---

# 39. UI Component System

Use a consistent component library approach rather than styling screens independently.

Required primitives:

- Button.
- Input.
- Select.
- Combobox.
- DatePicker.
- Modal/Dialog.
- Drawer/Sheet.
- Tabs.
- Badge.
- Card.
- Table.
- DataTable.
- EmptyState.
- LoadingSkeleton.
- Toast.
- ConfirmDialog.
- MoneyDisplay.
- StatusBadge.
- Avatar.
- Timeline.
- FileUploader.

Accessibility:
- keyboard navigable.
- visible focus states.
- semantic form labels.
- dialog focus management.
- sufficient contrast.
- no color-only meaning.

---

# 40. Design Direction

Tone:
- Professional.
- Calm.
- Trustworthy.
- Operational.
- Not flashy.

Visual hierarchy:
- High readability.
- Strong date/status indicators.
- Financial values easy to scan.
- Red reserved for actual attention-required states.
- Green for completed/paid only.
- Yellow/amber for warnings.

Mobile interaction priority:

```text
View → act → confirm
```

Avoid deep nested navigation.

---

# 41. Email Template Examples

## Hearing reminder — client

Subject:

`Reminder: Your hearing for {{matter.title}} is on {{hearing.date}}`

Body:

```text
Dear {{client.name}},

This is a reminder that the next hearing in your matter
{{matter.title}} is scheduled for {{hearing.date}} at {{hearing.time}}.

Court: {{case.court}}
Case number: {{case.case_number}}

Please contact our office if you need any clarification.

Regards,
{{firm.name}}
```

## Payment due

Subject:

`Payment due for {{matter.title}} — {{invoice.amount_due}}`

## Payment received

Subject:

`Payment received — {{invoice.number}}`

Body should include received amount and remaining balance.

## Case update

Subject:

`Case update: {{matter.title}}`

Body should clearly distinguish a firm-entered update from court-source information.

---

# 42. Default Automation Recipes

The following should ship as templates that the admin can enable/disable.

## Hearing reminder

```text
Event: hearing scheduled
7 days before → lawyer reminder
3 days before → lawyer/staff reminder
1 day before → client email
Morning of hearing → lawyer reminder
```

## Post-hearing

```text
Event: hearing completed
If next hearing exists → send client update
If task/action exists → assign task
```

## Invoice

```text
Invoice issued → send invoice email
3 days before due → reminder
On due date → reminder
3 days overdue → reminder
7 days overdue → reminder + internal escalation
15 days overdue → partner escalation
```

All defaults must be configurable.

---

# 43. Import CSV Format

## Clients

Required:

```text
name,email,phone,address,city,state,notes
```

## Matters

```text
client_email,matter_title,reference_code,practice_area,status,priority,lawyer_email,start_date,internal_notes,client_summary
```

## Cases

```text
matter_reference,case_title,case_number,cnr,court_name,case_type,status,judge_bench,next_hearing_date
```

Import parser should produce row-level errors:

```text
Row 17:
Client email does not match any imported/existing client.
```

---

# 44. Court Integration Strategy

V1 should make court integration optional and provider-based.

### Adapter

```ts
interface CourtDataProvider {
  getCase(identifier: CaseIdentifier): Promise<ExternalCaseData>;
  getHearings(identifier: CaseIdentifier): Promise<ExternalHearing[]>;
  getOrders(identifier: CaseIdentifier): Promise<ExternalOrder[]>;
  refreshCase(identifier: CaseIdentifier): Promise<RefreshResult>;
}
```

Start with:

```text
NoopCourtProvider
```

for local development.

Then implement a real provider only after validating access, terms, reliability and costs.

Important product rule:

**External court data is evidence/source data, not automatically firm-authoritative data.**

Store source timestamp and last successful refresh.

---

# 45. Payment Integration Strategy

V1 can be manual-payment-only.

However, design:

```ts
interface PaymentProvider {
  createPaymentRequest(...)
  verifyWebhook(...)
  getPayment(...)
  refundOrReverse(...)
}
```

When online payments are added, the flow should be:

```text
Invoice
 ↓
Create provider payment request
 ↓
Client pays
 ↓
Webhook
 ↓
Verify signature
 ↓
Create payment
 ↓
Create ledger entry
 ↓
Recalculate invoice
 ↓
Emit PAYMENT_RECEIVED
```

Never mark a payment successful based solely on a browser redirect.

---

# 46. Future WhatsApp Compatibility Requirements

Even though WhatsApp is out of V1, these abstractions must exist:

```ts
interface NotificationChannel {
  send(message: NotificationMessage): Promise<DeliveryResult>;
}
```

The workflow action should look like:

```json
{
  "type": "notify",
  "channel": "email",
  "recipient": "client",
  "templateId": "uuid"
}
```

Later:

```json
{
  "type": "notify",
  "channel": "whatsapp"
}
```

No workflow should directly call the email provider.

---

# 47. AI-Ready Data Design

Do not implement AI features in V1 unless they are deliberately added after operational workflows are stable.

But preserve structured data so future AI can operate on it.

Future AI inputs:
- Timeline events.
- Court-source snapshots.
- Orders.
- Documents.
- Tasks.
- Client communication.
- Billing ledger.

Potential future actions:
- Summarize order.
- Extract next date.
- Create task from order.
- Draft client update.
- Summarize matter.

AI outputs must always be marked as generated/draft where relevant and should not silently mutate authoritative legal/court data.

---

# 48. V1 Development Plan

## Sprint 0 — Foundation

- Monorepo/app structure.
- Environment configuration.
- PostgreSQL.
- Migrations.
- Auth.
- Organization/membership.
- RBAC.
- Shared UI primitives.
- Error handling.
- Logging.

## Sprint 1 — Clients + Matters + Cases

- Client CRUD.
- Matter CRUD.
- Case CRUD.
- Parties.
- Advocates.
- Timeline.
- Search.

## Sprint 2 — Hearings + Tasks

- Hearing CRUD.
- Calendar.
- Dashboard.
- Tasks.
- Relative date scheduler foundation.

## Sprint 3 — Billing

- Fee agreements.
- Milestones.
- Invoices.
- Payments.
- Receipts.
- Aging.

## Sprint 4 — Email + Workflow

- SES adapter.
- Templates.
- Notification records.
- Outbox.
- Queue.
- Workflow builder.
- Default automation recipes.

## Sprint 5 — Documents + Client Portal

- S3 uploads.
- Document metadata.
- Secure links.
- Client-facing matter view.
- Invoice/receipt view.

## Sprint 6 — Hardening

- E2E tests.
- Security review.
- Permission audit.
- Performance.
- Import/export.
- Demo seed.
- Deployment.

---

# 49. MVP Definition of Done

A real law firm should be able to:

1. Import existing client/matter data.
2. Create/update cases.
3. Schedule hearings.
4. See today's work.
5. Assign tasks.
6. Record hearing outcomes.
7. Create an invoice.
8. Record partial/full payments.
9. See outstanding/overdue.
10. Send client emails.
11. Automate hearing/payment reminders.
12. Audit what was sent and when.
13. Access from a phone without an app install.
14. Export their data.
15. Continue working if an external provider is unavailable.

---

# 50. Success Metrics for the Pilot

Before rollout, capture a baseline for 2–4 weeks:

- Manual case-update calls/messages per week.
- Manual payment follow-ups per week.
- Hours spent checking hearing dates.
- Number of overdue tasks.
- Number of overdue invoices.
- Average days to collect invoices.
- Number of client updates sent.

After rollout measure:

- Reduction in manual follow-ups.
- Reduction in overdue tasks.
- Increase in on-time client updates.
- Increase in invoices collected on time.
- Active users/week.
- Number of automated workflows executed.
- Email delivery failure rate.
- Time saved per lawyer/staff member.

The product should eventually be able to quantify:

> “LegalOps saved this firm approximately X hours and automated Y client/payment follow-ups this month.”

---

# 51. Important Product Constraints

1. **Do not overbuild court integration before validating provider reliability and economics.**
2. **Do not make WhatsApp a dependency in the domain model.**
3. **Do not make AI the core workflow.**
4. **Do not build a full accounting package in V1.**
5. **Do not compromise tenant isolation for convenience.**
6. **Do not hide financial corrections; use explicit reversal/adjustment history.**
7. **Do not claim a court update was obtained unless a provider actually returned it.**
8. **Do not allow users to accidentally send client emails without an auditable notification record.**

---

# 52. Recommended Monorepo

```text
legalops/
  apps/
    web/
    api/
    worker/
  packages/
    db/
    types/
    validation/
    ui/
    config/
  infra/
    docker/
    terraform/   # optional after MVP
  docs/
    prd/
  package.json
  pnpm-workspace.yaml
```

Recommended package manager: pnpm.

Types should be shared between API and frontend where appropriate, but avoid coupling frontend rendering to backend implementation details.

---

# 53. Local Development

Use Docker Compose for:

- PostgreSQL.
- Redis.
- Local object storage such as MinIO (optional but useful).

Environment variables:

```text
DATABASE_URL
REDIS_URL
SESSION_SECRET
S3_ENDPOINT
S3_BUCKET
S3_REGION
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
SES_FROM_EMAIL
APP_URL
API_URL
```

Never commit `.env` files containing secrets.

Provide `.env.example`.

---

# 54. Deployment

Recommended initial production topology:

```text
CloudFront
   ↓
Frontend static hosting

API load balancer / reverse proxy
   ↓
Node API
   ↓
PostgreSQL

Worker
   ↓
Redis

Documents
   ↓
S3

Email
   ↓
SES
```

For an early pilot, a simpler AWS deployment is acceptable, provided production data is backed up and HTTPS is enforced.

---

# 55. Coding Standards

- TypeScript strict mode.
- ESLint.
- Prettier.
- No `any` unless justified.
- Zod for boundary validation.
- Parameterized SQL.
- Small, testable services.
- Controllers thin.
- No business logic in React components.
- No duplicated domain logic between API routes.
- Every migration reversible or safely forward-only with documented rollback strategy.
- No direct DB queries from UI.

---

# 56. Suggested API Folder Pattern

Example module:

```text
modules/billing/
  billing.routes.ts
  billing.controller.ts
  billing.service.ts
  billing.repository.ts
  billing.schemas.ts
  billing.types.ts
  billing.events.ts
  billing.test.ts
```

Transaction boundaries belong in the service/use-case layer.

---

# 57. Critical Backend Invariants

The coding agent must preserve these:

### Tenant invariant
Every query must be scoped to organization.

### Financial invariant
`amount_due = total_amount - posted_non_reversed_payments`.

### Invoice invariant
Issued invoices are not freely mutable.

### Payment invariant
Historical payments are not deleted.

### Event invariant
Every material mutation emits an outbox event after successful DB transaction.

### Notification invariant
Every automated client notification creates a notification record.

### Authorization invariant
The server never trusts a client-provided role/organization ID for access.

### External-data invariant
External provider data includes provider + external ID + last sync timestamp.

---

# 58. Release Strategy

## Internal alpha
- Developer only.
- Seed data.
- Test automations.

## Pilot
- One law firm.
- Real clients/cases where permitted.
- Email only.
- Manual court data or provider adapter as available.
- Weekly product review.

## V1 public beta
Only after:
- Permissions tested.
- Data export tested.
- Backup restore tested.
- Financial calculations audited.
- Notification failure handling validated.

---

# 59. Future Roadmap After V1

### V1.1
- Recurring invoices.
- Online payment links.
- Better import tooling.
- Calendar integrations.
- Email inbox linking.

### V1.5
- Court provider integration.
- Automatic case refresh.
- Cause-list monitoring.
- Order ingestion.

### V2
- WhatsApp.
- AI order extraction.
- Voice-to-case updates.
- AI morning briefing.
- Advanced collections.
- Client portal enhancements.

### V3
- Multi-office/branch.
- Advanced accounting integration.
- Legal document intelligence.
- Analytics/forecasting.
- Enterprise SSO.

---

# 60. Build Priority Matrix

| Feature | Priority |
|---|---|
| Authentication | P0 |
| Multi-tenancy | P0 |
| RBAC | P0 |
| Clients | P0 |
| Matters | P0 |
| Cases | P0 |
| Hearings | P0 |
| Tasks | P0 |
| Dashboard | P0 |
| Invoices | P0 |
| Payments | P0 |
| Outstanding/aging | P0 |
| Email | P0 |
| Workflow engine | P0 |
| Audit logs | P0 |
| Documents | P1 |
| Client portal | P1 |
| CSV import | P1 |
| Reports | P1 |
| Court integration | P1/P2 |
| Online payments | P1 |
| WhatsApp | P2 |
| AI | P2 |
| Native mobile | P3 |

---

# 61. CODING-AGENT IMPLEMENTATION PROMPT

Use the following prompt with a coding agent. It is intentionally strict: the agent should implement the product from this specification and should not invent an alternative product architecture without documenting why.

```text
You are the lead engineer building LegalOps V1, a mobile-first web application for Indian litigation law firms.

Read the complete product specification in this file before coding:

legalops_v1_prd.md

Your job is to implement a working production-quality MVP, not a mockup.

==================================================
PRODUCT
==================================================

LegalOps helps law firms manage:

1. Clients
2. Matters/cases
3. Hearings
4. Tasks
5. Documents
6. Fees/invoices
7. Payments
8. Outstanding/overdue collections
9. Automated email notifications
10. Configurable workflows
11. Audit logs
12. Mobile-first dashboard

The core workflow is:

COURT/CASE EVENT
→ INTERNAL TASK
→ CLIENT COMMUNICATION
→ PAYMENT/ACTION
→ AUDIT TRAIL

V1 communication channel is EMAIL ONLY.

IMPORTANT:
The application must be architected so WhatsApp/SMS/push can be added later without rewriting domain logic.

==================================================
TECH STACK
==================================================

Use:

Frontend:
- React
- TypeScript
- Tailwind CSS
- TanStack Query
- React Hook Form
- Zod

Backend:
- Node.js
- TypeScript
- Express or Fastify

Database:
- PostgreSQL

Jobs:
- Redis
- BullMQ

Object storage:
- S3-compatible storage

Email:
- Amazon SES adapter

Auth:
- Secure cookie-based session auth preferred

Local development:
- Docker Compose
- PostgreSQL
- Redis
- Optional MinIO

Package manager:
- pnpm

You may use a mature UI component library, but avoid excessive dependencies. Keep the design system simple and cohesive.

==================================================
NON-NEGOTIABLE ARCHITECTURAL RULES
==================================================

1. MULTI-TENANT FROM DAY ONE

Every tenant-owned entity must contain organization_id.

Every backend query must enforce organization scope using authenticated membership context.

NEVER trust organization_id supplied by the client as authorization.

Test cross-tenant isolation explicitly.

2. RBAC

Roles:
- owner
- admin
- lawyer
- staff
- finance
- read_only
- client

All authorization is enforced server-side.

3. EVENT-DRIVEN WORKFLOW FOUNDATION

Do not send emails directly from controllers or DB transactions.

Use:

DB transaction
→ outbox event
→ event worker
→ workflow engine
→ scheduled action/job
→ notification service
→ provider adapter

Use the transactional outbox pattern.

4. PROVIDER ABSTRACTIONS

Create interfaces for:

EmailProvider
NotificationChannel
CourtDataProvider
PaymentProvider
StorageProvider

V1 only needs:
- SesEmailProvider
- NoopCourtProvider
- S3 storage
- Manual payment recording

Future providers must plug into these interfaces.

5. FINANCIAL INTEGRITY

Do not use floating point for money.

Use PostgreSQL numeric(14,2) consistently.

Formula:
subtotal = sum(invoice items)
total = subtotal - discount + tax
amountPaid = sum(posted, non-reversed payments)
amountDue = total - amountPaid

Historical payments are immutable.
To correct a payment, reverse it and record the reason.

Issued invoices are not freely editable.

6. AUDITABILITY

Create audit log entries for sensitive mutations.

Every automated notification must also have a notification record.

==================================================
FOLDER STRUCTURE
==================================================

Create a clean monorepo if starting from scratch:

apps/web
apps/api
apps/worker
packages/db
packages/types
packages/validation
packages/ui

If repository constraints make a monorepo unreasonable, keep equivalent module separation.

Backend modules should include:

auth
organizations
clients
matters
cases
hearings
tasks
documents
billing
payments
expenses
notifications
workflows
reports
imports
audit

Use thin controllers and service/use-case modules.

Do not put business logic in route handlers.

==================================================
DATABASE
==================================================

Implement PostgreSQL migrations for all core tables in legalops_v1_prd.md.

At minimum implement:

organizations
users
organization_members
clients
matters
matter_staff
courts
cases
case_parties
advocates
case_advocates
hearings
tasks
documents
fee_agreements
fee_milestones
invoices
invoice_items
payments
expenses
ledger_entries
timeline_events
outbox_events
workflows
scheduled_actions
email_templates
notifications
audit_logs

Add appropriate indexes.

UUID primary keys.

timestamptz for timestamps.

date for date-only fields.

==================================================
AUTH
==================================================

Implement:

POST /api/v1/auth/login
POST /api/v1/auth/logout
GET /api/v1/auth/me
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password
POST /api/v1/auth/verify-email
POST /api/v1/auth/invitations/accept

Security:
- hash passwords with Argon2id or strong bcrypt
- rate limit login/reset
- secure cookies
- do not expose password/reset tokens
- secure CORS
- HTTPS assumptions in production

==================================================
CORE CASE OPERATIONS
==================================================

Implement full CRUD for:

Clients
Matters
Cases
Parties
Advocates
Hearings
Tasks
Documents

The matter page must have tabs:

Overview
Timeline
Hearings
Tasks
Documents
Billing
Communication

The timeline is important. Record events for:

matter creation
case creation
hearing scheduled
hearing changed
hearing completed
order/document added
task created/completed
invoice created
payment received
notification sent/failed

==================================================
DASHBOARD
==================================================

Build a role-aware mobile-first dashboard.

Lawyer dashboard:
- today's hearings
- upcoming hearings
- tasks due
- overdue tasks
- recent case changes
- client updates requiring action

Partner/admin dashboard adds:
- outstanding fees
- overdue amount
- due this week
- recent payments
- collection follow-ups

Finance dashboard focuses on:
- invoiced
- received
- outstanding
- overdue
- aging

The dashboard should feel like a "what needs my attention today?" command center.

Do not build a generic analytics dashboard as the primary experience.

==================================================
HEARINGS
==================================================

Implement:

GET /hearings
POST /hearings
GET /hearings/:id
PATCH /hearings/:id
POST /hearings/:id/complete
POST /hearings/:id/cancel

Support:
- date
- time
- court room
- judge/bench
- type
- outcome
- next hearing date
- notes
- status

Create calendar UI.

On completion, allow user to enter:
- outcome
- next date
- next actions

==================================================
TASKS
==================================================

Tasks must support:
- assignee
- priority
- status
- due date
- matter/case
- source event

Implement:

GET /tasks
POST /tasks
GET /tasks/:id
PATCH /tasks/:id
POST /tasks/:id/complete
POST /tasks/:id/reassign

==================================================
BILLING
==================================================

Implement:

Fee agreements
Fee milestones
Invoices
Invoice items
Payments
Expenses
Ledger entries

Invoice lifecycle:

DRAFT
ISSUED
PARTIALLY_PAID
PAID
OVERDUE
VOID

Payment methods:

UPI
BANK_TRANSFER
CASH
CHEQUE
CARD
OTHER

Manual payment recording is V1.

When recording payment:
1. validate invoice access
2. validate amount
3. create payment
4. create ledger entry
5. update invoice state
6. create timeline event
7. emit PAYMENT_RECEIVED
8. queue payment confirmation email

All steps requiring consistency must execute in a DB transaction.

Implement payment reversal rather than destructive edit/delete.

==================================================
EMAIL
==================================================

Build NotificationService + EmailProvider interface.

V1 implementation:
SesEmailProvider

Required email capabilities:
- send transactional email
- templates
- variables
- scheduling
- retry transient failures
- record status
- provider message id
- failure reason
- audit trail

Do NOT send email synchronously inside request transaction.

Use queue workers.

==================================================
WORKFLOWS
==================================================

Implement a simple configurable workflow engine.

Do NOT build an unnecessarily complex visual node editor.

Workflow structure:

Trigger
→ Conditions
→ Delay/timing
→ Actions

V1 triggers:

MATTER_CREATED
CASE_CREATED
CASE_STATUS_CHANGED
HEARING_SCHEDULED
HEARING_CHANGED
HEARING_CANCELLED
HEARING_COMPLETED
ORDER_ADDED
TASK_CREATED
TASK_DUE_SOON
TASK_OVERDUE
INVOICE_CREATED
INVOICE_DUE_SOON
INVOICE_OVERDUE
PAYMENT_RECEIVED
INVOICE_PAID
DOCUMENT_UPLOADED
DOCUMENT_SHARED_WITH_CLIENT

V1 actions:
- send email
- create task
- update task
- add tag
- add timeline event
- notify internal users

Relative date support:

hearing.date - 7 days
hearing.date - 3 days
hearing.date - 1 day
invoice.due_date - 3 days
invoice.due_date
invoice.due_date + 3 days
invoice.due_date + 7 days
invoice.due_date + 15 days

==================================================
DEFAULT AUTOMATIONS
==================================================

Seed these but allow them to be disabled:

1. Hearing scheduled:
7 days before → lawyer reminder
3 days before → staff/lawyer reminder
1 day before → client email

2. Hearing completed:
If next hearing exists → client update email
If next task exists → create/assign task

3. Invoice issued:
Send invoice email

4. Invoice due:
3 days before → reminder
On due date → reminder
3 days overdue → reminder
7 days overdue → reminder + internal escalation
15 days overdue → partner escalation

Do not duplicate notifications if the same event/rule/action has already executed successfully.

==================================================
DOCUMENTS
==================================================

Use signed direct-to-S3 upload.

API:
POST /documents/presign-upload
POST /documents/:id/complete-upload
GET /documents
GET /documents/:id
DELETE /documents/:id
POST /documents/:id/share-with-client

Store metadata in PostgreSQL.

Do not store files in DB.

==================================================
CLIENT PORTAL
==================================================

Create a minimal secure portal.

Clients can access:
- matter summary
- next hearing
- latest update
- selected documents
- invoices
- payment history/receipts

Use secure expiring magic links.

Client should not need a native app.

==================================================
UI
==================================================

Build mobile-first responsive UI.

Target 360–430 px first.

Mobile navigation:

Home
Cases
+
Billing
More

Primary screens:

Login
Forgot password
Onboarding
Dashboard
Cases list
Matter detail
Case detail
Hearing detail
Calendar
Tasks
Task detail
Clients
Client detail
Billing dashboard
Invoices
Invoice detail
Payment entry
Payment detail
Collections/Aging
Documents
Communication center
Email templates
Automations
Workflow builder
Reports
Settings

Use reusable components.

Do not create separate one-off styling patterns for every screen.

Support:
- loading
- empty
- error
- success
- confirmation
- permission denied
states.

No horizontal scrolling on core mobile views.

==================================================
SEARCH
==================================================

Implement organization-scoped global search across:
- client
- matter
- case number
- CNR
- invoice number
- phone
- email

Use PostgreSQL indexes and ILIKE/full-text where sensible.

==================================================
IMPORT
==================================================

Implement CSV import for:

clients
matters
cases

Flow:

upload
→ parse
→ validate
→ preview
→ row-level errors
→ commit
→ import report

Never silently skip invalid rows.

==================================================
REPORTS
==================================================

Implement:

case workload
hearings
open/overdue tasks
invoices
collections
aging

Support CSV export.

==================================================
SECURITY
==================================================

Must implement:
- tenant isolation
- RBAC
- auth security
- rate limiting
- secure headers
- CORS allowlist
- input validation
- SQL parameterization
- signed file URLs
- audit logging
- secure secrets

Never log:
- passwords
- session secrets
- reset tokens
- payment credentials
- document contents

==================================================
TESTING
==================================================

Write automated tests before declaring complete.

Unit tests:
- invoice calculations
- payment allocation
- invoice status
- workflow date calculations
- workflow conditions
- permission checks
- template rendering

Integration tests:
- login
- tenant isolation
- matter CRUD
- hearing completion
- invoice issue
- payment record/reversal
- outbox processing

E2E tests:

Scenario 1:
login
→ create client
→ matter
→ case
→ hearing
→ dashboard

Scenario 2:
create invoice
→ issue
→ email notification created
→ partial payment
→ balance changes

Scenario 3:
complete hearing
→ next date
→ task
→ client email queued

Scenario 4:
overdue invoice
→ workflow
→ reminder queued

Scenario 5:
organization A attempts organization B data access
→ request denied

==================================================
SEED DATA
==================================================

Create development seed data for:

Organization:
Sharma & Associates

Users:
partner@example.com / owner
lawyer@example.com / lawyer
clerk@example.com / staff
finance@example.com / finance

Create realistic clients, cases, hearings, tasks and invoices.

Include:
- one paid invoice
- one partial invoice
- one overdue invoice
- one upcoming invoice
- hearings today
- hearing tomorrow
- overdue task
- upcoming task

==================================================
DEV EXPERIENCE
==================================================

Provide:

- README
- setup instructions
- .env.example
- Docker Compose
- migrations
- seed command
- test command
- lint command
- format command
- production build command

Local dependencies should start with:

Postgres
Redis
optional MinIO

==================================================
IMPLEMENTATION PHASING
==================================================

Implement in this order:

PHASE 1
Foundation
Auth
Multi-tenancy
RBAC
DB migrations
UI shell

PHASE 2
Clients
Matters
Cases
Parties
Timeline
Search

PHASE 3
Hearings
Calendar
Tasks
Dashboard

PHASE 4
Fee agreements
Milestones
Invoices
Payments
Expenses
Ledger
Collections

PHASE 5
Email provider
Notifications
Outbox
Worker
Workflow engine
Templates

PHASE 6
Documents
Client portal
CSV import/export
Reports

PHASE 7
Tests
Security hardening
Performance
Deployment

==================================================
WHAT NOT TO DO
==================================================

Do not:
- add WhatsApp in V1
- add AI legal advice in V1
- build native apps
- build a giant visual workflow graph
- introduce microservices unnecessarily
- add Elasticsearch/OpenSearch prematurely
- add an ORM if simple SQL/repository code is clearer, but use parameterized queries and transactions
- put business logic in React components
- duplicate notification logic across modules
- bypass the outbox for email
- mutate historical financial records destructively
- fake court synchronization
- fake email delivery status
- claim integrations are working without real credentials/provider responses

==================================================
QUALITY BAR
==================================================

The result should feel like a serious SaaS product, not a CRUD demo.

Prioritize:

1. Correctness
2. Tenant security
3. Financial integrity
4. Workflow reliability
5. Mobile usability
6. Maintainability
7. Performance

Do not optimize prematurely, but do not knowingly create architecture that blocks the later addition of WhatsApp, online payments, court providers or AI.

==================================================
DELIVERABLES
==================================================

At the end, provide:

1. Working source code.
2. Database migrations.
3. Seed data.
4. API documentation.
5. README.
6. .env.example.
7. Test suite.
8. Docker Compose.
9. Architecture diagram in docs.
10. List of implemented features.
11. List of intentionally deferred features.
12. Known limitations.
13. Exact commands to run locally.

Before declaring success, run:

- tests
- lint
- typecheck
- production build

Fix failures rather than merely reporting them.

Do not stop at scaffolding. Implement complete vertical slices that are usable end-to-end.
```

---

# 62. First Pilot Acceptance Script

Use this exact script with the first law-firm pilot.

### Test 1 — Matter

Create:

`Sharma vs ABC`

Add client Raj Sharma.
Add case number.
Add court.
Add hearing for 10 Oct.

Expected:
- case visible in dashboard.
- hearing visible on calendar.

### Test 2 — Hearing automation

Configure:

1 day before → email client.

Expected:
- scheduled notification exists.
- test clock/job execution sends email.
- communication log records status.

### Test 3 — Hearing completed

Complete hearing.
Set next hearing to 22 Oct.
Add task “Prepare written submissions”.

Expected:
- timeline event.
- task assigned.
- client email queued if automation enabled.

### Test 4 — Invoice

Create ₹50,000 invoice due 15 Oct.

Expected:
- invoice total ₹50,000.
- outstanding ₹50,000.
- email created.

### Test 5 — Partial payment

Record ₹20,000 payment.

Expected:
- amount paid ₹20,000.
- amount due ₹30,000.
- invoice status PARTIALLY_PAID.
- receipt available.

### Test 6 — Overdue

Move system/test clock past due date.

Expected:
- invoice status OVERDUE.
- reminder workflow runs once per configured threshold.

### Test 7 — Security

Create second organization.
Attempt to access first organization records.

Expected:
- access denied.
- no record leakage.

---

# 63. Product North Star

The north-star experience for LegalOps is not a giant feature list.

It is this:

> **Open LegalOps and immediately know what changed, what needs action, which clients need communication, and how much money needs to be collected.**

Everything in V1 should reinforce that behavior.
