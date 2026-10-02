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
