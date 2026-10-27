# LexForgeX Phase 1 — Plan Roadmap

**Spec:** `docs/superpowers/specs/2026-10-17-legalforgex-phase1-design.md`

The spec spans eight largely independent tracks. Each track gets its own detailed plan, written immediately before it is executed, so every plan is grounded in the code as it stands after the previous track. Each plan produces working, tested, shippable software on its own.

## Ground rules for every track

- **No automatic commits.** The repo owner commits. Plans mark *checkpoints* with a suggested message; executors stop there and do not run `git commit`.
- **One migration per track** (`0006`, `0007`, …) instead of the single `0006` in spec §3, so tracks ship independently. Migrations are append-only: never edit a migration that has been applied on any environment.
- Tests: `pnpm --filter @legalops/api test` (Vitest + supertest against `legalops_test` on port 5433; Docker Postgres must be up via `pnpm dev:deps`). Also `pnpm typecheck` and `pnpm lint` clean before each checkpoint.
- Browser verification of every changed screen via the preview tooling (`.claude/launch.json` in `Eduforgex/`: `legalops-api` on 4100, `legalops-web` on 5190; worker via `pnpm dev:worker`).
- Product name in any **new** user-visible string is "LexForgeX". Existing "LegalOps" strings are swept in Track 7.

## Tracks

| # | Plan file | Scope (spec refs) | Migration | Status |
|---|---|---|---|---|
| 0 | — | Owner commits Phases 1–5 | — | **Prerequisite** |
| 1 | `2026-10-17-legalforgex-t1-hearing-updates-reminders.md` | Client summary vs internal note, audience-safe templates, reminder matrix, per-key default seeding (§3.6, §3.7, §5.4, §5.5) | `0006` | **Done (merged 2026-10-17)** |
| 2 | `2026-10-17-legalforgex-t2-platform-realm.md` | Platform admins, sessions, TOTP, org status, firm invite, suspend/reactivate + middleware + worker skip, platform console UI, platform audit log (§3.1–3.3, §5.2, §6.1, §7) | `0007` | **Done (pending merge)** |
| 3 | `…-t3-onboarding.md` | Owner-invite acceptance (new + existing users), setup wizard, getting-started checklist, firm-side invite resend/revoke (§5.1, §6.2) | — | After T2 |
| 4 | `…-t4-case-form.md` | Field registry + master-form content, `cases.details`, `case_type` closed set, full-page case form, detail cards, Case form settings, filters/search, field requests (§3.4, §3.5, §4, §5.3) | `0008` | After T3; content needs lawyer review |
| 5 | `…-t5-branding.md` | Storage adapter, logo upload + public route, brand colour + contrast guard, sender name/reply-to, branded email layout, theming, print pages (§3.1, §3.8, §6.2–6.3) | `0009` | After T3 |
| 6 | `…-t6-phase5-closeout.md` | Approvals queue UI, email-template editor (audience-filtered palette), browser verification of Communication + Automations, D-012 doc (§6.2) | — | Any time after T1 |
| 7 | `…-t7-rebrand.md` | User-visible LegalOps → LexForgeX sweep (§6.4) | — | **Done (27 Oct 2026)** |
| 8 | `…-t8-design-pass.md` | Visual design pass after browser review (§6.5) | — | Last |

## Dependencies

```
T0 ─► T1 ─► T2 ─► T3 ─┬─► T4
                      ├─► T5
T1 ─────────────────► T6
T4, T5, T6 ─► T7 ─► T8
```

T4 and T5 are independent of each other and may run in either order.
