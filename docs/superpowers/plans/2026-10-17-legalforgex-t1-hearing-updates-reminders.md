# LegalForgeX Track 1 — Hearing Updates & Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop internal hearing notes from ever reaching clients, give each hearing an optional client-facing summary, and send the full day-before / on-the-day reminder matrix to lawyers and clients with the latest update in each email.

**Architecture:** A new `hearings.client_summary` column holds client-facing text; the existing `outcome` stays the team's internal note. Template variables carry an `internalOnly` flag in `@legalops/types`; one function (`varsForAudience`) strips those variables before any client-bound render, and template saving rejects them in client templates. Default automations are offered to each firm once per key (`settings.seededWorkflowKeys`), so the two new reminders reach existing firms without resurrecting deleted ones.

**Tech Stack:** Postgres 16 migrations (plain SQL), Express 5 + TypeScript API, Zod validation, Vitest + supertest, React + TanStack Query web app.

**Spec:** `docs/superpowers/specs/2026-10-17-legalforgex-phase1-design.md` (§3.6, §3.7, §5.4, §5.5, §9 items 6–7). Roadmap: `docs/superpowers/plans/2026-10-17-legalforgex-phase1-roadmap.md`.

## Global Constraints

- **Never run `git commit`.** Stop at each checkpoint; the repo owner commits.
- New migration file is `packages/db/migrations/0006_hearing_client_updates.sql`; never edit `0001`–`0005`.
- API field for the internal note stays `outcome` (no API rename); UI labels it "Internal note (team only)".
- Client summary max length 2000 characters; blank/whitespace-only means "none".
- Neutral fallback wording, exactly: adjourned → `The hearing on {date} was adjourned.`; completed → `The hearing on {date} was held.` (`{date}` formatted like other dates, e.g. `12 Oct 2026`).
- Reminder defaults (firm-local time): `hearing_1d_team` −1 day 17:00 → matter team; `hearing_1d_client` −1 day 09:00 → client (exists); `hearing_morning_client` same day 07:30 → client; `hearing_morning_lead` same day 08:00 → lead (exists). Existing 7-day and 3-day reminders unchanged.
- Any new user-visible string says "LegalForgeX", never "LegalOps".
- Run before each checkpoint: `pnpm --filter @legalops/api test`, `pnpm typecheck`, `pnpm lint` — all clean.

**Deviation from spec, deliberate:** spec §5.4 names the last-update variables `case.last_client_update`; they live in a separate `previous.*` group because `buildContext` rebuilds the `case` group after the hearing group and would overwrite them. Spec is updated in Task 6.

## Review Focus

1. **A firm's own override of a client template that already contains `{{hearing.outcome}}`** — expected: after migration it reads `{{hearing.client_summary}}`; and even a row that somehow still contains it renders blank for a client. Test: Task 3, step 1 (`legacy override`).
2. **Client summary that is only whitespace** — expected: treated as none; the client gets the neutral line. Test: Task 1 step 1 and Task 2 step 1.
3. **Reminder for the first hearing of a case (no earlier hearing)** — expected: no "Update from the last hearing" text at all, no stray label. Test: Task 2 step 1 (`first hearing`).
4. **A firm that deleted a default automation before this release** — expected: it stays deleted; only the two new keys are added. Test: Task 4 step 1 (`deleted default`).
5. **Approval mode for the outcome email** — expected: the held message a lawyer approves contains the client summary, never the internal note. Test: Task 3 step 1 (`approval mode`).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/migrations/0006_hearing_client_updates.sql` (create) | `client_summary` column; system template updates + new `hearing_today_client`; rewrite firm client-template overrides; initialise `seededWorkflowKeys` |
| `packages/validation/src/work.ts` (modify) | `clientSummary` on `completeHearingSchema` |
| `packages/types/src/dtos.ts` (modify) | `HearingDto.clientSummary` |
| `packages/types/src/workflows.ts` (modify) | `internalOnly` flag, new variables, `INTERNAL_ONLY_VARIABLES` |
| `apps/api/src/modules/hearings/hearings.service.ts` (modify) | persist + return `client_summary` |
| `apps/api/src/modules/notifications/context.ts` (modify) | `hearing.client_summary` with fallback; `previous.*` group |
| `apps/api/src/modules/templates/audience.ts` (create) | `varsForAudience`, `internalOnlyUsed` |
| `apps/api/src/modules/templates/audience.test.ts` (create) | unit tests |
| `apps/api/src/modules/templates/templates.service.ts` (modify) | audience-aware validation + preview |
| `apps/api/src/modules/notifications/notifications.service.ts` (modify) | scope vars before rendering |
| `packages/validation/src/automation.ts` (modify) | `audience` on `templatePreviewSchema` |
| `apps/api/src/modules/workflows/defaults.ts` (modify) | two new defaults; per-key seeding |
| `apps/api/test/hearings.test.ts`, `apps/api/test/automation.test.ts` (modify), `apps/api/test/workflow-seeding.test.ts` (create) | integration tests |
| `apps/web/src/features/hearings/CompleteHearingSheet.tsx`, `HearingDetailPage.tsx` (modify) | two fields; show both texts |
| `docs/decisions.md`, spec (modify) | D-013 record; spec variable names |

---

### Task 1: Store the client summary separately from the internal note

**Files:**
- Create: `packages/db/migrations/0006_hearing_client_updates.sql`
- Modify: `packages/validation/src/work.ts:56-65`
- Modify: `packages/types/src/dtos.ts:159-185`
- Modify: `apps/api/src/modules/hearings/hearings.service.ts` (row type ~L40-50, SELECT ~L57-58, DTO map ~L89-93, UPDATE ~L394-399)
- Test: `apps/api/test/hearings.test.ts`

**Interfaces:**
- Produces: DB column `hearings.client_summary TEXT`; `completeHearingSchema` field `clientSummary: string | null | undefined` (trimmed, `''`→`null`, max 2000); `HearingDto.clientSummary: string | null`; system template `hearing_today_client` (audience `client`); org setting `settings.seededWorkflowKeys: string[]` initialised for already-seeded firms.

- [ ] **Step 1: Write the failing tests** — append inside `describe('hearings', …)` in `apps/api/test/hearings.test.ts`:

```ts
  it('stores the client update separately from the internal note', async () => {
    const { owner, main, today } = await practiceFixture(app);
    const h = await owner.agent.post('/api/v1/hearings').set('X-CSRF-Token', owner.csrf).send({ caseId: main.caseId, scheduledDate: today });
    const done = await owner.agent
      .post(`/api/v1/hearings/${h.body.data.id}/complete`)
      .set('X-CSRF-Token', owner.csrf)
      .send({
        result: 'adjourned',
        outcome: 'Judge unconvinced on limitation; consider settlement',
        clientSummary: '  The court gave the other side time to file a reply.  ',
        nextHearingDate: addDays(today, 14),
      });
    expect(done.status).toBe(200);
    expect(done.body.data.hearing).toMatchObject({
      outcome: 'Judge unconvinced on limitation; consider settlement',
      clientSummary: 'The court gave the other side time to file a reply.',
    });
    const got = await owner.agent.get(`/api/v1/hearings/${h.body.data.id}`);
    expect(got.body.data.clientSummary).toBe('The court gave the other side time to file a reply.');
  });

  it('treats a whitespace-only client update as none', async () => {
    const { owner, main, today } = await practiceFixture(app);
    const h = await owner.agent.post('/api/v1/hearings').set('X-CSRF-Token', owner.csrf).send({ caseId: main.caseId, scheduledDate: today });
    const done = await owner.agent
      .post(`/api/v1/hearings/${h.body.data.id}/complete`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ result: 'completed', outcome: 'Arguments heard', clientSummary: '   ' });
    expect(done.status).toBe(200);
    expect(done.body.data.hearing.clientSummary).toBeNull();
  });

  it('rejects a client update over 2000 characters', async () => {
    const { owner, main, today } = await practiceFixture(app);
    const h = await owner.agent.post('/api/v1/hearings').set('X-CSRF-Token', owner.csrf).send({ caseId: main.caseId, scheduledDate: today });
    const res = await owner.agent
      .post(`/api/v1/hearings/${h.body.data.id}/complete`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ result: 'completed', outcome: 'Arguments heard', clientSummary: 'x'.repeat(2001) });
    expect(res.status).toBe(422);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @legalops/api test -- test/hearings.test.ts`
Expected: FAIL — the first two fail with a 422 (`clientSummary` is rejected by the strict schema) or `clientSummary` undefined.

- [ ] **Step 3: Write the migration** — create `packages/db/migrations/0006_hearing_client_updates.sql`:

```sql
-- LegalForgeX Track 1 (spec §3.6, §3.7, §5.4, §5.5).
-- hearings.outcome is the team's internal note; client_summary is the only hearing text a client may see.
-- Existing outcomes were written for the team, so they are never copied into client_summary.
ALTER TABLE hearings ADD COLUMN client_summary TEXT;

-- System templates: client emails use the client summary; reminders carry the last hearing's update.
UPDATE email_templates SET html_body =
 '<p>Dear {{client.name}},</p><p>Update from our office on <strong>{{matter.title}}</strong> ({{case.case_number}}), heard on {{hearing.date}}:</p><p>{{hearing.client_summary}}</p><p>The next date of hearing is <strong>{{hearing.next_date}}</strong>.</p><p>This update was entered by our office; it is not an extract of the court record.</p><p>Regards,<br>{{firm.name}}</p>'
WHERE organization_id IS NULL AND template_key = 'hearing_outcome_client';

UPDATE email_templates SET html_body =
 '<p>Dear {{client.name}},</p><p>This is a reminder that the next hearing in your matter <strong>{{matter.title}}</strong> is scheduled for <strong>{{hearing.date}}</strong>{{hearing.time_phrase}}.</p><p>Court: {{case.court}}<br>Case number: {{case.case_number}}</p><p>{{previous.client_update_phrase}}</p><p>Please contact our office if you need any clarification.</p><p>Regards,<br>{{firm.name}}</p>'
WHERE organization_id IS NULL AND template_key = 'hearing_reminder_client';

UPDATE email_templates SET html_body =
 '<p>Hi {{recipient.first_name}},</p><p><strong>{{case.case_number}}</strong> ({{matter.title}}) is listed <strong>{{hearing.date}}</strong>{{hearing.time_phrase}} at {{case.court}}{{hearing.courtroom_phrase}}.</p><p>{{previous.internal_note_phrase}}</p><p>{{previous.client_update_phrase}}</p><p><a href="{{links.hearing}}">Open the hearing</a></p>'
WHERE organization_id IS NULL AND template_key = 'hearing_reminder_internal';

INSERT INTO email_templates (organization_id, template_key, name, event_type, audience, subject_template, html_body, text_body) VALUES
(NULL, 'hearing_today_client', 'Hearing today (client)', 'HEARING_SCHEDULED', 'client',
 'Today: your hearing for {{matter.title}}{{hearing.time_phrase}}',
 '<p>Dear {{client.name}},</p><p>Your hearing in <strong>{{matter.title}}</strong> is listed <strong>today</strong>{{hearing.time_phrase}} at {{case.court}}{{hearing.courtroom_phrase}}.</p><p>Case number: {{case.case_number}}</p><p>{{previous.client_update_phrase}}</p><p>Regards,<br>{{firm.name}}</p>',
 NULL);

-- Firms' own client-template overrides: the internal note variable becomes the client summary.
UPDATE email_templates SET
  subject_template = regexp_replace(subject_template, '\{\{\s*hearing\.outcome\s*\}\}', '{{hearing.client_summary}}', 'g'),
  html_body = regexp_replace(html_body, '\{\{\s*hearing\.outcome\s*\}\}', '{{hearing.client_summary}}', 'g'),
  text_body = regexp_replace(text_body, '\{\{\s*hearing\.outcome\s*\}\}', '{{hearing.client_summary}}', 'g')
WHERE organization_id IS NOT NULL AND audience = 'client';

-- Default automations are offered once per key (D-013). Firms already seeded have seen the original 13.
UPDATE organizations
SET settings = settings || jsonb_build_object('seededWorkflowKeys', '["hearing_7d_lead","hearing_3d_team","hearing_1d_client","hearing_morning_lead","hearing_outcome_client","task_assigned","invoice_issued","invoice_due_3d","invoice_due_today","invoice_overdue_3d","invoice_overdue_7d","invoice_overdue_15d","payment_received"]'::jsonb)
WHERE COALESCE((settings->>'defaultWorkflowsSeeded')::boolean, false);
```

- [ ] **Step 4: Add `clientSummary` to the schema** — in `packages/validation/src/work.ts`, inside `completeHearingSchema`'s object, after `outcome`:

```ts
    clientSummary: nullableText(2000),
```

- [ ] **Step 5: Add it to the DTO** — in `packages/types/src/dtos.ts`, in `HearingDto` after `outcome: string | null;`:

```ts
  /** Client-facing summary of the hearing. `outcome` is the team's internal note and is never emailed to clients. */
  clientSummary: string | null;
```

- [ ] **Step 6: Persist and return it** — in `apps/api/src/modules/hearings/hearings.service.ts`:
  - In the row type (near `outcome: string | null;`, ~L40) add `client_summary: string | null;`.
  - In the shared SELECT column list (~L57, after `h.outcome,`) add `h.client_summary,`.
  - In the DTO mapper (~L89, after `outcome: r.outcome,`) add `clientSummary: r.client_summary,`.
  - Replace the UPDATE in `completeHearing` (~L394-399) with:

```ts
    await query(
      tx,
      sql`UPDATE hearings SET status = ${input.result}, outcome = ${input.outcome}, client_summary = ${input.clientSummary ?? null},
            notes = COALESCE(${input.notes ?? null}, notes), next_hearing_date = ${input.nextHearingDate ?? null},
            completed_at = now(), completed_by = ${ctx.userId}
          WHERE id = ${id}`,
    );
```

- [ ] **Step 7: Apply the migration to dev and run the tests**

Run: `pnpm db:migrate` then `pnpm --filter @legalops/api test -- test/hearings.test.ts`
Expected: migration applies cleanly; all hearings tests PASS (the test DB is rebuilt from all migrations by `test/global-setup.ts`).

- [ ] **Step 8: Checkpoint** — run `pnpm typecheck`. Stop; suggested commit message for the owner: `feat(hearings): separate client summary from internal note (migration 0006)`.

---

### Task 2: Client-safe hearing text and last-hearing update in template context

**Files:**
- Modify: `apps/api/src/modules/notifications/context.ts` (hearing block ~L140-165)
- Modify: `packages/types/src/workflows.ts:218-247`
- Test: `apps/api/test/automation.test.ts`

**Interfaces:**
- Consumes: `hearings.client_summary` (Task 1); templates updated in `0006`.
- Produces: template variables
  - `hearing.client_summary` — summary, or neutral fallback for a completed/adjourned hearing, `''` for a scheduled one.
  - `previous.date`, `previous.client_update`, `previous.client_update_phrase` (client-safe).
  - `previous.internal_note`, `previous.internal_note_phrase` (team only).
  - `TEMPLATE_VARIABLES` entries gain optional `internalOnly?: true`; `INTERNAL_ONLY_VARIABLES: readonly string[]` exported from `@legalops/types`.

- [ ] **Step 1: Write the failing tests** — in `apps/api/test/automation.test.ts`, add a new `describe` after `'automations: hearing outcome (pilot test 3)'`:

```ts
describe('automations: what the client is told (LegalForgeX T1)', () => {
  const complete = (s: Session, id: string, body: object) => post(s, `/hearings/${id}/complete`, body);

  it('outcome email carries the client summary, never the internal note', async () => {
    const { owner, main, today, email, run } = await setup();
    const h = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: today });
    await complete(owner, h.body.data.id, {
      result: 'adjourned',
      outcome: 'SECRET-NOTE judge unconvinced',
      clientSummary: 'The court gave the other side time to reply.',
      nextHearingDate: addDays(today, 12),
    });
    await run(new Date());
    const [m] = email.to('raj@client.test');
    expect(m!.text).toContain('The court gave the other side time to reply.');
    expect(m!.text).not.toContain('SECRET-NOTE');
    expect(m!.html).not.toContain('SECRET-NOTE');
  });

  it('with no client summary, the client gets the neutral line', async () => {
    const { owner, main, today, email, run } = await setup();
    const h = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: today });
    await complete(owner, h.body.data.id, { result: 'adjourned', outcome: 'SECRET-NOTE', clientSummary: '  ', nextHearingDate: addDays(today, 12) });
    await run(new Date());
    const [m] = email.to('raj@client.test');
    expect(m!.text).toMatch(/The hearing on \d{1,2} \w{3} \d{4} was adjourned\./);
    expect(m!.text).not.toContain('SECRET-NOTE');
  });

  it('day-before client reminder includes the last hearing update; team reminder also has the internal note', async () => {
    const { owner, main, today, email, run } = await setup();
    const first = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: today });
    const next = addDays(today, 6);
    await complete(owner, first.body.data.id, {
      result: 'adjourned',
      outcome: 'SECRET-NOTE push settlement',
      clientSummary: 'Reply to be filed by the other side.',
      nextHearingDate: next,
    });
    await run(new Date());
    await run(ist(addDays(next, -1), '17:01'));
    const clientReminder = email.to('raj@client.test').find((m) => /reminder/i.test(m.subject))!;
    expect(clientReminder.text).toContain('Update from the last hearing');
    expect(clientReminder.text).toContain('Reply to be filed by the other side.');
    expect(clientReminder.text).not.toContain('SECRET-NOTE');
    const teamReminder = email.to('clerk@a.test').at(-1)!;
    expect(teamReminder.text).toContain('SECRET-NOTE push settlement');
    expect(teamReminder.text).toContain('Reply to be filed by the other side.');
  });

  it('first hearing: reminders carry no last-update text at all', async () => {
    const { owner, main, today, email, run } = await setup();
    const date = addDays(today, 3);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: date });
    await run(new Date());
    await run(ist(addDays(date, -1), '09:01'));
    const [m] = email.to('raj@client.test');
    expect(m!.text).not.toMatch(/last hearing/i);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @legalops/api test -- test/automation.test.ts`
Expected: the four new tests FAIL (client summary text absent / phrase missing); existing tests may also fail on the new reminder keys until Task 4 — only the four new ones are this task's target.

- [ ] **Step 3: Extend the variable catalogue** — in `packages/types/src/workflows.ts`, change the `TEMPLATE_VARIABLES` type and the Hearing group, add a Last hearing group, and export the internal-only list:

```ts
export type TemplateVariable = { name: string; example: string; /** Team-only: never rendered in client emails. */ internalOnly?: true };

/** Variables the editor offers (rendered server-side, HTML-escaped). */
export const TEMPLATE_VARIABLES: { group: string; vars: TemplateVariable[] }[] = [
```

Replace the Hearing group with:

```ts
  {
    group: 'Hearing',
    vars: [
      { name: 'hearing.date', example: 'Sat, 10 Oct 2026' },
      { name: 'hearing.time', example: '10:30 am' },
      { name: 'hearing.courtroom', example: '12' },
      { name: 'hearing.client_summary', example: 'The court gave the other side time to file a reply.' },
      { name: 'hearing.outcome', example: 'Judge unconvinced on limitation; consider settlement', internalOnly: true },
      { name: 'hearing.next_date', example: 'Thu, 22 Oct 2026' },
    ],
  },
  {
    group: 'Last hearing',
    vars: [
      { name: 'previous.date', example: '10 Oct 2026' },
      { name: 'previous.client_update', example: 'The court gave the other side time to file a reply.' },
      { name: 'previous.client_update_phrase', example: 'Update from the last hearing (10 Oct 2026): The court gave the other side time to file a reply.' },
      { name: 'previous.internal_note', example: 'Judge unconvinced on limitation', internalOnly: true },
      { name: 'previous.internal_note_phrase', example: 'Internal note from the last hearing: Judge unconvinced on limitation', internalOnly: true },
    ],
  },
```

After the array:

```ts
/** Variables that must never appear in, or render into, a client email. */
export const INTERNAL_ONLY_VARIABLES: readonly string[] = TEMPLATE_VARIABLES.flatMap((g) => g.vars.filter((v) => v.internalOnly).map((v) => v.name));
```

Make sure `TemplateVariable` and `INTERNAL_ONLY_VARIABLES` are exported from the package entry (`packages/types/src/index.ts` re-exports `workflows.ts`; verify with `grep -n workflows packages/types/src/index.ts`).

- [ ] **Step 4: Build the variables** — in `apps/api/src/modules/notifications/context.ts`, add near the other helpers:

```ts
type HearingText = { scheduled_date: string; status: string; client_summary: string | null };
/** What a client may be told about a held hearing: the firm's summary, or a neutral line. */
const clientUpdateText = (h: HearingText) =>
  h.client_summary?.trim() ||
  (h.status === 'adjourned' ? `The hearing on ${dateText(h.scheduled_date)} was adjourned.` : `The hearing on ${dateText(h.scheduled_date)} was held.`);
```

In the hearing block, change the SELECT and its row type to include `client_summary`:

```ts
    const h = await queryOne<{ case_id: string; status: string; scheduled_date: string; start_time: string | null; courtroom: string | null; hearing_type: string | null; outcome: string | null; client_summary: string | null; next_hearing_date: string | null }>(
      db,
      sql`SELECT case_id, status, scheduled_date::text, to_char(start_time, 'HH24:MI') AS start_time, courtroom, hearing_type, outcome, client_summary, next_hearing_date::text
          FROM hearings WHERE id = ${r.hearingId} AND organization_id = ${organizationId}`,
    );
```

Inside `if (h) { … }`, add to `vars.hearing`:

```ts
        client_summary: h.status === 'completed' || h.status === 'adjourned' ? clientUpdateText(h) : '',
```

and after `raw.hearing = …;` add:

```ts
      // The most recent held hearing on the same case, for "last update" lines in reminders.
      const prev = await queryOne<HearingText & { outcome: string | null }>(
        db,
        sql`SELECT scheduled_date::text, status, client_summary, outcome FROM hearings
            WHERE case_id = ${h.case_id} AND organization_id = ${organizationId}
              AND status IN ('completed', 'adjourned') AND scheduled_date < ${h.scheduled_date}
            ORDER BY scheduled_date DESC, completed_at DESC NULLS LAST LIMIT 1`,
      );
      vars.previous = prev
        ? {
            date: dateText(prev.scheduled_date),
            client_update: clientUpdateText(prev),
            client_update_phrase: `Update from the last hearing (${dateText(prev.scheduled_date)}): ${clientUpdateText(prev)}`,
            internal_note: prev.outcome ?? '',
            internal_note_phrase: prev.outcome ? `Internal note from the last hearing: ${prev.outcome}` : '',
          }
        : { date: '', client_update: '', client_update_phrase: '', internal_note: '', internal_note_phrase: '' };
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @legalops/api test -- test/automation.test.ts -t "what the client is told"`
Expected: `outcome email…`, `neutral line`, and `first hearing` PASS. `day-before … team reminder` still FAILS because the 17:00 team reminder doesn't exist yet (Task 4) — note it and move on. Internal-note leakage is not yet blocked for firm-edited templates (Task 3).

- [ ] **Step 6: Checkpoint** — `pnpm typecheck`. Suggested message: `feat(notifications): client-safe hearing summary and last-hearing update variables`.

---

### Task 3: Audience scoping — team-only variables can never render for a client

**Files:**
- Create: `apps/api/src/modules/templates/audience.ts`
- Create: `apps/api/src/modules/templates/audience.test.ts`
- Modify: `apps/api/src/modules/notifications/notifications.service.ts:58-60`
- Modify: `apps/api/src/modules/templates/templates.service.ts` (`validateBody` ~L83, `saveTemplate` ~L91, `previewTemplate` ~L139)
- Modify: `packages/validation/src/automation.ts:99-101`
- Test: `apps/api/test/automation.test.ts`

**Interfaces:**
- Consumes: `INTERNAL_ONLY_VARIABLES` (Task 2); `templateVariables(template: string): string[]` from `./render.js`.
- Produces:
  - `type Audience = 'client' | 'internal'`
  - `varsForAudience(vars: Record<string, Record<string, unknown>>, audience: Audience): Record<string, Record<string, unknown>>`
  - `internalOnlyUsed(...templates: (string | null | undefined)[]): string[]`
  - `templatePreviewSchema` gains `audience: 'client' | 'internal'` (default `'internal'`).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/templates/audience.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { internalOnlyUsed, varsForAudience } from './audience.js';

describe('audience scoping', () => {
  const vars = {
    hearing: { date: '10 Oct 2026', outcome: 'SECRET', client_summary: 'Adjourned for reply' },
    previous: { client_update: 'ok', internal_note: 'SECRET', internal_note_phrase: 'Internal note: SECRET' },
  };

  it('strips team-only values for clients without mutating the input', () => {
    const scoped = varsForAudience(vars, 'client');
    expect(scoped.hearing).toEqual({ date: '10 Oct 2026', client_summary: 'Adjourned for reply' });
    expect(scoped.previous).toEqual({ client_update: 'ok' });
    expect(vars.hearing.outcome).toBe('SECRET');
  });

  it('leaves team emails untouched', () => {
    expect(varsForAudience(vars, 'internal')).toBe(vars);
  });

  it('reports team-only variables used in a template, including spaced forms', () => {
    expect(internalOnlyUsed('Hi {{ hearing.outcome }}', null, '{{previous.internal_note_phrase}} {{hearing.date}}')).toEqual([
      'hearing.outcome',
      'previous.internal_note_phrase',
    ]);
  });
});
```

Append to the `'what the client is told (LegalForgeX T1)'` describe in `apps/api/test/automation.test.ts`:

```ts
  it('legacy override: a client template row still containing {{hearing.outcome}} renders it blank', async () => {
    const { owner, main, today, firm, email, run } = await setup();
    await pool.query(
      `INSERT INTO email_templates (organization_id, template_key, name, event_type, audience, subject_template, html_body)
       VALUES ($1, 'hearing_outcome_client', 'Mine', 'HEARING_COMPLETED', 'client', 'Update', '<p>Note: {{hearing.outcome}}</p><p>{{hearing.client_summary}}</p>')`,
      [firm.orgId],
    );
    const h = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: today });
    await complete(owner, h.body.data.id, { result: 'adjourned', outcome: 'SECRET-NOTE', clientSummary: 'Reply awaited.', nextHearingDate: addDays(today, 9) });
    await run(new Date());
    const [m] = email.to('raj@client.test');
    expect(m!.text).toContain('Reply awaited.');
    expect(m!.text).not.toContain('SECRET-NOTE');
  });

  it('a firm cannot save a client template that uses a team-only variable', async () => {
    const { owner } = await setup();
    const res = await post(owner, '/templates', {
      templateKey: 'hearing_outcome_client',
      name: 'Mine',
      audience: 'client',
      subjectTemplate: 'Update',
      htmlBody: '<p>{{hearing.outcome}}</p>',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/team-only/i);
    const ok = await post(owner, '/templates', {
      templateKey: 'my_internal_note',
      name: 'Team',
      audience: 'internal',
      subjectTemplate: 'Note',
      htmlBody: '<p>{{hearing.outcome}}</p>',
    });
    expect(ok.status).toBe(201);
  });

  it('approval mode: the held client message contains the summary, not the internal note', async () => {
    const { owner, main, today, run } = await setup();
    await run(new Date());
    await pool.query(`UPDATE workflows SET requires_approval = true WHERE system_key = 'hearing_outcome_client'`);
    const h = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: today });
    await complete(owner, h.body.data.id, { result: 'adjourned', outcome: 'SECRET-NOTE', clientSummary: 'Reply awaited.', nextHearingDate: addDays(today, 9) });
    await run(new Date());
    const held = (await pool.query(`SELECT body_html, body_text FROM notifications WHERE status = 'awaiting_approval'`)).rows[0];
    expect(held.body_text).toContain('Reply awaited.');
    expect(held.body_text).not.toContain('SECRET-NOTE');
    expect(held.body_html).not.toContain('SECRET-NOTE');
  });
```

Note: confirm the error envelope shape (`res.body.error.message`) and the create route's status (201) against `apps/api/src/http/errors.ts` and `templates.routes.ts:18-21` before running; adjust the assertion path only if the codebase uses a different envelope.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @legalops/api test -- src/modules/templates/audience.test.ts test/automation.test.ts -t "audience|legacy|team-only|approval mode"`
Expected: FAIL — `audience.js` not found; legacy override leaks `SECRET-NOTE`; template save returns 201.

- [ ] **Step 3: Implement `audience.ts`**

```ts
import { INTERNAL_ONLY_VARIABLES } from '@legalops/types';
import { templateVariables } from './render.js';

export type Audience = 'client' | 'internal';
type Vars = Record<string, Record<string, unknown>>;

/**
 * Drops team-only values before anything is rendered for a client, so no template (not even one a
 * firm edited, or a legacy row) can show an internal note. Team emails are returned as-is.
 */
export function varsForAudience(vars: Vars, audience: Audience): Vars {
  if (audience !== 'client') return vars;
  const out: Vars = Object.fromEntries(Object.entries(vars).map(([group, values]) => [group, { ...values }]));
  for (const path of INTERNAL_ONLY_VARIABLES) {
    const [group, key] = path.split('.') as [string, string];
    if (out[group]) delete out[group][key];
  }
  return out;
}

/** Team-only variables referenced by any of the given template strings, in first-seen order. */
export function internalOnlyUsed(...templates: (string | null | undefined)[]): string[] {
  const used = new Set(templates.flatMap((t) => (t ? templateVariables(t) : [])));
  return INTERNAL_ONLY_VARIABLES.filter((v) => used.has(v));
}
```

Note: `internalOnlyUsed` returns in catalogue order; the unit test expects `['hearing.outcome', 'previous.internal_note_phrase']`, which is also catalogue order.

- [ ] **Step 4: Scope at render time** — in `apps/api/src/modules/notifications/notifications.service.ts`, import `import { varsForAudience, type Audience } from '../templates/audience.js';` and replace the `const vars = …` line (~L60) with:

```ts
  // A client recipient is always rendered as client audience, whatever the template row says.
  const audience: Audience = input.recipient.type === 'client' ? 'client' : (template.audience as Audience);
  const vars: Record<string, Record<string, unknown>> = varsForAudience({ ...context.vars, ...(input.extraVars ?? {}) }, audience);
```

- [ ] **Step 5: Validate on save and scope previews** — in `apps/api/src/modules/templates/templates.service.ts`:

```ts
import { internalOnlyUsed, varsForAudience, type Audience } from './audience.js';
```

Replace `validateBody` with:

```ts
function validateBody(input: { audience?: Audience; subjectTemplate: string; htmlBody: string; textBody?: string | null | undefined }) {
  const unknown = [...new Set([...unknownVariables(input.subjectTemplate, KNOWN), ...unknownVariables(input.htmlBody, KNOWN), ...unknownVariables(input.textBody ?? '', KNOWN)])];
  if (unknown.length) {
    throw validationError(`Unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{{${u}}}`).join(', ')}`, [{ path: 'htmlBody', message: 'Unknown variables' }]);
  }
  if (input.audience === 'client') {
    const teamOnly = internalOnlyUsed(input.subjectTemplate, input.htmlBody, input.textBody);
    if (teamOnly.length) {
      throw validationError(`Team-only variable${teamOnly.length > 1 ? 's' : ''} can't be used in client emails: ${teamOnly.map((u) => `{{${u}}}`).join(', ')}`, [
        { path: 'htmlBody', message: 'Team-only variables' },
      ]);
    }
  }
}
```

In `previewTemplate`, change the input type to include `audience?: Audience` and scope the merged vars:

```ts
export async function previewTemplate(deps: Deps, ctx: TenantContext, input: { audience?: Audience; subjectTemplate: string; htmlBody: string; matterId?: string | undefined }) {
  validateBody(input);
  // …existing example + context merge unchanged…
  const vars = varsForAudience(
    { ...examples, ...Object.fromEntries(Object.entries(ctxVars).map(([k, v]) => [k, { ...(examples[k] ?? {}), ...v }])) },
    input.audience ?? 'internal',
  );
```

In `packages/validation/src/automation.ts`, replace `templatePreviewSchema` with:

```ts
export const templatePreviewSchema = z
  .object({
    audience: z.enum(['client', 'internal']).default('internal'),
    subjectTemplate: z.string().max(500),
    htmlBody: z.string().max(50000),
    matterId: uuidSchema.optional(),
  })
  .strict();
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @legalops/api test -- src/modules/templates test/automation.test.ts -t "audience|legacy|team-only|approval mode|what the client"`
Expected: all PASS except `day-before … team reminder` (Task 4).

- [ ] **Step 7: Checkpoint** — `pnpm typecheck`. Suggested message: `feat(templates): team-only variables can never render in client emails`.

---

### Task 4: Reminder matrix and once-per-key default seeding

**Files:**
- Modify: `apps/api/src/modules/workflows/defaults.ts`
- Create: `apps/api/test/workflow-seeding.test.ts`
- Modify: `apps/api/test/automation.test.ts` (two existing expectations, L40 and L68)

**Interfaces:**
- Consumes: system template `hearing_today_client` (Task 1); `settings.seededWorkflowKeys` initialised by `0006`.
- Produces: default keys `hearing_1d_team`, `hearing_morning_client`; `ensureDefaultWorkflows(db, organizationId, createdBy, defaults?: Default[]): Promise<number>`; `ensureDefaultsOnce(db, organizationId): Promise<void>` now per-key.

- [ ] **Step 1: Write the failing tests** — create `apps/api/test/workflow-seeding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOWS, ensureDefaultsOnce } from '../src/modules/workflows/defaults.js';
import { createFirm, pool, useDatabase } from './helpers.js';

useDatabase();

// Sorted in JS, not SQL: Postgres collation orders '_' differently from Array.prototype.sort.
const keysOf = async (orgId: string) =>
  (await pool.query<{ system_key: string }>(`SELECT system_key FROM workflows WHERE organization_id = $1`, [orgId])).rows.map((r) => r.system_key).sort();
const ORIGINAL_13 = DEFAULT_WORKFLOWS.map((d) => d.key).filter((k) => k !== 'hearing_1d_team' && k !== 'hearing_morning_client');

describe('default automation seeding', () => {
  it('a new firm gets every default once; running again adds nothing', async () => {
    const { orgId } = await createFirm('New', [{ email: 'o@new.test', role: 'owner' }]);
    await ensureDefaultsOnce(pool, orgId);
    await ensureDefaultsOnce(pool, orgId);
    expect(await keysOf(orgId)).toEqual(DEFAULT_WORKFLOWS.map((d) => d.key).sort());
    expect(DEFAULT_WORKFLOWS).toHaveLength(15);
  });

  it('an already-seeded firm gets only the two new defaults', async () => {
    const { orgId } = await createFirm('Old', [{ email: 'o@old.test', role: 'owner' }]);
    await pool.query(`UPDATE organizations SET settings = jsonb_build_object('seededWorkflowKeys', $2::jsonb) WHERE id = $1`, [orgId, JSON.stringify(ORIGINAL_13)]);
    await ensureDefaultsOnce(pool, orgId);
    expect(await keysOf(orgId)).toEqual(['hearing_1d_team', 'hearing_morning_client']);
  });

  it('deleted default: a recipe the firm removed never comes back', async () => {
    const { orgId } = await createFirm('Picky', [{ email: 'o@picky.test', role: 'owner' }]);
    await ensureDefaultsOnce(pool, orgId);
    await pool.query(`DELETE FROM workflows WHERE organization_id = $1 AND system_key = 'hearing_1d_client'`, [orgId]);
    await ensureDefaultsOnce(pool, orgId);
    expect(await keysOf(orgId)).not.toContain('hearing_1d_client');
  });
});
```

In `apps/api/test/automation.test.ts`:
- L40: change the expected planned keys to `['hearing_3d_team', 'hearing_1d_client', 'hearing_1d_team', 'hearing_morning_client', 'hearing_morning_lead']`.
- L68: change `toHaveLength(4); // 7d, 3d, 1d, morning` to `toHaveLength(6); // 7d, 3d, 1d client, 1d team, morning client, morning lead`.

Add to `'what the client is told (LegalForgeX T1)'`:

```ts
  it('reminder matrix: lawyer and client are each reminded the day before and on the day', async () => {
    const { owner, main, today, email, run } = await setup();
    const date = addDays(today, 5);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: date, startTime: '11:00' });
    await run(new Date());
    await run(ist(addDays(date, -1), '09:01'));
    expect(email.to('raj@client.test')).toHaveLength(1); // day before, 9 am
    const leadBefore = email.to('l1@a.test').length;
    await run(ist(addDays(date, -1), '17:01'));
    expect(email.to('l1@a.test').length).toBe(leadBefore + 1); // day before, 5 pm, team
    await run(ist(date, '07:31'));
    const today_ = email.to('raj@client.test');
    expect(today_).toHaveLength(2);
    expect(today_[1]!.subject).toMatch(/^Today:/);
    await run(ist(date, '08:01'));
    expect(email.to('l1@a.test').length).toBe(leadBefore + 2); // on the day, 8 am, lead
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @legalops/api test -- test/workflow-seeding.test.ts test/automation.test.ts`
Expected: FAIL — 13 defaults instead of 15; old firm gets nothing new; matrix test fails at 17:01.

- [ ] **Step 3: Add the defaults** — in `apps/api/src/modules/workflows/defaults.ts`, insert after the `hearing_morning_lead` entry:

```ts
  { key: 'hearing_1d_team', name: 'Hearing tomorrow: brief the matter team', description: 'Sent at 5 pm the day before, with the last hearing’s notes.', trigger: 'HEARING_SCHEDULED', timing: rel('hearing.date', -1, '17:00'), actions: [email('matter_team', 'hearing_reminder_internal')] },
  { key: 'hearing_morning_client', name: 'Hearing today: morning reminder to the client', description: 'Sent at 7:30 am on the day.', trigger: 'HEARING_SCHEDULED', timing: rel('hearing.date', 0, '07:30'), actions: [email('client', 'hearing_today_client')] },
```

- [ ] **Step 4: Seed per key** — replace `ensureDefaultWorkflows` and `ensureDefaultsOnce` with:

```ts
/** Idempotent: adds any of the given default recipes the firm doesn't have (existing ones, edited or not, are left alone). */
export async function ensureDefaultWorkflows(db: Db, organizationId: string, createdBy: string | null, defaults: Default[] = DEFAULT_WORKFLOWS): Promise<number> {
  let added = 0;
  for (const d of defaults) {
    const rows = await query(
      db,
      sql`INSERT INTO workflows (organization_id, system_key, name, description, trigger_type, trigger_config, conditions, actions, created_by)
          VALUES (${organizationId}, ${d.key}, ${d.name}, ${d.description}, ${d.trigger}, ${JSON.stringify(d.timing)},
                  ${JSON.stringify(d.conditions ?? [])}, ${JSON.stringify(d.actions)}, ${createdBy})
          ON CONFLICT (organization_id, system_key) WHERE system_key IS NOT NULL DO NOTHING
          RETURNING id`,
    );
    added += rows.length;
  }
  return added;
}

/**
 * Offers each default recipe to a firm exactly once (D-013). Offered keys are remembered in
 * settings.seededWorkflowKeys, so new defaults reach existing firms, and a recipe a firm
 * deliberately deleted never comes back.
 */
export async function ensureDefaultsOnce(db: Db, organizationId: string): Promise<void> {
  const org = await queryOne<{ keys: string[] }>(
    db,
    sql`SELECT COALESCE(settings->'seededWorkflowKeys', '[]'::jsonb) AS keys FROM organizations WHERE id = ${organizationId} FOR UPDATE`,
  );
  if (!org) return;
  const pending = DEFAULT_WORKFLOWS.filter((d) => !org.keys.includes(d.key));
  if (!pending.length) return;
  await ensureDefaultWorkflows(db, organizationId, null, pending);
  await query(
    db,
    sql`UPDATE organizations SET settings = jsonb_set(settings, '{seededWorkflowKeys}', ${JSON.stringify([...org.keys, ...pending.map((d) => d.key)])}::jsonb)
        WHERE id = ${organizationId}`,
  );
}
```

Change the import line to `import { query, queryOne, type Db } from '../../db/pool.js';`. `ensureDefaultsOnce` is called inside a transaction by both callers (`processor.ts:47`, `workflows.service.ts:40`), so `FOR UPDATE` serialises concurrent seeding exactly as before.

- [ ] **Step 5: Run the full API suite**

Run: `pnpm --filter @legalops/api test`
Expected: all PASS, including every test in `'what the client is told (LegalForgeX T1)'` and the updated pilot-test-2 expectations.

- [ ] **Step 6: Checkpoint** — `pnpm typecheck && pnpm lint`. Suggested message: `feat(automations): day-before team and on-the-day client reminders; seed defaults once per key`.

---

### Task 5: Web — record and show both texts

**Files:**
- Modify: `apps/web/src/features/hearings/CompleteHearingSheet.tsx` (state ~L30-44, submit ~L66-75, fields ~L137-145)
- Modify: `apps/web/src/features/hearings/HearingDetailPage.tsx` (~L104-110)

**Interfaces:**
- Consumes: `completeHearingSchema.clientSummary`, `HearingDto.clientSummary` (Task 1).

- [ ] **Step 1: Add state and payload** — in `CompleteHearingSheet.tsx`:
  - after `const [outcome, setOutcome] = useState('');` add `const [clientSummary, setClientSummary] = useState('');`
  - in the reset effect add `setClientSummary('');`
  - in `submit`'s `safeParse` object add `clientSummary: clientSummary || null,` after `outcome,`

- [ ] **Step 2: Replace the single text area with two** — replace the `<TextAreaField label="What happened" … />` block with:

```tsx
        <TextAreaField
          label="Internal note (team only)"
          hint="Never sent to the client."
          placeholder={
            result === 'adjourned'
              ? 'e.g. Respondent sought time; judge unconvinced on limitation'
              : 'e.g. Arguments heard, orders reserved'
          }
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          error={errors.outcome}
        />
        <TextAreaField
          label="Update for client (optional)"
          hint="Emailed to the client. Leave blank to send a neutral line with the next date."
          placeholder="e.g. The court gave the other side time to file a reply."
          maxLength={2000}
          value={clientSummary}
          onChange={(e) => setClientSummary(e.target.value)}
          error={errors.clientSummary}
        />
```

- [ ] **Step 3: Show both on the hearing page** — in `HearingDetailPage.tsx`, replace `<p className="whitespace-pre-wrap">{h.outcome}</p>` with:

```tsx
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Internal note</p>
                  <p className="whitespace-pre-wrap">{h.outcome}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Sent to client</p>
                  <p className="whitespace-pre-wrap">
                    {h.clientSummary ?? <span className="text-muted">Neutral update with the next date</span>}
                  </p>
                </div>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @legalops/web typecheck`
Expected: clean.

- [ ] **Step 5: Browser verification** — start `legalops-api` and `legalops-web` via preview tooling, run `pnpm dev:worker`, log in as the seeded partner, open a matter with a hearing dated today (create one if needed), click **Record outcome**:
  - Both fields render with their hints, on desktop and at mobile width (375 px).
  - Save with an internal note and a client update; the hearing page shows both under the right labels.
  - In Mailpit (`http://localhost:8025`), the client email contains the client update and not the internal note.
  - Save another with the client field blank; the hearing page shows "Neutral update with the next date", and the Mailpit email shows `The hearing on … was adjourned.`
  - Screenshot the sheet and the hearing page as evidence.

- [ ] **Step 6: Checkpoint** — suggested message: `feat(web): record internal note and client update separately`.

---

### Task 6: Record the decision and align the spec

**Files:**
- Modify: `docs/decisions.md`
- Modify: `docs/superpowers/specs/2026-10-17-legalforgex-phase1-design.md` (§5.4)

- [ ] **Step 1: Add D-013** — append to `docs/decisions.md`:

```markdown
## D-013 — Client-facing hearing text and once-per-key automation defaults (2026-10-17)

- `hearings.outcome` is the team's internal note. `hearings.client_summary` is the only hearing text a client may see; blank means a neutral line ("The hearing on {date} was adjourned/held.").
- Template variables flagged `internalOnly` in `@legalops/types` are stripped before any client-bound render (`varsForAudience`) and rejected when saving a client template. A client recipient is always rendered as client audience.
- Migration 0006 rewrote firm client-template overrides from `{{hearing.outcome}}` to `{{hearing.client_summary}}`; existing outcomes were not copied into `client_summary`.
- Default automations are offered once per key (`settings.seededWorkflowKeys`): new defaults reach existing firms; deleted ones never return. Replaces the one-shot `defaultWorkflowsSeeded` flag.
```

- [ ] **Step 2: Align the spec** — in spec §5.4, replace the sentence beginning "Client-audience templates may use" with:

```markdown
- Client-audience templates may use `{{hearing.client_summary}}` and the `previous.*` client-safe variables (`previous.date`, `previous.client_update`, `previous.client_update_phrase`). Team-only variables (`hearing.outcome`, `previous.internal_note`, `previous.internal_note_phrase`) are stripped before any client render and rejected when saving a client template.
```

- [ ] **Step 3: Final verification**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean/green (API, validation, DB invariants).

- [ ] **Step 4: Checkpoint** — suggested message: `docs: D-013 client hearing text and default seeding`.
