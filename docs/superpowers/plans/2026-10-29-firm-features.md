# Per-firm features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Platform admins switch six features (Documents, Billing, Communication, Automations, Diary & printouts, Calendar sync) on or off per firm. A switched-off feature disappears from that firm's app, its server routes return 404, and its scheduled emails are skipped.

**Architecture:**
- One `FEATURES` list in `@legalops/types` declares the features, and a permission→feature map ties existing permissions to them.
- Overrides live in a new `organization_features` table. No row means the feature's `defaultEnabled`.
- The session loader resolves the firm's enabled features onto the request context. Route guards, permission checks, the worker and the web app all read them from there.

**Tech Stack:** pnpm monorepo. Express 5 API with tagged-template SQL on `pg`, Zod validation, Vitest + supertest against Postgres `legalops_test` (port 5433). React 19 + TanStack Query web app. `@legalops/ui` components.

**Spec:** `docs/superpowers/specs/2026-10-29-firm-features-design.md`

## Global Constraints
- **Feature keys and defaults:** exactly `documents`, `billing`, `communication`, `automations`, `diary`, `calendar_sync`, all with `defaultEnabled: true`. Features added later default to `false`.
- **Switched off, the server answers HTTP 404**, code `FEATURE_DISABLED`, message `This isn’t available for your firm.` (curly apostrophe, matching existing copy).
- **Worker skip reason:** `feature_off:<key>`, stored in `scheduled_actions.result.reason`. A skipped action is never sent later.
- **Platform audit actions:** `firm.feature_enabled` and `firm.feature_disabled`, with details `{ feature: <key> }`.
- **Nothing is deleted** when a feature is switched off.
- **Migration** `packages/db/migrations/0014_organization_features.sql`. Append-only, one per feature.
- **Never `git commit`.** The owner (Umang) commits. Each task ends with a suggested commit message instead.
- **Branch:** `feature/firm-features`, created from up-to-date `origin/main`, which already contains the documents work.
- **Quality bar:** `pnpm test`, `pnpm typecheck` and `pnpm lint` must be clean at the end of every task. Test files run one server per file, using the helpers in `apps/api/test/helpers.ts`.

## Review Focus
1. **Permission switched off for a role that has it.** An owner calling `POST /invoices` with Billing off must get 404 `FEATURE_DISABLED`, not 403 and not 201. Task 3 tests this.
2. **Features change mid-session.** Switching Billing off while a firm user is signed in takes effect on that user's next request, with no new login. Task 3 tests this.
3. **The firm has data, and the feature is switched off then on.** Earlier invoices and documents are all listed again. Task 3 tests this, and Task 9 checks it in the browser.
4. **Firm-created rule on a billing trigger, with Automations on and Billing off.** It is skipped as `feature_off:billing`. Task 5 tests this.
5. **The platform sets a feature to the value it already has.** The call succeeds, writes a row and is audited once, and the next GET shows it as set, not default. Task 6 tests this.

---

### Task 1: Feature list and permission mapping (types + validation)

**Files:**
- Create: `packages/types/src/features.ts`
- Create: `packages/types/src/features.test.ts`
- Modify: `packages/types/src/index.ts` (export it)
- Modify: `packages/types/src/api.ts` (`MeResponse` gains `features: readonly FeatureKey[]`)
- Modify: `packages/types/src/platform.ts` (add `PlatformFirmFeature`)
- Modify: `packages/validation/src/platform.ts` (add `setFirmFeatureSchema` next to `firmNotesSchema`)

**Interfaces:**
- Produces:
  - `type FeatureDef = { key: string; label: string; description: string; defaultEnabled: boolean }`
  - `FEATURES` (readonly array, `as const satisfies readonly FeatureDef[]`)
  - `type FeatureKey`, `FEATURE_KEYS: readonly FeatureKey[]`, `isFeatureKey(k: string): k is FeatureKey`
  - `PERMISSION_FEATURE: Partial<Record<Permission, FeatureKey>>`
  - `resolveFeatures(overrides: Partial<Record<string, boolean>>, defs: readonly FeatureDef[] = FEATURES): FeatureKey[]`: returns, in `defs` order, each key whose override is true, or whose `defaultEnabled` is true when it has no override. Unknown override keys are ignored.
  - `canWithFeatures(role: Role, features: readonly FeatureKey[], permission: Permission): boolean`: `can(role, permission)`, and the permission's feature (if any) is in `features`.
  - `type PlatformFirmFeature = { key: FeatureKey; label: string; description: string; enabled: boolean; isDefault: boolean; setBy: string | null; setAt: string | null }`
  - `setFirmFeatureSchema = z.object({ enabled: z.boolean() })`

- [ ] **Step 0: Branch.** Run `git fetch origin && git switch -c feature/firm-features origin/main`. Check that `git log --oneline -3` shows the documents commit.
- [ ] **Step 1: Write failing tests** in `features.test.ts`:
  - `resolveFeatures({})` equals `['documents','billing','communication','automations','diary','calendar_sync']`.
  - `resolveFeatures({ billing: false, nonsense: true })` leaves out `billing` and contains no `nonsense`.
  - With `defs = [...FEATURES, { key: 'later', label: 'Later', description: '', defaultEnabled: false }]`, `resolveFeatures({}, defs)` leaves out `later`, and `resolveFeatures({ later: true }, defs)` contains it.
  - `canWithFeatures('owner', [], 'invoices.manage') === false`, and `canWithFeatures('owner', ['billing'], 'invoices.manage') === true`.
  - `canWithFeatures('owner', [], 'matters.view') === true` (core).
  - `canWithFeatures('read_only', ['billing'], 'invoices.manage') === false` (the role still applies).
  - Every permission starting with `documents.` maps to `documents`; `billing.view`, `invoices.manage`, `payments.record` and `finance.dashboard` map to `billing`; `workflows.manage` and `templates.manage` map to `automations`.
- [ ] **Step 2: Run** `pnpm --filter @legalops/types test`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `features.ts`.** Labels match the spec table (`Documents`, `Billing`, `Communication`, `Automations`, `Diary & printouts`, `Calendar sync`). Descriptions are one sentence each, written for the platform console, saying what the firm gets, e.g. "Upload and view case papers and orders on matters and hearings." Export everything from `index.ts`. Add `features` to `MeResponse`, add `PlatformFirmFeature`, and add `setFirmFeatureSchema` next to `firmNotesSchema`.
- [ ] **Step 4: Run** `pnpm --filter @legalops/types test && pnpm --filter @legalops/validation test`. Expected: PASS. `pnpm typecheck` will now fail in the API and web because `MeResponse.features` is missing; Task 3 fixes that.
- [ ] **Step 5: Suggest commit:** `Feature list: per-firm switchable features and their permission mapping`.

### Task 2: Storage — `organization_features` and the feature service

**Files:**
- Create: `packages/db/migrations/0014_organization_features.sql`
- Create: `apps/api/src/modules/features/features.service.ts`
- Create: `apps/api/test/features.test.ts`

**Interfaces:**
- Consumes: `resolveFeatures`, `FeatureKey`, `isFeatureKey` (Task 1).
- Produces:
  - `loadEnabledFeatures(db: Db, organizationId: string): Promise<FeatureKey[]>`
  - `listFirmFeatures(db: Db, organizationId: string): Promise<PlatformFirmFeature[]>`. `setBy` is the platform admin's name.
  - `setFirmFeature(db: Db, organizationId: string, key: FeatureKey, enabled: boolean, adminId: string): Promise<void>`. Upsert, which sets `updated_by` and `updated_at = now()`.

**Migration:** table `organization_features`:
- `organization_id UUID NOT NULL REFERENCES organizations(id)`
- `feature_key VARCHAR(64) NOT NULL`
- `enabled BOOLEAN NOT NULL`
- `updated_by UUID REFERENCES platform_admins(id)` (the table from migration 0007)
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `PRIMARY KEY (organization_id, feature_key)`

Add a header comment explaining that no row means the code default, and that keys are deliberately unconstrained.

- [ ] **Step 1: Write failing tests** in `features.test.ts`, using `createFirm` from the helpers and a platform admin from `platform-helpers.ts`:
  - A new firm's `loadEnabledFeatures` returns all six.
  - After `setFirmFeature(pool, org, 'billing', false, adminId)` it leaves out `billing`.
  - After setting it back to `true`, `billing` is included.
  - `listFirmFeatures` returns 6 entries. `billing` has `isDefault: false`, `setBy` equal to the admin's name and a non-null `setAt`. `documents` has `isDefault: true` and `setBy: null`.
  - A row with an unknown `feature_key` inserted by SQL is ignored by both functions.
- [ ] **Step 2: Run** `pnpm --filter @legalops/api exec vitest run test/features.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the migration and the service.** Apply it with `pnpm db:migrate`, then check that the test database picks it up through `global-setup.ts`.
- [ ] **Step 4: Run** the same test file, then `pnpm --filter @legalops/db test`. Expected: PASS, and DB invariants pass.
- [ ] **Step 5: Suggest commit:** `organization_features table and feature lookup`.

### Task 3: Server enforcement — context, guards, routers, `/auth/me`

**Files:**
- Modify: `apps/api/src/http/context.ts`. `TenantContext` gains `features: readonly FeatureKey[]`.
- Modify: `apps/api/src/modules/auth/auth.service.ts`:
  - `loadSession` adds `features: await loadEnabledFeatures(deps.pool, row.organization_id)`
  - `getMe` returns `features`, and `permissions` filtered by `canWithFeatures`
- Modify: `apps/api/src/middleware/security.ts`:
  - `tenant()` passes `features` through
  - `requirePermission` returns 404 `FEATURE_DISABLED` when the role has the permission but its feature is off, and 403 as now when the role lacks it
  - add `requireFeature`
  - add `allowed`
- Modify: `apps/api/src/http/errors.ts`. Add `featureDisabled()` next to `forbidden` (line 16).
- Modify: `apps/api/src/app.ts`. Wrap the feature routers:
  - `/documents` → `documents`
  - `/invoices`, `/payments`, `/expenses`, `/fee-agreements`, `/fee-milestones`, `/billing` → `billing`
  - `/notifications` → `communication`
  - `/workflows`, `/email-templates` → `automations`
  - `/calendar-feed` → `calendar_sync`
- Modify: `apps/api/src/modules/hearings/hearings.routes.ts`. Add `requireFeature('diary')` on `GET /diary`, declared before `/:hearingId` as now.
- Modify these `TenantContext` builders to supply `features` through `loadEnabledFeatures`: `apps/api/src/modules/workflows/engine.ts` (`systemActor`), `apps/api/src/modules/calendar/calendar-feed.service.ts:78`, `apps/api/src/scripts/seed-demo.ts:39`.
- Create: `apps/api/test/firm-features.test.ts`

**Interfaces:**
- Consumes: `loadEnabledFeatures`, `setFirmFeature` (Task 2); `canWithFeatures`, `PERMISSION_FEATURE` (Task 1).
- Produces:
  - `requireFeature(key: FeatureKey): RequestHandler`. Responds 404 `FEATURE_DISABLED` when `req.auth` lacks the feature; responds 401 when there is no session.
  - `allowed(ctx: TenantContext, permission: Permission): boolean`, which is `canWithFeatures(ctx.role, ctx.features, permission)`.
  - `featureDisabled(): AppError`.

In tests, switch features with `setFirmFeature` directly. The platform API comes in Task 6.

- [ ] **Step 1: Write failing tests** in `firm-features.test.ts`, using `practiceFixture`:
  - With `billing` off for firm A, the owner's `GET /api/v1/invoices` is 404 with `body.error.code === 'FEATURE_DISABLED'`. Check `error-handler.ts` for the actual envelope shape. `POST /api/v1/invoices` is also 404, not 403 or 201 (Review Focus 1).
  - For each of `documents` (`GET /documents?matterId=`), `communication` (`GET /notifications`), `automations` (`GET /workflows`), `diary` (`GET /hearings/diary`) and `calendar_sync` (`GET /calendar-feed`): 404 `FEATURE_DISABLED` when off, 200 when on.
  - Mid-session (Review Focus 2): sign in, get 200 from `GET /invoices`, switch `billing` off, and the same session gets 404 on the next request.
  - Data survives (Review Focus 3): create an invoice, switch `billing` off then on, and `GET /invoices` lists the invoice again.
  - `GET /auth/me` with `billing` off: `features` lacks `billing`, and `permissions` lacks `invoices.manage`.
  - A lawyer (who lacks `invoices.manage`) gets 403 on `POST /invoices` while Billing is on, so the role check is unchanged.
  - Firm B's switches don't affect firm A. Use `createFirm` for B.
- [ ] **Step 2: Run** `pnpm --filter @legalops/api exec vitest run test/firm-features.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the context, guards and router wrapping above. Mount them as `api.use('/invoices', requireFeature('billing'), invoicesRouter(deps))`, and so on. `requireFeature` must run after `sessionLoader`, which it does when mounted inside `api`.
- [ ] **Step 4: Run** the test file, then the whole API suite: `pnpm --filter @legalops/api test`. Expected: PASS, with all earlier tests still green, since every feature defaults on.
- [ ] **Step 5: Suggest commit:** `Enforce per-firm features on the API: 404 FEATURE_DISABLED, /auth/me features`.

### Task 4: Feature data inside core pages, and the public calendar link

**Files:**
- Modify: `apps/api/src/modules/search/search.service.ts:18,43`. Change `can(ctx.role, …)` to `allowed(ctx, …)`, so invoices are left out when Billing is off.
- Modify: `apps/api/src/modules/dashboard/dashboard.service.ts:98`. Use `allowed(ctx, 'finance.dashboard')`, so `money` is `null` when Billing is off.
- Modify: `apps/api/src/modules/tasks/tasks.service.ts:304`. Use `allowed`; this is behaviour-neutral but consistent.
- Modify: `apps/api/src/modules/calendar/calendar-feed.service.ts`. The public `.ics` lookup returns the same 404 as an unknown token when the firm's `calendar_sync` is off.
- Test: append to `apps/api/test/firm-features.test.ts`.

**Interfaces:** Consumes `allowed` and `loadEnabledFeatures`.

- [ ] **Step 1: Write failing tests:**
  - Search for an invoice number returns it while Billing is on, and returns `invoices: []` while it's off.
  - `GET /dashboard` for the owner has non-null money figures while Billing is on, and `null` while off. Use the field name from `dashboard.service.ts`.
  - A calendar feed created while on: `GET /api/v1/ical/<token>.ics` returns 200, then 404 once `calendar_sync` is off, then 200 again once it's on.
- [ ] **Step 2: Run** the file. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as listed above.
- [ ] **Step 4: Run** `pnpm --filter @legalops/api test`. Expected: PASS.
- [ ] **Step 5: Suggest commit:** `Hide billing data in search and dashboard when Billing is off; calendar links stop when Calendar sync is off`.

### Task 5: Worker — skip actions for switched-off features

**Files:**
- Modify: `apps/api/src/modules/workflows/engine.ts`:
  - add `system_key: string | null` to `WorkflowRow`
  - add `workflowFeatures`
  - in `executeScheduledAction`, after the `!wf.is_active` check, skip when a required feature is off
  - in the `notify` case, skip with `feature_off:communication` when `wf.requires_approval` and `communication` is off
- Test: append to `apps/api/test/automation.test.ts`, reusing its `setup()` and `run`.

**Interfaces:**
- Consumes: `loadEnabledFeatures` (Task 2), `setFirmFeature`.
- Produces: `workflowFeatures(wf: Pick<WorkflowRow, 'system_key' | 'trigger_type'>): FeatureKey[]`:
  - adds `billing` when `trigger_type` is one of `INVOICE_CREATED`, `INVOICE_PAID`, `PAYMENT_RECEIVED`
  - adds `automations` when `system_key` is null (a firm-created rule)
  - returns an empty list otherwise

Skips call the existing `finish('skipped', { reason: `feature_off:${key}` })`, using the first missing feature in the list's order.

- [ ] **Step 1: Write failing tests:**
  - Issue an invoice with a due date, switch `billing` off, and run the worker at the due-date reminder time. No email reaches the client, and a `scheduled_actions` row is `skipped` with `result->>'reason' = 'feature_off:billing'`.
  - With `automations` off, a firm-created rule on `HEARING_SCHEDULED` (created through `POST /workflows` while on) is skipped with `feature_off:automations`, while the built-in `hearing_1d_client` reminder still emails the client.
  - Review Focus 4: a firm-created rule on `INVOICE_CREATED`, with Automations on and Billing off, is skipped with `feature_off:billing`.
  - With `communication` off, a rule with `requires_approval: true` is skipped with `feature_off:communication`, and no notification is left `awaiting_approval`.
  - Switching a feature back on doesn't resend skipped actions: re-run at a later time and the client email count is unchanged.
- [ ] **Step 2: Run** `pnpm --filter @legalops/api exec vitest run test/automation.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as above. Load the features once per action, inside the transaction, with `loadEnabledFeatures(tx, sa.organization_id)`.
- [ ] **Step 4: Run** `pnpm --filter @legalops/api test`. Expected: PASS.
- [ ] **Step 5: Suggest commit:** `Worker skips scheduled actions of switched-off features (feature_off:<key>)`.

### Task 6: Platform API — list and set a firm's features

**Files:**
- Modify: `apps/api/src/modules/platform/platform-firms.service.ts`. Add `getFirmFeatures` and `setFirmFeatureAsAdmin`.
- Modify: `apps/api/src/modules/platform/platform.routes.ts`. Add these after `requirePlatformMfa`, next to the firm routes:
  - `GET /firms/:firmId/features`
  - `PATCH /firms/:firmId/features/:key`
- Create: `apps/api/test/platform-features.test.ts`

**Interfaces:**
- Consumes: `listFirmFeatures`, `setFirmFeature` (Task 2), `setFirmFeatureSchema`, `isFeatureKey` (Task 1), `recordPlatformAudit`.
- Produces:
  - `getFirmFeatures(db: Db, firmId: string): Promise<PlatformFirmFeature[]>`. Throws 404 for an unknown firm.
  - `setFirmFeatureAsAdmin(deps: Deps, auth: PlatformAuth, firmId: string, key: FeatureKey, enabled: boolean, meta: RequestMeta): Promise<PlatformFirmFeature[]>`. Runs in one transaction: upsert, then `recordPlatformAudit` (`firm.feature_enabled` / `firm.feature_disabled`, `details: { feature: key }`, `ip: meta.ip`). Returns the updated list.
  - `PATCH` responds `{ data: PlatformFirmFeature[] }`. An unknown `:key` is 422, validated with `isFeatureKey` and the project's validation error.

- [ ] **Step 1: Write failing tests**, using `createPlatformAdmin` and `platformLogin` from `platform-helpers.ts` (pattern in `platform-invite-links.test.ts`):
  - `GET` lists 6 features, all `enabled: true` and `isDefault: true`.
  - `PATCH .../features/billing { enabled: false }` returns 200, and `billing` is now `enabled: false, isDefault: false, setBy: <admin name>`.
  - That firm's owner then gets 404 on `GET /api/v1/invoices`.
  - The firm's `GET /platform/firms/:id` history includes a `firm.feature_disabled` entry with `details.feature === 'billing'`.
  - Review Focus 5: `PATCH documents { enabled: true }` while it's already on returns 200, writes exactly one audit row (`firm.feature_enabled`), and the next `GET` shows `documents` with `isDefault: false`.
  - `PATCH .../features/nonsense` gets 422.
  - An unknown firm id gets 404.
  - Without the CSRF header the PATCH is refused, and a session without verified MFA is refused. Copy the assertion shape from `platform-auth.test.ts`.
  - It works while the firm is suspended.
- [ ] **Step 2: Run** `pnpm --filter @legalops/api exec vitest run test/platform-features.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `pnpm --filter @legalops/api test`. Expected: PASS.
- [ ] **Step 5: Suggest commit:** `Platform console API: list and switch a firm's features (audited)`.

### Task 7: Firm web app — hide switched-off features

**Files:**
- Modify: `apps/web/src/lib/auth.ts`:
  - `canAct` also requires the permission's feature (`canWithFeatures(me.role, me.features, permission)`, keeping the suspension check first)
  - add `hasFeature(me: MeResponse, key: FeatureKey): boolean`
  - add `useFeature(key: FeatureKey): boolean`
- Modify: `apps/web/src/components/layout/guards.tsx`:
  - `RequirePermission` renders `<NotFound />` when the role has the permission but its feature is off
  - add `RequireFeature({ feature, children })`, which renders `<NotFound />` when off
- Modify: `apps/web/src/components/layout/nav.ts`. `NavItem` gains an optional `feature?: FeatureKey`. Set `feature: 'communication'` on Communication and `feature: 'calendar_sync'` on Calendar sync. Billing and Automations are already covered by their permissions. Then update the filters in `AppShell.tsx` and `MorePage.tsx` to also apply `hasFeature`.
- Modify: `apps/web/src/App.tsx`. Wrap `/diary` and `/matters/:matterId/history` in `RequireFeature feature="diary"`, `/communication` in `communication`, and `/settings/calendar` in `calendar_sync`, inside the existing permission guards.
- Modify: `apps/web/src/features/matters/MatterDetailPage.tsx`:
  - the tabs list drops `documents`, `billing` and `communication` when their feature is off
  - the quick actions drop "Add documents" (documents), "Invoice" (billing), "Client update" (communication) and "Print history" (diary)
  - a `?tab=` naming a hidden tab falls back to `overview`
- Modify: `apps/web/src/features/hearings/HearingDetailPage.tsx`. Hide `HearingDocumentsCard` when Documents is off.
- Modify: `apps/web/src/features/hearings/CompleteHearingSheet.tsx`. Hide the "Attach the order" field when Documents is off.
- Modify: `apps/web/src/features/diary/MatterHistoryPrintPage.tsx`. Don't fetch documents when Documents is off.
- Modify: `apps/web/src/features/calendar/CalendarPage.tsx:84`. Hide the `/diary` link when Diary is off.
- Modify: `apps/web/src/features/settings/FirmSettingsPage.tsx`. Hide the "Hide parties in synced calendars" checkbox when Calendar sync is off. It must still be submitted unchanged, so keep it in the form values.
- Modify: `apps/web/src/features/clients/ClientDetailPage.tsx`. Make sure `ClientBilling` is gated by `canAct(me, 'billing.view')`; add the check if it's missing.
- Modify: the web test fixtures that build a `MeResponse`, if any (`grep -rn "permissions:" apps/web/src --include=*.test.*`). Add `features`.

**Interfaces:** Consumes `MeResponse.features`, `canWithFeatures`, `PERMISSION_FEATURE` and `FeatureKey` (Task 1).

- [ ] **Step 1: Run** `pnpm typecheck`. Expected: errors only where `MeResponse` objects are built without `features`; fix those first.
- [ ] **Step 2: Implement** the changes listed above.
- [ ] **Step 3: Run** `pnpm typecheck && pnpm lint && pnpm --filter @legalops/web test` (skip the last if the web package has no test script). Expected: clean.
- [ ] **Step 4: Browser check.** Use the `legalops-api` and `legalops-web` previews, signed in as the seed partner, and switch features with SQL on the dev DB (`INSERT INTO organization_features … ON CONFLICT DO UPDATE`):
  - With `documents`, `billing` and `diary` off, the matter shows no Documents, Billing, "Add documents", "Invoice" or "Print history". The sidebar has no Billing. The hearing page has no "Orders & documents". The outcome sheet has no order field. `/diary` shows Not Found.
  - Turn them back on and everything returns with the earlier data.
  - Take one screenshot of each state.
- [ ] **Step 5: Suggest commit:** `Firm app hides switched-off features (menus, tabs, actions, routes show Not Found)`.

### Task 8: Platform console — Features card

**Files:**
- Create: `apps/web/src/platform/FirmFeaturesCard.tsx`
- Modify: `apps/web/src/platform/FirmDetailPage.tsx`. Render `<FirmFeaturesCard firmId={f.id} />` after the Notes card, and invalidate the firm query after a change so History refreshes.

**Interfaces:**
- Consumes: `GET` and `PATCH /platform/firms/:id/features[/:key]` (Task 6), via `platformApi.get` and `platformApi.patch`; `PlatformFirmFeature`.
- Produces: `FirmFeaturesCard({ firmId }: { firmId: string })`.

**Behaviour:**
- A `Card` titled "Features", with one row per feature: label, description, and a switch (an accessible checkbox styled as the app's toggle; reuse one if `@legalops/ui` has it).
- Under each label: "Default", or "Set by {setBy}, {date}".
- **Turning on** saves immediately.
- **Turning off** first opens a `Sheet`, titled "Switch off {label}?", with the text `Their team will no longer see {label}. Nothing is deleted, and switching it back on restores everything.` and buttons Cancel and Switch off (variant `danger`). This follows the delete confirmation in `apps/web/src/features/documents/DocumentList.tsx`.
- **Errors** show as an `Alert` in the card. A switch is disabled while its save is pending.

- [ ] **Step 1: Implement** the card and render it on the firm page.
- [ ] **Step 2: Run** `pnpm typecheck && pnpm lint`. Expected: clean.
- [ ] **Step 3: Browser check**, signed in to `/platform` with a platform admin (create one with `create-admin` against the dev DB if needed; never paste secrets into chat):
  - Switch Billing off for the seed firm through the card. The confirmation appears, the row shows "Set by …", and History shows `firm.feature_disabled`.
  - In the firm tab, after a reload, Billing is gone.
  - Switch it back on.
- [ ] **Step 4: Suggest commit:** `Platform console: per-firm Features card`.

### Task 9: Whole-branch verification and handoff notes

**Files:**
- Modify: `infra/docs/HANDOFF.md`. Add one line under "Remaining work": migration 0014 runs on the next deploy, and every firm keeps all current features until switched in the console.
- Modify: the memory file `project-legalops.md` (outside the repo), with status and branch.

- [ ] **Step 1: Run** `pnpm test && pnpm typecheck && pnpm lint`. Expected: all green, with API test count = the previous 191 plus the new ones.
- [ ] **Step 2: Browser check end to end** (Review Focus 3, all through the UI, no SQL):
  - Platform console: switch Documents and Billing off for the seed firm.
  - Firm app: the menus, tabs and buttons are gone, and the typed URLs `/billing` and `/matters/<id>?tab=documents` don't expose them.
  - Console: switch both back on.
  - Firm app: the earlier documents and invoices are all present.
- [ ] **Step 3: Report** to the owner with a suggested commit command that leaves out the untracked `infra/scripts/backup-db.sh`, `compose.sh`, `restore-db.sh` and `infra/systemd/`.
