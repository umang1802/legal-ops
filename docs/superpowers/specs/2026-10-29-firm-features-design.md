# Per-firm features: switched from the platform console (design)

**Date:** 29 Oct 2026. **Status:** draft for Umang's review.
**Why:** during the pilots, the LexForgeX team needs to decide which features each firm can use, so a firm only sees what has been agreed with it and what has been proven. Later, the same switches will be grouped into paid packages. This is generic: every feature added to LexForgeX from now on goes through it.

## Decisions made with Umang
- **Generic, and built in code.** One list of switchable features lives in code. Each new feature is added to that list, and the platform console shows a switch for it on every firm.
- **Pilots now, packages later.** We build per-firm switches only. Packages (a named set of switches with a price) come later, on top, without reworking this.
- **New features start off.** A feature added after this launch is off for every firm until a platform admin switches it on, firm by firm.
- **The feature list and its grouping** below were accepted as proposed ("Go ahead").

## Calls made by Claude (check these)
1. **Today's features stay on for today's firms.** The six switchable features that exist at launch default to on, so nothing disappears for any firm when this ships. Only features added after launch default to off.
2. **A feature that's off disappears.** It isn't shown greyed out or as "upgrade to unlock" (that may come with packages). Its pages, menu entries, tabs, buttons and settings are hidden, and the server refuses its requests.
3. **Nothing is deleted.** Turning a feature off hides it. Turning it on again brings back everything, as it was.
4. **Anything a switched-off feature had scheduled is skipped, not sent later.** This matches how the firm's existing "Send reminders" setting works.
5. **Automations off means the firm's own rules pause, and the built-in ones keep running.** The firm loses the Settings → Automations page, and rules the firm created stop firing. The built-in rules (`workflows.system_key` set: hearing-day reminders, hearing outcome to the client, task assigned, and so on) keep sending, unless the feature they belong to is off. Reason: switching off a settings page shouldn't silently stop clients getting their hearing reminders. A built-in rule the firm has edited still counts as built-in.
6. **Communication off means emails that need approval are skipped.** Approving them happens on the Communication page, so with that page gone they would wait forever. They're marked as not sent, with the reason. Emails that need no approval are unaffected.
7. **Two layers, both kept.** The platform switch decides whether a firm *has* a feature. The firm's own settings (for example "Send reminders", "Hide parties in synced calendars") decide how they use it. A feature switched off on the platform hides the firm's own settings for it.
8. **New firms get the defaults.** A firm invited after launch gets each feature's default (today's six on, later ones off). The platform admin changes them on the firm's page. The invite form doesn't gain switches.

## The features

**Core: always on, no switch.** Home dashboard, search, clients, cases/matters, hearings (including outcomes and next dates), the calendar view, tasks (including follow-up tasks on hearings), team and roles, invitations, firm settings, notifications needed to sign in (invites, password resets, email verification).

**Switchable**

| Key | Name in the console | Default | When it's off |
|---|---|---|---|
| `documents` | Documents | on | Hidden: the matter Documents tab, "Add documents" on a matter, "Orders & documents" on a hearing, "Attach the order" in the Record-outcome sheet, and the Documents section of the printed matter history. Server: every `/documents` route. |
| `billing` | Billing | on | Hidden: the Billing menu and its pages (invoices, payments, receipts, collections), "Invoice" on a matter, billing tabs on clients and matters, invoice and receipt printouts, fee agreements, milestones and expenses. Server: `/invoices`, `/payments`, `/expenses`, `/fee-agreements`, `/fee-milestones`, `/billing`. Scheduled invoice and payment emails are skipped. |
| `communication` | Communication | on | Hidden: the Communication page (needs approval, scheduled, sent, problems, not sent) and "Client update" on a matter. Server: sending client updates and the communication log and approval endpoints. Automatic emails still go out, except those needing approval (call 6). |
| `automations` | Automations | on | Hidden: Settings → Automations. Server: `/workflows` and `/email-templates`. The firm's own rules pause; built-in rules continue (call 5). |
| `diary` | Diary & printouts | on | Hidden: the printable next-day hearings board (`/diary`), its menu entry, the matter "Print history" button and page. Server: `GET /hearings/diary`. |
| `calendar_sync` | Calendar sync | on | Hidden: Settings → Calendar sync and the firm setting "Hide parties in synced calendars". Server: `/calendar-feed`, and the firm's public `/ical/<token>.ics` links return 404 (calendar apps keep the events they already have). |

**Features that show up inside core pages.** Search returns invoices today, and the Home dashboard shows billing figures. When Billing is off, search leaves invoices out and the dashboard leaves out the billing figures (on both the server and the screen). The same applies to any core page that shows a switchable feature's data.

When the builder finds a route, page, button or email not covered by this table, it goes with the feature it obviously belongs to. If it isn't obvious, it's core.

## How it works

### The list, in code
- `@legalops/types` gets `FEATURES`, the one place features are declared: `key`, `label`, a one-line `description` for the console, and `defaultEnabled`. It also exports `FeatureKey` and the list of keys.
- **Adding a feature later** means adding one entry with `defaultEnabled: false`, plus the checks below in its own code.
- **Feature tied to permissions.** Each `Permission` can belong to a feature, for example `billing.*` → `billing`, `documents.*` → `documents`, `workflows.manage` → `automations`. A permission whose feature is off is treated as not granted. This hides most UI and blocks most routes through code that already exists. Features without their own permissions (`diary`, `calendar_sync`, `communication`) are checked by key.

### Data
- New table `organization_features`: `organization_id`, `feature_key`, `enabled`, `updated_by` (platform admin), `updated_at`. Primary key `(organization_id, feature_key)`.
- **A row exists only where a platform admin set a switch.** No row means the feature's `defaultEnabled`. So a feature added later is off everywhere without touching the database, and launch needs no data backfill.
- **Room for packages.** A later migration can add `packages` and `organizations.package_id`. A firm's setting is then: its own row if present, else its package's setting, else `defaultEnabled`. Nothing in this design blocks that.
- `feature_key` isn't constrained in the database, so features can be added without a migration. Unknown keys are ignored when read and rejected on write.

### Server
- **Loading.** The session loader, which already loads the firm for every request, also loads the firm's enabled feature keys, so each request has them on hand.
- **Guard.** A `requireFeature(key)` guard on each feature's routers. When the feature is off it returns **404** (code `FEATURE_DISABLED`, message "This isn't available for your firm"). That fits the app's existing rule that what you can't see returns 404.
- **Permissions.** Wherever the server checks a permission, a permission whose feature is off fails the same way.
- **The public calendar link** (`/ical/<token>.ics`) has no session. It looks up the firm's switch itself and returns 404 when Calendar sync is off.
- **Background jobs.**
  - The worker checks the switch when an action is about to run, not when it was scheduled. Actions belonging to a switched-off feature are marked skipped, with reason `feature_off:<key>`.
  - Each built-in rule declares the feature it belongs to, if any: invoice issued, invoice due and payment received belong to `billing`. Rules the firm created belong to `automations`.
  - Emails that need approval are skipped while `communication` is off (call 6).
- **The `/auth/me` response** gains `features: FeatureKey[]`, the keys that are on.

### Web (firm app)
- `canAct(me, permission)` also returns false when the permission's feature is off. A new `hasFeature(me, key)` handles features without permissions.
- **What gets hidden when off:**
  - menu entries, in `nav.ts`: add an optional `feature` to `NavItem`
  - matter tabs and quick actions, hearing cards, sections of the Record-outcome sheet, and print-page sections
  - settings toggles
- **Routes.** A route for a switched-off feature shows the existing Not Found page.
- **Mid-session changes.** If a feature is switched off while someone has the app open, the next server request gets a 404, and the app's normal error handling shows it. The menu updates the next time `/auth/me` is refetched. No live push.

### Platform console
- **Features card.** The firm's page (`FirmDetailPage`) gets a "Features" card: one row per feature with its name, description and a switch. A feature still on its default shows "Default". One the team has set shows who set it and when.
- **Saving.** Each switch saves immediately. Turning a feature *off* asks for confirmation first, naming what the firm loses ("Their team will no longer see Billing. Nothing is deleted.").
- **Platform API:**
  - `GET /platform/firms/:id/features` returns, for each feature, its key, label, description, `enabled`, whether that's the default or was set, and who set it and when.
  - `PATCH /platform/firms/:id/features/:key {enabled}` sets one switch (PATCH, like the console's other edits). It is idempotent, and setting a feature back to its default value still stores a row, so the switch is pinned.
- **Audit.** Each change writes the platform audit entry `firm.feature_enabled` / `firm.feature_disabled` with the feature key, so it shows in the firm's history and the platform Audit log. Firm users aren't notified.
- **Suspended firms.** Switches can still be changed while a firm is suspended.

## Tests that matter
- **Default and override.** A firm with no rows gets the defaults. A row overrides the default both ways. A feature added later (test fixture with `defaultEnabled: false`) is off for existing firms.
- **Every guarded feature:** with the switch off, its routes return 404 `FEATURE_DISABLED`; with it on, they work. For Calendar sync this includes the public `.ics` link.
- **Permissions.** A permission whose feature is off fails, for example a firm owner can't create an invoice when Billing is off.
- **Worker:**
  - A scheduled invoice reminder is skipped with `feature_off:billing`.
  - With Automations off, a firm-created rule is skipped, and a built-in hearing reminder still sends.
  - With Communication off, an email that needs approval is skipped.
- **Platform:** only signed-in platform admins (MFA verified) can read or change switches. Each change is audited. Unknown keys get 422.
- **`/auth/me`** lists the enabled features.
- **Browser check:**
  1. Switch Documents and Billing off for the seed firm in the console.
  2. Confirm their menus, tabs and buttons are gone, and a typed URL shows Not Found.
  3. Switch them back on and confirm the earlier documents and invoices are all there.

## Not now
- Packages and prices, and showing locked features as an upgrade prompt.
- Switches below feature level (for example invoices without fee agreements), and per-user or per-role switches.
- Letting firms see or request features themselves.
- Live updates to open browser sessions when a switch changes.
- Turning off core features.
