# LexForgeX Track 2 — Platform Realm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the LexForgeX team a separately authenticated platform console (password + TOTP) from which they invite a firm's owner, keep payment notes, and suspend or reactivate a firm, with suspended firms enforced read-only in the API, the worker and the web app.

**Architecture:** A second auth realm lives in the same Express app under `/api/v1/platform`, mounted **before** the firm router with its own cookie (`lf_psid`, scoped to path `/api/v1/platform`), session table, CSRF secret and MFA gate. The firm router never sees the platform cookie and the platform router never reads the firm cookie. Firm suspension is one middleware on the firm router plus one check in the worker. Owner invites reuse the existing `invitations` table and the existing invite email path (`MEMBER_INVITED` → `sensitive.member_invite`).

**Tech Stack:** Postgres 16 (plain SQL migrations), Express 5 + TypeScript, Zod, `node:crypto` (TOTP per RFC 6238, AES-256-GCM), Vitest + supertest, React 19 + React Router 7 + TanStack Query, `@legalops/ui`.

**Spec:** `docs/superpowers/specs/2026-10-17-legalforgex-phase1-design.md` (§2 L-02–L-04, L-11, L-12; §3.1–3.3; §5.1 step 1; §5.2; §6.1; §7 platform rows; §8; §9 items 1–4). Roadmap: `docs/superpowers/plans/2026-10-17-legalforgex-phase1-roadmap.md`.

## Global Constraints

- **Never run `git commit`.** Stop at checkpoints; the repo owner commits. Work on branch `feature/legalforgex-t2`.
- Migration file: `packages/db/migrations/0007_platform_realm.sql`. Never edit `0001`–`0006`.
- Platform cookie name `lf_psid`, `httpOnly`, `sameSite: 'strict'`, `path: '/api/v1/platform'`, `secure` in production. Firm cookie `lo_sid` is untouched.
- Platform session: idle timeout **30 minutes**, absolute lifetime **12 hours**. Only the HMAC of the token is stored (same as firm sessions).
- TOTP: RFC 6238, SHA-1, 6 digits, 30-second step, accept ±1 step, **reject reuse of a step already used** (`totp_last_step`).
- TOTP secret encrypted at rest with AES-256-GCM. Key: `PLATFORM_SECRET_KEY` env (≥32 chars), **required in production**; in development/test it falls back to a key derived from `SESSION_SECRET`.
- Platform admins are created **only** by `pnpm --filter @legalops/api platform:create-admin -- --email <e> --name <n> [--reset]`. No platform signup endpoint.
- Owner invitation valid **7 days** (existing `INVITE_TTL_DAYS`).
- Suspended firm: every non-`GET`/`HEAD`/`OPTIONS` firm request → `403 { error: { code: 'FIRM_SUSPENDED' } }`, except `POST /auth/logout`, `POST /auth/switch-organization`, `POST /auth/login`. Worker skips due actions with reason `Firm suspended`. Data is never deleted.
- Firm APIs never return `platform_notes` or `suspended_reason`.
- New user-visible strings say "LexForgeX".
- Before each checkpoint: `pnpm --filter @legalops/api exec vitest run`, `pnpm typecheck`, `pnpm lint` clean. Final task: `pnpm test`.

**Deliberate deviations from the spec (rule here, not mid-task):**
1. Spec §6.1 "QR + manual key": enrolment shows the base32 key and an `otpauth://` link (opens the authenticator on a phone); **no QR image**, to avoid a new dependency for a 1–3-person admin team. A QR can be added later without API changes.
2. Spec §9 item 2 "enumerate the Express router's registered routes": the suspension middleware is mounted on the firm router *before every sub-router*, so it runs for every path including unknown ones. The sweep test proves this by asserting `FIRM_SUSPENDED` for every mounted prefix **and** for a non-existent path. This is a stronger guarantee than enumeration (new routes are covered by construction) and avoids depending on Express 5 router internals.
3. Spec §6.2–6.3 "create/edit controls disabled with tooltip": the web app's `useCan` returns `false` for every non-read permission while suspended, which **hides** existing permission-gated controls everywhere, plus a global banner. Disabled-with-tooltip on every control is deferred to the design pass (T8).
4. The field-request inbox (spec §6.1) needs the `field_requests` table from Track 4; it ships in Track 4.
5. Acceptance of an owner invite flipping the firm `invited → active` (spec §5.1 step 2) is done here (one `UPDATE` in the existing `acceptInvitation`), because without it a platform-invited firm can never become active. The rest of onboarding (wizard, existing-user UI) stays in Track 3.

## Review Focus

1. **A person holding both a firm session and a platform session in the same browser** — expected: each realm only honours its own cookie; a firm user's session can never call a platform endpoint, and a platform admin's session grants nothing on firm endpoints. Test: Task 3 step 1 (`realm isolation`).
2. **A TOTP code replayed within its validity window** (shoulder-surfed or intercepted) — expected: the second use of the same code is rejected even though it is still within ±30 s. Test: Task 3 step 1 (`replay`).
3. **A suspended firm's user who belongs to another, active firm** — expected: they can still switch to the active firm and work there; only the suspended firm is read-only. Test: Task 5 step 1 (`multi-firm user`).
4. **Reactivation after reminders fell due during suspension** — expected: nothing stale is sent on reactivation; future reminders resume. Test: Task 5 step 1 (`reactivation`).
5. **Inviting a firm whose partner email already belongs to an existing LexForgeX user** — expected: the invite is created; accepting adds that user as owner of the new firm without changing their password, and the firm becomes `active` exactly once. Test: Task 4 step 1 (`existing user`).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/migrations/0007_platform_realm.sql` (create) | org status/suspension/notes columns; `platform_admins`, `platform_sessions`, `platform_audit_logs`; invitation inviter column; `firm_owner_invite` template |
| `packages/db/tests/invariants.sql` (modify) | append-only platform audit; inviter XOR; org status check |
| `packages/types/src/platform.ts` (create) | `OrganizationStatus`, platform DTOs, `allowedWhileSuspended` |
| `packages/types/src/api.ts` (modify) | `MFA_REQUIRED`, `FIRM_SUSPENDED`; `MeResponse.organization.status` |
| `packages/validation/src/platform.ts` (create) | platform request schemas |
| `apps/api/src/config/env.ts` (modify) | `PLATFORM_SECRET_KEY` |
| `apps/api/src/http/context.ts` (modify) | `req.platform`, `AuthContext.orgStatus` |
| `apps/api/src/modules/platform/totp.ts` (+ `.test.ts`) | base32, TOTP generate/verify |
| `apps/api/src/modules/platform/secrets.ts` (+ `.test.ts`) | AES-256-GCM encrypt/decrypt, key derivation |
| `apps/api/src/modules/platform/platform-auth.service.ts` | admin create/reset, login, sessions, TOTP enrol/verify, me, logout |
| `apps/api/src/modules/platform/platform-firms.service.ts` | firm list/detail/invite/notes/suspend/reactivate/invite resend-revoke-reinvite, audit |
| `apps/api/src/modules/platform/platform.routes.ts` | platform router + middleware |
| `apps/api/src/scripts/create-platform-admin.ts` | CLI |
| `apps/api/src/app.ts` (modify) | mount platform router before firm router; suspension middleware |
| `apps/api/src/middleware/suspension.ts` | firm read-only middleware |
| `apps/api/src/modules/auth/auth.service.ts` (modify) | `orgStatus` in session; `status` in me; accept flips `invited → active` |
| `apps/api/src/modules/notifications/context.ts`, `workflows/engine.ts`, `workflows/processor.ts` (modify) | worker suspension skip; owner-invite email |
| `apps/api/test/platform-helpers.ts`, `platform-auth.test.ts`, `platform-firms.test.ts`, `suspension.test.ts` (create) | integration tests |
| `apps/web/src/platform/*` (create) | platform API client, hooks, shell, pages |
| `apps/web/src/App.tsx`, `lib/auth.ts`, `components/layout/AppShell.tsx` (modify) | platform routes; suspended read-only + banner |
| `docs/decisions.md`, `README.md`, `.env.example`, roadmap (modify) | D-014, admin how-to, env var |

---

### Task 1: Migration 0007 and DB invariants

**Files:**
- Create: `packages/db/migrations/0007_platform_realm.sql`
- Modify: `packages/db/tests/invariants.sql` (insert before the final `ROLLBACK;`)

**Interfaces:**
- Produces: `organizations.status` (`invited|active|suspended`, default `active`), `organizations.suspended_at`, `suspended_reason`, `platform_notes`; tables `platform_admins`, `platform_sessions`, `platform_audit_logs`; `invitations.invited_by_platform_admin_id`; system template `firm_owner_invite` (audience `internal`, external recipient).

- [ ] **Step 1: Write the failing invariants** — insert before `ROLLBACK;` in `packages/db/tests/invariants.sql`:

```sql
-- Platform realm (LexForgeX T2)
SELECT pg_temp.expect_fail($$UPDATE organizations SET status = 'deleted' WHERE id = 'a0000000-0000-0000-0000-000000000001'$$,
  'organization status outside invited/active/suspended');
INSERT INTO platform_admins (id, email, name, password_hash)
  VALUES ('d0000000-0000-0000-0000-000000000001', 'ops@legalforgex.test', 'Ops', 'x');
INSERT INTO platform_audit_logs (platform_admin_id, action, organization_id)
  VALUES ('d0000000-0000-0000-0000-000000000001', 'firm.invited', 'a0000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_fail($$UPDATE platform_audit_logs SET action = 'x'$$, 'updating platform audit');
SELECT pg_temp.expect_fail($$DELETE FROM platform_audit_logs$$, 'deleting platform audit');
SELECT pg_temp.expect_fail($$INSERT INTO invitations (organization_id, email, role, invited_by, invited_by_platform_admin_id, expires_at)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'x@y.test', 'owner', 'c0000000-0000-0000-0000-000000000001',
          'd0000000-0000-0000-0000-000000000001', now() + interval '7 days')$$,
  'invitation with both a firm inviter and a platform inviter');
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @legalops/db test`
Expected: FAIL — `relation "platform_admins" does not exist` (the first `expect_fail` on `status` may pass early because the column doesn't exist; that is fine — it re-passes for the right reason after Step 3).

- [ ] **Step 3: Write the migration** — `packages/db/migrations/0007_platform_realm.sql`:

```sql
-- LexForgeX Track 2: platform realm (spec §3.1–3.3, §5.2).

ALTER TABLE organizations
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended')),
  ADD COLUMN suspended_at TIMESTAMPTZ,
  ADD COLUMN suspended_reason TEXT,
  ADD COLUMN platform_notes TEXT,               -- LexForgeX team only; never returned by firm APIs
  ADD CONSTRAINT ck_org_suspension CHECK ((status = 'suspended') = (suspended_at IS NOT NULL));
CREATE INDEX idx_organizations_status ON organizations(status);

-- Platform admins are a separate realm from firm users (L-03). Created by CLI only.
CREATE TABLE platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT,                          -- AES-256-GCM; NULL until enrolment starts
  totp_enrolled_at TIMESTAMPTZ,                  -- set by the first successful code
  totp_last_step BIGINT,                         -- last accepted TOTP time-step (replay guard)
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_platform_admins_updated BEFORE UPDATE ON platform_admins FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE platform_sessions (
  id TEXT PRIMARY KEY,                           -- HMAC of the cookie token; raw token never stored
  platform_admin_id UUID NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL,
  mfa_verified_at TIMESTAMPTZ,                   -- NULL: password only, platform APIs refuse
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_platform_sessions_admin ON platform_sessions(platform_admin_id);

CREATE TABLE platform_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  platform_admin_id UUID NOT NULL REFERENCES platform_admins(id),
  action VARCHAR(60) NOT NULL,
  organization_id UUID REFERENCES organizations(id),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_audit_org ON platform_audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_platform_audit_created ON platform_audit_logs(created_at DESC);
CREATE TRIGGER trg_platform_audit_append_only BEFORE UPDATE OR DELETE ON platform_audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE invitations
  ADD COLUMN invited_by_platform_admin_id UUID REFERENCES platform_admins(id),
  ADD CONSTRAINT ck_invitation_single_inviter CHECK (invited_by IS NULL OR invited_by_platform_admin_id IS NULL);

INSERT INTO email_templates (organization_id, template_key, name, event_type, audience, subject_template, html_body, text_body) VALUES
(NULL, 'firm_owner_invite', 'Firm owner invitation', 'MEMBER_INVITED', 'internal',
 'Set up {{firm.name}} on LexForgeX',
 '<p>Hello {{recipient.first_name}},</p><p>Your LexForgeX workspace for <strong>{{firm.name}}</strong> is ready. Accept the invitation to set your password and finish setting up your firm.</p><p><a href="{{links.accept_invite}}">Set up your firm</a> (the link expires in 7 days).</p><p>If you weren’t expecting this, you can ignore this email.</p>',
 NULL);
```

- [ ] **Step 4: Apply and run**

Run: `pnpm db:migrate && pnpm --filter @legalops/db test`
Expected: migration applies; `DB invariants: 27 passed` (23 + 4).

- [ ] **Step 5: Checkpoint** — suggested message: `feat(db): platform realm schema (migration 0007)`.

---

### Task 2: TOTP and secret encryption primitives

**Files:**
- Create: `apps/api/src/modules/platform/totp.ts`, `totp.test.ts`
- Create: `apps/api/src/modules/platform/secrets.ts`, `secrets.test.ts`
- Modify: `apps/api/src/config/env.ts`

**Interfaces:**
- Produces:
  - `base32Encode(buf: Buffer): string`, `base32Decode(s: string): Buffer`
  - `generateTotpSecret(): string` (base32, 20 random bytes)
  - `totpCode(secretB32: string, step: number): string` (6 digits)
  - `currentStep(nowMs: number): number` (= `Math.floor(nowMs / 30000)`)
  - `verifyTotp(secretB32: string, code: string, nowMs: number, lastStep: number | null): number | null` — accepted step or `null`
  - `otpauthUrl(secretB32: string, email: string): string`
  - `platformKey(env: Env): Buffer` (32 bytes), `encryptSecret(key: Buffer, plaintext: string): string`, `decryptSecret(key: Buffer, payload: string): string`
  - `Env.PLATFORM_SECRET_KEY?: string`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/platform/totp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, currentStep, otpauthUrl, totpCode, verifyTotp } from './totp.js';

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890"; 6-digit codes are the last 6 digits.
const SEED = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('totp', () => {
  it('round-trips base32', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb-oi').toString()).toBe('foobar');
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC 6238 vector at T=%i', (t, code) => {
    expect(totpCode(SEED, currentStep(t * 1000))).toBe(code);
  });

  it('accepts the previous, current and next step and returns the matched step', () => {
    const now = 1111111109 * 1000;
    const step = currentStep(now);
    expect(verifyTotp(SEED, totpCode(SEED, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(SEED, totpCode(SEED, step), now, null)).toBe(step);
    expect(verifyTotp(SEED, totpCode(SEED, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(SEED, totpCode(SEED, step + 2), now, null)).toBeNull();
  });

  it('replay: rejects a code whose step is not after the last accepted step', () => {
    const now = 1111111109 * 1000;
    const step = currentStep(now);
    expect(verifyTotp(SEED, totpCode(SEED, step), now, step)).toBeNull();
    expect(verifyTotp(SEED, totpCode(SEED, step - 1), now, step)).toBeNull();
  });

  it('rejects malformed codes without throwing', () => {
    expect(verifyTotp(SEED, '12345', Date.now(), null)).toBeNull();
    expect(verifyTotp(SEED, 'abcdef', Date.now(), null)).toBeNull();
  });

  it('builds an otpauth URL for authenticator apps', () => {
    expect(otpauthUrl('ABC', 'ops@x.test')).toBe(
      'otpauth://totp/LexForgeX%20Platform:ops%40x.test?secret=ABC&issuer=LexForgeX%20Platform&algorithm=SHA1&digits=6&period=30',
    );
  });
});
```

`apps/api/src/modules/platform/secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../config/env.js';
import { decryptSecret, encryptSecret, platformKey } from './secrets.js';

const base = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 's'.repeat(40), APP_URL: 'http://localhost:5190' };

describe('platform secrets', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const key = platformKey(loadEnv({ ...base, NODE_ENV: 'test' }));
    const a = encryptSecret(key, 'JBSWY3DPEHPK3PXP');
    const b = encryptSecret(key, 'JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(decryptSecret(key, a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering', () => {
    const key = platformKey(loadEnv({ ...base, NODE_ENV: 'test' }));
    const payload = encryptSecret(key, 'JBSWY3DPEHPK3PXP');
    const [iv, tag, ct] = payload.split('.');
    const flipped = `${iv}.${tag}.${ct!.slice(0, -2)}${ct!.endsWith('AA') ? 'AB' : 'AA'}`;
    expect(() => decryptSecret(key, flipped)).toThrow();
  });

  it('requires PLATFORM_SECRET_KEY in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(40) })).toThrow(/PLATFORM_SECRET_KEY/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(40), PLATFORM_SECRET_KEY: 'k'.repeat(40) })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @legalops/api exec vitest run src/modules/platform`
Expected: FAIL — modules `./totp.js` / `./secrets.js` not found.

- [ ] **Step 3: Implement `totp.ts`**

```ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;
const DIGITS = 6;
const ISSUER = 'LexForgeX Platform';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));
export const currentStep = (nowMs: number): number => Math.floor(nowMs / STEP_MS);

/** RFC 4226 HOTP over the RFC 6238 time-step, SHA-1, 6 digits. */
export function totpCode(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Accepts the previous, current or next step (clock drift) and returns the matched step, or null.
 * A step at or before `lastStep` is rejected, so an intercepted code can't be replayed.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpCode(secretB32, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secretB32: string, email: string): string {
  const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
}
```

- [ ] **Step 4: Implement `secrets.ts`** and the env var.

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.js';

/** 32-byte AES key: PLATFORM_SECRET_KEY in production; derived from SESSION_SECRET in dev/test. */
export function platformKey(env: Env): Buffer {
  return createHash('sha256').update(env.PLATFORM_SECRET_KEY ?? `${env.SESSION_SECRET}:platform-totp`).digest();
}

/** AES-256-GCM; output is `iv.tag.ciphertext`, each base64url. */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(key: Buffer, payload: string): string {
  const [iv, tag, ct] = payload.split('.').map((s) => Buffer.from(s, 'base64url'));
  if (!iv || !tag || !ct) throw new Error('Malformed secret');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
```

In `apps/api/src/config/env.ts`, add to `envSchema` after `SESSION_SECRET`:

```ts
  PLATFORM_SECRET_KEY: z.string().min(32, { error: 'PLATFORM_SECRET_KEY must be at least 32 characters' }).optional(),
```

and in `loadEnv`, after the existing production `SESSION_SECRET` check:

```ts
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.PLATFORM_SECRET_KEY) {
    throw new Error('PLATFORM_SECRET_KEY must be set in production');
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @legalops/api exec vitest run src/modules/platform`
Expected: PASS (all totp + secrets tests).

- [ ] **Step 6: Checkpoint** — `pnpm --filter @legalops/api typecheck`. Suggested message: `feat(platform): TOTP and secret encryption primitives`.

---

### Task 3: Platform authentication realm

**Files:**
- Create: `packages/types/src/platform.ts`; Modify `packages/types/src/index.ts` (add `export * from './platform.js';`), `packages/types/src/api.ts` (error codes)
- Create: `packages/validation/src/platform.ts`; Modify `packages/validation/src/index.ts` (add `export * from './platform.js';`)
- Modify: `apps/api/src/http/context.ts`
- Create: `apps/api/src/modules/platform/platform-auth.service.ts`, `apps/api/src/modules/platform/platform.routes.ts`, `apps/api/src/scripts/create-platform-admin.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/package.json` (script)
- Test: `apps/api/test/platform-helpers.ts`, `apps/api/test/platform-auth.test.ts`

**Interfaces:**
- Consumes: Task 2 primitives; `hashPassword`, `verifyPassword`, `hashToken`, `randomToken` from `modules/auth/crypto.ts`.
- Produces:
  - Types: `OrganizationStatus = 'invited' | 'active' | 'suspended'`; `PlatformMe = { admin: { id: string; email: string; name: string }; mfaEnrolled: boolean; mfaVerified: boolean; csrfToken: string }`; `ApiErrorCode` gains `'MFA_REQUIRED' | 'FIRM_SUSPENDED'`.
  - Express: `req.platform?: PlatformAuth` where `PlatformAuth = { sessionId: string; adminId: string; csrfSecret: string; mfaVerified: boolean }`.
  - Service: `createOrResetAdmin(db, { email, name, reset }): Promise<{ password: string; created: boolean }>`; `platformLogin(deps, { email, password }, meta): Promise<{ token; expiresAt; me: PlatformMe }>`; `loadPlatformSession(deps, token): Promise<PlatformAuth | null>`; `startTotpEnrolment(deps, auth): Promise<{ secret; otpauthUrl }>`; `confirmTotp(deps, auth, code, meta): Promise<PlatformMe>`; `getPlatformMe(deps, sessionId): Promise<PlatformMe>`; `platformLogout(deps, auth)`; `recordPlatformAudit(db, { adminId, action, organizationId?, details?, ip? })`.
  - Router: `platformRouter(deps, limits: RateLimits): Router` mounted at `/api/v1/platform`; exports `PLATFORM_COOKIE = 'lf_psid'`, `requirePlatformMfa`, `platformCtx(req)`.
  - Endpoints: `POST /auth/login`, `POST /auth/totp/enroll`, `POST /auth/totp/verify`, `GET /auth/me`, `POST /auth/logout`.
  - Test helpers: `createPlatformAdmin(email, opts?: { enrolled?: boolean }): Promise<{ id; secret }>`, `platformLogin(app, email, secret): Promise<PlatformSession>` where `PlatformSession = { agent; csrf }` (fully MFA-verified).

- [ ] **Step 1: Write the failing tests**

`apps/api/test/platform-helpers.ts`:

```ts
import type { Server } from 'node:http';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import { encryptSecret, platformKey } from '../src/modules/platform/secrets.js';
import { currentStep, generateTotpSecret, totpCode } from '../src/modules/platform/totp.js';
import { deps, PASSWORD, pool } from './helpers.js';

export type PlatformSession = { agent: TestAgent; csrf: string };

/** Inserts a platform admin with PASSWORD; enrolled admins get a known TOTP secret. */
export async function createPlatformAdmin(email: string, opts: { enrolled?: boolean } = { enrolled: true }) {
  const secret = generateTotpSecret();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO platform_admins (email, name, password_hash, totp_secret_enc, totp_enrolled_at)
     VALUES ($1, 'Ops', $2, $3, $4) RETURNING id`,
    [email, await hashPassword(PASSWORD), opts.enrolled ? encryptSecret(platformKey(deps.env), secret) : null, opts.enrolled ? new Date() : null],
  );
  return { id: rows[0]!.id, secret };
}

/** A code for a step no earlier verification can have used (the replay guard rejects reused steps). */
export function freshCode(secret: string, offsetSteps = 0): string {
  return totpCode(secret, currentStep(Date.now()) + offsetSteps);
}

export async function platformLogin(app: Server, email: string, secret: string): Promise<PlatformSession> {
  const agent = request.agent(app);
  const login = await agent.post('/api/v1/platform/auth/login').send({ email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`platform login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const csrf = login.body.data.csrfToken as string;
  const v = await agent.post('/api/v1/platform/auth/totp/verify').set('X-CSRF-Token', csrf).send({ code: freshCode(secret) });
  if (v.status !== 200) throw new Error(`platform TOTP failed: ${v.status} ${JSON.stringify(v.body)}`);
  return { agent, csrf };
}
```

`apps/api/test/platform-auth.test.ts`:

```ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createOrResetAdmin } from '../src/modules/platform/platform-auth.service.js';
import { buildApp, createFirm, loginAs, PASSWORD, pool, useDatabase } from './helpers.js';
import { createPlatformAdmin, freshCode, platformLogin } from './platform-helpers.js';

useDatabase();
const app = buildApp();
const P = '/api/v1/platform';

describe('platform auth', () => {
  it('password alone does not open the console: MFA is required', async () => {
    await createPlatformAdmin('ops@lfx.test');
    const agent = request.agent(app);
    const login = await agent.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data).toMatchObject({ mfaEnrolled: true, mfaVerified: false });
    const firms = await agent.get(`${P}/firms`);
    expect(firms.status).toBe(401);
    expect(firms.body.error.code).toBe('MFA_REQUIRED');
  });

  it('first login enrols TOTP; the first valid code completes enrolment and the session', async () => {
    await createPlatformAdmin('new@lfx.test', { enrolled: false });
    const agent = request.agent(app);
    const login = await agent.post(`${P}/auth/login`).send({ email: 'new@lfx.test', password: PASSWORD });
    expect(login.body.data.mfaEnrolled).toBe(false);
    const csrf = login.body.data.csrfToken;
    const enrol = await agent.post(`${P}/auth/totp/enroll`).set('X-CSRF-Token', csrf).send({});
    expect(enrol.status).toBe(200);
    expect(enrol.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const ok = await agent.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', csrf).send({ code: freshCode(enrol.body.data.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ mfaEnrolled: true, mfaVerified: true });
    expect((await agent.get(`${P}/auth/me`)).body.data.admin.email).toBe('new@lfx.test');
    // Once enrolled, the secret cannot be replaced from a session.
    expect((await agent.post(`${P}/auth/totp/enroll`).set('X-CSRF-Token', csrf).send({})).status).toBe(409);
  });

  it('wrong password and unknown email look the same', async () => {
    await createPlatformAdmin('ops@lfx.test');
    const a = await request(app).post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: 'wrong-password-123' });
    const b = await request(app).post(`${P}/auth/login`).send({ email: 'nobody@lfx.test', password: 'wrong-password-123' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toEqual(b.body.error);
  });

  it('replay: the same TOTP code cannot be used twice', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const code = freshCode(secret);
    const s1 = request.agent(app);
    const l1 = await s1.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    expect((await s1.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', l1.body.data.csrfToken).send({ code })).status).toBe(200);
    const s2 = request.agent(app);
    const l2 = await s2.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    const again = await s2.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', l2.body.data.csrfToken).send({ code });
    expect(again.status).toBe(401);
  });

  it('realm isolation: a firm session gets nothing from the platform, a platform session nothing from the firm API', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const firm = await loginAs(app, 'owner@a.test');
    expect((await firm.agent.get(`${P}/auth/me`)).status).toBe(401);
    expect((await firm.agent.get(`${P}/firms`)).status).toBe(401);
    const plat = await platformLogin(app, 'ops@lfx.test', secret);
    expect((await plat.agent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await plat.agent.get('/api/v1/clients')).status).toBe(401);
    // The platform cookie is scoped to the platform API path.
    const login = await request(app).post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    expect(String(login.headers['set-cookie'])).toMatch(/lf_psid=.*Path=\/api\/v1\/platform.*HttpOnly.*SameSite=Strict/i);
  });

  it('mutations need the platform CSRF token', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const plat = await platformLogin(app, 'ops@lfx.test', secret);
    expect((await plat.agent.post(`${P}/auth/logout`).send({})).status).toBe(403);
    expect((await plat.agent.post(`${P}/auth/logout`).set('X-CSRF-Token', plat.csrf).send({})).status).toBe(204);
    expect((await plat.agent.get(`${P}/auth/me`)).status).toBe(401);
  });

  it('idle sessions expire after 30 minutes', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const plat = await platformLogin(app, 'ops@lfx.test', secret);
    await pool.query(`UPDATE platform_sessions SET last_seen_at = now() - interval '31 minutes'`);
    expect((await plat.agent.get(`${P}/auth/me`)).status).toBe(401);
  });

  it('a deactivated admin is locked out at once', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const plat = await platformLogin(app, 'ops@lfx.test', secret);
    await pool.query(`UPDATE platform_admins SET is_active = false`);
    expect((await plat.agent.get(`${P}/auth/me`)).status).toBe(401);
  });

  it('the CLI creates an admin, and --reset issues a new password and clears TOTP', async () => {
    const first = await createOrResetAdmin(pool, { email: 'cli@lfx.test', name: 'CLI', reset: false });
    expect(first.created).toBe(true);
    expect(first.password).toHaveLength(24);
    await expect(createOrResetAdmin(pool, { email: 'cli@lfx.test', name: 'CLI', reset: false })).rejects.toThrow(/exists/);
    await pool.query(`UPDATE platform_admins SET totp_enrolled_at = now(), totp_secret_enc = 'x' WHERE email = 'cli@lfx.test'`);
    const again = await createOrResetAdmin(pool, { email: 'cli@lfx.test', name: 'CLI', reset: true });
    expect(again.created).toBe(false);
    const row = (await pool.query(`SELECT totp_secret_enc, totp_enrolled_at FROM platform_admins WHERE email = 'cli@lfx.test'`)).rows[0];
    expect(row).toEqual({ totp_secret_enc: null, totp_enrolled_at: null });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @legalops/api exec vitest run test/platform-auth.test.ts`
Expected: FAIL — `platform-auth.service.js` not found.

- [ ] **Step 3: Types and validation**

`packages/types/src/platform.ts`:

```ts
import type { Permission } from './permissions.js';

export type OrganizationStatus = 'invited' | 'active' | 'suspended';

export type PlatformMe = {
  admin: { id: string; email: string; name: string };
  mfaEnrolled: boolean;
  mfaVerified: boolean;
  csrfToken: string;
};

export type PlatformInvitationState = 'pending' | 'accepted' | 'expired' | 'revoked';

export type PlatformFirmSummary = {
  id: string;
  name: string;
  status: OrganizationStatus;
  ownerName: string | null;
  ownerEmail: string | null;
  inviteEmail: string | null;
  userCount: number;
  caseCount: number;
  lastActivityAt: string | null;
  createdAt: string;
};

export type PlatformAuditEntry = {
  id: string;
  action: string;
  adminName: string;
  adminEmail: string;
  organizationId: string | null;
  organizationName: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

export type PlatformFirmDetail = PlatformFirmSummary & {
  platformNotes: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  invitation: { id: string; email: string; state: PlatformInvitationState; expiresAt: string; createdAt: string } | null;
  history: PlatformAuditEntry[];
};

/** While a firm is suspended its members keep read access only (L-12, spec §5.2). */
export function allowedWhileSuspended(permission: Permission): boolean {
  return permission.endsWith('.view') || permission === 'finance.dashboard';
}
```

In `packages/types/src/api.ts`, add `| 'MFA_REQUIRED'` and `| 'FIRM_SUSPENDED'` to `ApiErrorCode` (before `'INTERNAL_ERROR'`).

`packages/validation/src/platform.ts`:

```ts
import { z } from 'zod';
import { emailSchema, uuidSchema } from './common.js';

export const platformLoginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
export const totpCodeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, { error: 'Enter the 6-digit code' }) }).strict();

export const inviteFirmSchema = z
  .object({
    firmName: z.string().trim().min(1, { error: 'Enter the firm name' }).max(200),
    partnerName: z.string().trim().min(1, { error: 'Enter the partner’s name' }).max(120),
    partnerEmail: emailSchema,
  })
  .strict();
export const reinviteFirmSchema = inviteFirmSchema.pick({ partnerName: true, partnerEmail: true }).strict();
export const firmNotesSchema = z.object({ platformNotes: z.string().max(10000).nullable() }).strict();
export const suspendFirmSchema = z.object({ reason: z.string().trim().min(1, { error: 'Give a reason' }).max(500) }).strict();
export const listFirmsSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['invited', 'active', 'suspended']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const listPlatformAuditSchema = z.object({
  organizationId: uuidSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
```

In `apps/api/src/http/context.ts` add, above `declare global`:

```ts
/** A platform (LexForgeX team) session. Never carries a firm; never authorises firm endpoints. */
export type PlatformAuth = { sessionId: string; adminId: string; csrfSecret: string; mfaVerified: boolean };
```

and inside `interface Request`: `platform?: PlatformAuth;`.

- [ ] **Step 4: Service** — `apps/api/src/modules/platform/platform-auth.service.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { PlatformMe } from '@legalops/types';
import { query, queryOne, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { PlatformAuth, RequestMeta } from '../../http/context.js';
import { AppError, conflict, unauthenticated } from '../../http/errors.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../auth/crypto.js';
import { decryptSecret, encryptSecret, platformKey } from './secrets.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.js';

const IDLE_MINUTES = 30;
const ABSOLUTE_HOURS = 12;

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

export async function recordPlatformAudit(
  db: Db,
  e: { adminId: string; action: string; organizationId?: string | null; details?: Record<string, unknown>; ip?: string | null },
): Promise<void> {
  await query(
    db,
    sql`INSERT INTO platform_audit_logs (platform_admin_id, action, organization_id, details, ip_address)
        VALUES (${e.adminId}, ${e.action}, ${e.organizationId ?? null}, ${JSON.stringify(e.details ?? {})}, ${e.ip ?? null})`,
  );
}

/** CLI only. Creates an admin, or with reset issues a new password and clears TOTP. Returns the one-time password. */
export async function createOrResetAdmin(db: Db, input: { email: string; name: string; reset: boolean }): Promise<{ password: string; created: boolean }> {
  const password = randomBytes(18).toString('base64url'); // 24 chars
  const passwordHash = await hashPassword(password);
  const existing = await queryOne<{ id: string }>(db, sql`SELECT id FROM platform_admins WHERE email = ${input.email}`);
  if (existing && !input.reset) throw new Error(`Platform admin ${input.email} already exists (use --reset)`);
  if (existing) {
    await query(
      db,
      sql`UPDATE platform_admins SET password_hash = ${passwordHash}, name = ${input.name}, totp_secret_enc = NULL,
            totp_enrolled_at = NULL, totp_last_step = NULL, is_active = true WHERE id = ${existing.id}`,
    );
    await query(db, sql`UPDATE platform_sessions SET revoked_at = now() WHERE platform_admin_id = ${existing.id} AND revoked_at IS NULL`);
    return { password, created: false };
  }
  await query(db, sql`INSERT INTO platform_admins (email, name, password_hash) VALUES (${input.email}, ${input.name}, ${passwordHash})`);
  return { password, created: true };
}

export async function platformLogin(deps: Deps, input: { email: string; password: string }, meta: RequestMeta): Promise<{ token: string; expiresAt: Date; me: PlatformMe }> {
  const admin = await queryOne<{ id: string; password_hash: string; is_active: boolean }>(
    deps.pool,
    sql`SELECT id, password_hash, is_active FROM platform_admins WHERE email = ${input.email}`,
  );
  const ok = await verifyPassword(admin?.password_hash, input.password);
  if (!admin || !ok || !admin.is_active) throw invalidCredentials();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ABSOLUTE_HOURS * 3600_000);
  const id = hashToken(deps.env.SESSION_SECRET, token);
  await query(
    deps.pool,
    sql`INSERT INTO platform_sessions (id, platform_admin_id, csrf_secret, ip_address, user_agent, expires_at)
        VALUES (${id}, ${admin.id}, ${randomToken()}, ${meta.ip}, ${meta.userAgent}, ${expiresAt})`,
  );
  return { token, expiresAt, me: await getPlatformMe(deps, id) };
}

/** Resolves the cookie; enforces revocation, absolute expiry, 30-minute idle timeout and an active admin. */
export async function loadPlatformSession(deps: Deps, token: string): Promise<PlatformAuth | null> {
  const id = hashToken(deps.env.SESSION_SECRET, token);
  const row = await queryOne<{ admin_id: string; csrf_secret: string; mfa: boolean }>(
    deps.pool,
    sql`UPDATE platform_sessions s SET last_seen_at = now()
        FROM platform_admins a
        WHERE s.id = ${id} AND a.id = s.platform_admin_id AND a.is_active
          AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.last_seen_at > now() - ${`${IDLE_MINUTES} minutes`}::interval
        RETURNING s.platform_admin_id AS admin_id, s.csrf_secret, (s.mfa_verified_at IS NOT NULL) AS mfa`,
  );
  return row ? { sessionId: id, adminId: row.admin_id, csrfSecret: row.csrf_secret, mfaVerified: row.mfa } : null;
}

export async function getPlatformMe(deps: Deps, sessionId: string): Promise<PlatformMe> {
  const row = await queryOne<{ id: string; email: string; name: string; enrolled: boolean; verified: boolean; csrf_secret: string }>(
    deps.pool,
    sql`SELECT a.id, a.email, a.name, (a.totp_enrolled_at IS NOT NULL) AS enrolled, (s.mfa_verified_at IS NOT NULL) AS verified, s.csrf_secret
        FROM platform_sessions s JOIN platform_admins a ON a.id = s.platform_admin_id WHERE s.id = ${sessionId}`,
  );
  if (!row) throw unauthenticated();
  return { admin: { id: row.id, email: row.email, name: row.name }, mfaEnrolled: row.enrolled, mfaVerified: row.verified, csrfToken: row.csrf_secret };
}

export async function startTotpEnrolment(deps: Deps, auth: PlatformAuth): Promise<{ secret: string; otpauthUrl: string }> {
  const admin = await queryOne<{ email: string; enrolled: boolean }>(
    deps.pool,
    sql`SELECT email, (totp_enrolled_at IS NOT NULL) AS enrolled FROM platform_admins WHERE id = ${auth.adminId}`,
  );
  if (!admin) throw unauthenticated();
  if (admin.enrolled) throw conflict('Two-factor sign-in is already set up. Ask another admin to reset it with the CLI.');
  const secret = generateTotpSecret();
  await query(deps.pool, sql`UPDATE platform_admins SET totp_secret_enc = ${encryptSecret(platformKey(deps.env), secret)} WHERE id = ${auth.adminId}`);
  return { secret, otpauthUrl: otpauthUrl(secret, admin.email) };
}

export async function confirmTotp(deps: Deps, auth: PlatformAuth, code: string, meta: RequestMeta): Promise<PlatformMe> {
  const admin = await queryOne<{ secret: string | null; last_step: string | null; enrolled: boolean }>(
    deps.pool,
    sql`SELECT totp_secret_enc AS secret, totp_last_step::text AS last_step, (totp_enrolled_at IS NOT NULL) AS enrolled
        FROM platform_admins WHERE id = ${auth.adminId}`,
  );
  if (!admin?.secret) throw new AppError(409, 'CONFLICT', 'Set up two-factor sign-in first');
  const step = verifyTotp(decryptSecret(platformKey(deps.env), admin.secret), code, Date.now(), admin.last_step === null ? null : Number(admin.last_step));
  if (step === null) throw new AppError(401, 'INVALID_CREDENTIALS', 'That code didn’t work. Check your authenticator and try again.');
  // The guarded UPDATE closes the race between two sessions submitting the same code.
  const updated = await query(
    deps.pool,
    sql`UPDATE platform_admins SET totp_last_step = ${step}, totp_enrolled_at = COALESCE(totp_enrolled_at, now()), last_login_at = now()
        WHERE id = ${auth.adminId} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING id`,
  );
  if (!updated.length) throw new AppError(401, 'INVALID_CREDENTIALS', 'That code was already used. Wait for the next one.');
  await query(deps.pool, sql`UPDATE platform_sessions SET mfa_verified_at = now() WHERE id = ${auth.sessionId}`);
  await recordPlatformAudit(deps.pool, { adminId: auth.adminId, action: admin.enrolled ? 'admin.signed_in' : 'admin.mfa_enrolled', ip: meta.ip });
  return getPlatformMe(deps, auth.sessionId);
}

export async function platformLogout(deps: Deps, auth: PlatformAuth): Promise<void> {
  await query(deps.pool, sql`UPDATE platform_sessions SET revoked_at = now() WHERE id = ${auth.sessionId}`);
}
```

Note: the guarded `UPDATE … WHERE totp_last_step < step` is what makes verification race-safe (two sessions submitting the same code: only one update matches).

- [ ] **Step 5: Router** — `apps/api/src/modules/platform/platform.routes.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import { platformLoginSchema, totpCodeSchema } from '@legalops/validation';
import { Router, type CookieOptions, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Deps } from '../../deps.js';
import type { PlatformAuth } from '../../http/context.js';
import { AppError, unauthenticated } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireJson } from '../../middleware/security.js';
import type { RateLimits } from '../auth/auth.routes.js';
import * as platformAuth from './platform-auth.service.js';

export const PLATFORM_COOKIE = 'lf_psid';
const COOKIE_PATH = '/api/v1/platform';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function cookieOptions(deps: Deps, expires?: Date): CookieOptions {
  return { httpOnly: true, secure: deps.env.NODE_ENV === 'production', sameSite: 'strict', path: COOKIE_PATH, ...(expires ? { expires } : {}) };
}

function limiter(max: number, windowMs: number) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } });
    },
  });
}

/** Reads only the platform cookie. The firm cookie is never consulted here. */
function platformSessionLoader(deps: Deps) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token: unknown = req.cookies?.[PLATFORM_COOKIE];
    if (typeof token === 'string' && token.length > 0 && token.length < 200) {
      const ctx = await platformAuth.loadPlatformSession(deps, token);
      if (ctx) req.platform = ctx;
    }
    next();
  };
}

function platformCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE.has(req.method) || !req.platform) return next();
  const expected = Buffer.from(req.platform.csrfSecret);
  const actual = Buffer.from(req.header('x-csrf-token') ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return next(new AppError(403, 'CSRF_INVALID', 'Your session token is out of date. Refresh and try again.'));
  }
  next();
}

function requirePlatformSession(req: Request, _res: Response, next: NextFunction): void {
  if (!req.platform) return next(unauthenticated());
  next();
}

export function requirePlatformMfa(req: Request, _res: Response, next: NextFunction): void {
  if (!req.platform) return next(unauthenticated());
  if (!req.platform.mfaVerified) return next(new AppError(401, 'MFA_REQUIRED', 'Enter your two-factor code to continue'));
  next();
}

export function platformCtx(req: Request): PlatformAuth {
  if (!req.platform?.mfaVerified) throw unauthenticated();
  return req.platform;
}

export function platformRouter(deps: Deps, limits: RateLimits): Router {
  const r = Router();
  r.use(requireJson, platformSessionLoader(deps), platformCsrf);

  r.post('/auth/login', limiter(limits.loginPerWindow, limits.windowMs), async (req, res) => {
    const input = parse(platformLoginSchema, req.body);
    const { token, expiresAt, me } = await platformAuth.platformLogin(deps, input, requestMeta(req));
    res.cookie(PLATFORM_COOKIE, token, cookieOptions(deps, expiresAt));
    res.json({ data: me });
  });
  r.post('/auth/totp/enroll', requirePlatformSession, async (req, res) => {
    res.json({ data: await platformAuth.startTotpEnrolment(deps, req.platform!) });
  });
  r.post('/auth/totp/verify', limiter(limits.loginPerWindow, limits.windowMs), requirePlatformSession, async (req, res) => {
    const { code } = parse(totpCodeSchema, req.body);
    res.json({ data: await platformAuth.confirmTotp(deps, req.platform!, code, requestMeta(req)) });
  });
  r.get('/auth/me', requirePlatformSession, async (req, res) => {
    res.json({ data: await platformAuth.getPlatformMe(deps, req.platform!.sessionId) });
  });
  r.post('/auth/logout', requirePlatformSession, async (req, res) => {
    await platformAuth.platformLogout(deps, req.platform!);
    res.clearCookie(PLATFORM_COOKIE, cookieOptions(deps));
    res.status(204).end();
  });

  // Everything else needs a fully verified (password + TOTP) session. Firm routes are added in Task 4.
  r.use(requirePlatformMfa);

  // Never fall through into the firm router.
  r.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  return r;
}
```

In `apps/api/src/app.ts`: import `platformRouter`, and mount it **immediately before** `app.use('/api/v1', api);`:

```ts
  // Platform realm (LexForgeX team): own cookie, session, CSRF and MFA; never runs firm middleware.
  app.use('/api/v1/platform', platformRouter(deps, { ...DEFAULT_LIMITS, ...opts.rateLimits }));
```

Note: the platform router must come before `app.use('/api/v1', api)` so the firm `sessionLoader`/`csrfProtection` never run for platform paths.

- [ ] **Step 6: CLI** — `apps/api/src/scripts/create-platform-admin.ts`:

```ts
/**
 * Creates a LexForgeX platform admin, or resets one (--reset: new password, TOTP cleared, sessions revoked).
 * Prints the one-time password once. Usage:
 *   pnpm --filter @legalops/api platform:create-admin -- --email ops@lexforgex.com --name "Ops" [--reset]
 */
import { parseArgs } from 'node:util';
import { emailSchema } from '@legalops/validation';
import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { createOrResetAdmin } from '../modules/platform/platform-auth.service.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, reset: { type: 'boolean', default: false } } });
const email = emailSchema.parse(values.email);
const name = (values.name ?? '').trim();
if (!name) throw new Error('--name is required');

const pool = createPool(loadEnv().DATABASE_URL);
try {
  const { password, created } = await createOrResetAdmin(pool, { email, name, reset: values.reset ?? false });
  console.log(`${created ? 'Created' : 'Reset'} platform admin ${email}.`);
  console.log(`One-time password (shown once): ${password}`);
  console.log('They will set up two-factor sign-in on first login at /platform/login.');
} finally {
  await pool.end();
}
```

In `apps/api/package.json` scripts add: `"platform:create-admin": "tsx --env-file=../../.env src/scripts/create-platform-admin.ts"`.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @legalops/api exec vitest run test/platform-auth.test.ts src/modules/platform`
Expected: PASS. If the cookie-attribute regex fails only on attribute order, assert each attribute separately rather than loosening the requirement.

- [ ] **Step 8: Checkpoint** — full API suite + `pnpm typecheck` + `pnpm lint`. Suggested message: `feat(platform): separate admin realm with TOTP and isolated sessions`.

---

### Task 4: Firm management API and owner invitation

**Files:**
- Create: `apps/api/src/modules/platform/platform-firms.service.ts`
- Modify: `apps/api/src/modules/platform/platform.routes.ts` (firm + audit routes after `r.use(requirePlatformMfa)`)
- Modify: `apps/api/src/modules/workflows/processor.ts` (owner-invite email)
- Modify: `apps/api/src/modules/auth/auth.service.ts` (`acceptInvitation`)
- Test: `apps/api/test/platform-firms.test.ts`

**Interfaces:**
- Consumes: `recordPlatformAudit`, `platformCtx`, `requirePlatformMfa` (Task 3); `emitEvent` (`modules/outbox/outbox.service.ts`); `pageClause`, `likeContains`, `iso` (`http/query-helpers.ts`); validation schemas from Task 3.
- Produces endpoints (all MFA-gated):
  - `GET /platform/firms` → `{ data: PlatformFirmSummary[], meta }`
  - `POST /platform/firms` `{ firmName, partnerName, partnerEmail }` → `201 { data: PlatformFirmDetail }`
  - `GET /platform/firms/:id` → `PlatformFirmDetail`
  - `PATCH /platform/firms/:id` `{ platformNotes }` → `PlatformFirmDetail`
  - `POST /platform/firms/:id/suspend` `{ reason }`, `POST /platform/firms/:id/reactivate` → `PlatformFirmDetail`
  - `POST /platform/firms/:id/invitation/resend`, `POST /platform/firms/:id/invitation/revoke`, `POST /platform/firms/:id/invitation` `{ partnerName, partnerEmail }` → `PlatformFirmDetail`
  - `GET /platform/audit-logs?organizationId&page&pageSize` → `{ data: PlatformAuditEntry[], meta }`
- Event: `MEMBER_INVITED` payload `{ invitationId, email, role: 'owner', platformInvite: true, partnerName }` → template `firm_owner_invite`.
- `acceptInvitation` sets `organizations.status = 'active'` when it was `invited`.

- [ ] **Step 1: Write the failing tests** — `apps/api/test/platform-firms.test.ts`:

```ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import { issueInvitationToken } from '../src/modules/auth/auth.service.js';
import type { EmailMessage, EmailProvider } from '../src/modules/notifications/providers.js';
import { tick } from '../src/modules/workflows/processor.js';
import { buildApp, createFirm, deps as baseDeps, loginAs, PASSWORD, pool, useDatabase } from './helpers.js';
import { createPlatformAdmin, platformLogin, type PlatformSession } from './platform-helpers.js';

useDatabase();
const app = buildApp();
const P = '/api/v1/platform';

class CaptureEmail implements EmailProvider {
  readonly name = 'capture';
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return { providerMessageId: `cap-${this.sent.length}` };
  }
}
const post = (s: PlatformSession, path: string, body: object = {}) => s.agent.post(`${P}${path}`).set('X-CSRF-Token', s.csrf).send(body);

async function ops() {
  const { secret } = await createPlatformAdmin('ops@lfx.test');
  return platformLogin(app, 'ops@lfx.test', secret);
}
async function invite(s: PlatformSession, email = 'partner@vidhimeya.test') {
  const res = await post(s, '/firms', { firmName: 'Vidhimeya', partnerName: 'Asha Rao', partnerEmail: email });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; invitation: { id: string } };
}

describe('platform: firms', () => {
  it('invite creates an invited firm, emails the partner a set-up link, and is audited', async () => {
    const s = await ops();
    const firm = await invite(s);
    expect(firm).toMatchObject({ name: 'Vidhimeya', status: 'invited', inviteEmail: 'partner@vidhimeya.test', invitation: { state: 'pending' } });
    const email = new CaptureEmail();
    await tick({ ...baseDeps, email } as Deps, new Date());
    const [m] = email.sent;
    expect(m!.to).toBe('partner@vidhimeya.test');
    expect(m!.subject).toBe('Set up Vidhimeya on LexForgeX');
    expect(m!.text).toMatch(/Hello Asha/);
    expect(m!.text).toMatch(/accept-invite\?token=/);
    const audit = await s.agent.get(`${P}/audit-logs`).query({ organizationId: firm.id });
    expect(audit.body.data.map((a: { action: string }) => a.action)).toContain('firm.invited');
  });

  it('accepting the owner invite makes the partner owner and the firm active', async () => {
    const s = await ops();
    const firm = await invite(s);
    const token = await issueInvitationToken(baseDeps, firm.invitation.id);
    const acc = await request(app).post('/api/v1/auth/invitations/accept').send({ token, firstName: 'Asha', password: PASSWORD });
    expect(acc.status).toBe(200);
    const detail = await s.agent.get(`${P}/firms/${firm.id}`);
    expect(detail.body.data).toMatchObject({ status: 'active', ownerEmail: 'partner@vidhimeya.test', userCount: 1, invitation: { state: 'accepted' } });
  });

  it('existing user: accepting adds them as owner of the new firm without changing their password', async () => {
    await createFirm('Other firm', [{ email: 'asha@shared.test', role: 'lawyer' }]);
    const before = (await pool.query(`SELECT password_hash FROM users WHERE email = 'asha@shared.test'`)).rows[0].password_hash;
    const s = await ops();
    const firm = await invite(s, 'asha@shared.test');
    const token = await issueInvitationToken(baseDeps, firm.invitation.id);
    const acc = await request(app).post('/api/v1/auth/invitations/accept').send({ token, firstName: 'Asha', password: 'a-different-password-1' });
    expect(acc.status).toBe(200);
    expect((await pool.query(`SELECT password_hash FROM users WHERE email = 'asha@shared.test'`)).rows[0].password_hash).toBe(before);
    expect((await s.agent.get(`${P}/firms/${firm.id}`)).body.data.status).toBe('active');
    const me = await loginAs(app, 'asha@shared.test');
    const mine = await me.agent.get('/api/v1/auth/me');
    expect(mine.body.data.memberships.map((x: { organizationName: string }) => x.organizationName)).toEqual(expect.arrayContaining(['Other firm', 'Vidhimeya']));
  });

  it('resend voids the old link; revoke then re-invite to a corrected email', async () => {
    const s = await ops();
    const firm = await invite(s, 'typo@vidhimeya.test');
    const oldToken = await issueInvitationToken(baseDeps, firm.invitation.id);
    expect((await post(s, `/firms/${firm.id}/invitation/resend`)).status).toBe(200);
    await tick({ ...baseDeps, email: new CaptureEmail() } as Deps, new Date()); // sending mints the new link
    const stale = await request(app).post('/api/v1/auth/invitations/accept').send({ token: oldToken, firstName: 'X', password: PASSWORD });
    expect(stale.status).toBe(400);
    const revoked = await post(s, `/firms/${firm.id}/invitation/revoke`);
    expect(revoked.body.data.invitation.state).toBe('revoked');
    const re = await post(s, `/firms/${firm.id}/invitation`, { partnerName: 'Asha Rao', partnerEmail: 'asha@vidhimeya.test' });
    expect(re.body.data).toMatchObject({ status: 'invited', inviteEmail: 'asha@vidhimeya.test', invitation: { state: 'pending', email: 'asha@vidhimeya.test' } });
  });

  it('notes are saved for the team and never shown to the firm', async () => {
    const s = await ops();
    const { orgId } = await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const saved = await s.agent.patch(`${P}/firms/${orgId}`).set('X-CSRF-Token', s.csrf).send({ platformNotes: 'Paid ₹60,000 till 31 Mar 2027' });
    expect(saved.body.data.platformNotes).toBe('Paid ₹60,000 till 31 Mar 2027');
    const owner = await loginAs(app, 'owner@a.test');
    const org = await owner.agent.get('/api/v1/organization');
    expect(JSON.stringify(org.body)).not.toContain('60,000');
  });

  it('suspend needs a reason and an active firm; reactivate only from suspended; both audited', async () => {
    const s = await ops();
    const { orgId } = await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    expect((await post(s, `/firms/${orgId}/suspend`, {})).status).toBe(422);
    const sus = await post(s, `/firms/${orgId}/suspend`, { reason: 'Unpaid since September' });
    expect(sus.body.data).toMatchObject({ status: 'suspended', suspendedReason: 'Unpaid since September' });
    expect((await post(s, `/firms/${orgId}/suspend`, { reason: 'again' })).status).toBe(409);
    const re = await post(s, `/firms/${orgId}/reactivate`);
    expect(re.body.data).toMatchObject({ status: 'active', suspendedAt: null, suspendedReason: null });
    expect((await post(s, `/firms/${orgId}/reactivate`)).status).toBe(409);
    const actions = (await s.agent.get(`${P}/audit-logs`).query({ organizationId: orgId })).body.data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['firm.suspended', 'firm.reactivated']));
  });

  it('lists firms with counts, search and status filter', async () => {
    const s = await ops();
    await createFirm('Alpha Legal', [{ email: 'o@alpha.test', role: 'owner' }, { email: 'l@alpha.test', role: 'lawyer' }]);
    await invite(s);
    const all = await s.agent.get(`${P}/firms`);
    expect(all.body.meta.total).toBe(2);
    const alpha = all.body.data.find((f: { name: string }) => f.name === 'Alpha Legal');
    expect(alpha).toMatchObject({ status: 'active', userCount: 2, caseCount: 0, ownerEmail: 'o@alpha.test' });
    expect((await s.agent.get(`${P}/firms`).query({ search: 'vidhi' })).body.data.map((f: { name: string }) => f.name)).toEqual(['Vidhimeya']);
    expect((await s.agent.get(`${P}/firms`).query({ status: 'invited' })).body.meta.total).toBe(1);
  });

  it('unknown firm id is a 404, not a 500', async () => {
    const s = await ops();
    expect((await s.agent.get(`${P}/firms/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @legalops/api exec vitest run test/platform-firms.test.ts`
Expected: FAIL — `POST /platform/firms` returns 404.

- [ ] **Step 3: Service** — `apps/api/src/modules/platform/platform-firms.service.ts`:

```ts
import type { OrganizationStatus, PlatformAuditEntry, PlatformFirmDetail, PlatformFirmSummary, PlatformInvitationState } from '@legalops/types';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { PlatformAuth, RequestMeta } from '../../http/context.js';
import { conflict, notFound } from '../../http/errors.js';
import { iso, likeContains, pageClause, type Page } from '../../http/query-helpers.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { recordPlatformAudit } from './platform-auth.service.js';

type FirmRow = {
  id: string; name: string; status: OrganizationStatus; created_at: Date; user_count: number; case_count: number;
  last_activity_at: Date | null; owner_email: string | null; owner_name: string | null; invite_email: string | null;
};

const FIRM_SELECT = sql`
  SELECT o.id, o.name, o.status, o.created_at,
    (SELECT count(*) FROM organization_members m WHERE m.organization_id = o.id AND m.status = 'active')::int AS user_count,
    (SELECT count(*) FROM cases c WHERE c.organization_id = o.id)::int AS case_count,
    (SELECT max(s.last_seen_at) FROM sessions s WHERE s.active_organization_id = o.id) AS last_activity_at,
    owner.email AS owner_email, owner.name AS owner_name, inv.email AS invite_email
  FROM organizations o
  LEFT JOIN LATERAL (
    SELECT u.email, trim(u.first_name || ' ' || COALESCE(u.last_name, '')) AS name
    FROM organization_members m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active' ORDER BY m.joined_at LIMIT 1) owner ON TRUE
  LEFT JOIN LATERAL (
    SELECT i.email FROM invitations i
    WHERE i.organization_id = o.id AND i.role = 'owner' AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    ORDER BY i.created_at DESC LIMIT 1) inv ON TRUE`;

const toSummary = (r: FirmRow): PlatformFirmSummary => ({
  id: r.id, name: r.name, status: r.status, ownerName: r.owner_name, ownerEmail: r.owner_email, inviteEmail: r.invite_email,
  userCount: r.user_count, caseCount: r.case_count, lastActivityAt: iso(r.last_activity_at), createdAt: r.created_at.toISOString(),
});

export async function listFirms(deps: Deps, f: Page & { search?: string | undefined; status?: OrganizationStatus | undefined }) {
  const where = sql`WHERE (${f.search ?? null}::text IS NULL OR o.name ILIKE ${f.search ? likeContains(f.search) : null})
                      AND (${f.status ?? null}::text IS NULL OR o.status = ${f.status ?? null})`;
  const rows = await query<FirmRow>(deps.pool, sql`${FIRM_SELECT} ${where} ORDER BY o.created_at DESC ${pageClause(f)}`);
  const total = await queryOne<{ n: number }>(deps.pool, sql`SELECT count(*)::int AS n FROM organizations o ${where}`);
  return { items: rows.map(toSummary), meta: { page: f.page, pageSize: f.pageSize, total: total!.n } };
}

export async function listPlatformAudit(db: Db, f: Page & { organizationId?: string | undefined }) {
  const where = sql`WHERE (${f.organizationId ?? null}::uuid IS NULL OR l.organization_id = ${f.organizationId ?? null})`;
  const rows = await query<{ id: string; action: string; admin_name: string; admin_email: string; organization_id: string | null; organization_name: string | null; details: Record<string, unknown>; created_at: Date }>(
    db,
    sql`SELECT l.id::text, l.action, a.name AS admin_name, a.email AS admin_email, l.organization_id, o.name AS organization_name, l.details, l.created_at
        FROM platform_audit_logs l JOIN platform_admins a ON a.id = l.platform_admin_id LEFT JOIN organizations o ON o.id = l.organization_id
        ${where} ORDER BY l.created_at DESC, l.id DESC ${pageClause(f)}`,
  );
  const total = await queryOne<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM platform_audit_logs l ${where}`);
  const items: PlatformAuditEntry[] = rows.map((r) => ({
    id: r.id, action: r.action, adminName: r.admin_name, adminEmail: r.admin_email, organizationId: r.organization_id,
    organizationName: r.organization_name, details: r.details, createdAt: r.created_at.toISOString(),
  }));
  return { items, meta: { page: f.page, pageSize: f.pageSize, total: total!.n } };
}

export async function getFirm(db: Db, id: string): Promise<PlatformFirmDetail> {
  const row = await queryOne<FirmRow & { platform_notes: string | null; suspended_at: Date | null; suspended_reason: string | null }>(
    db,
    sql`SELECT f.*, o2.platform_notes, o2.suspended_at, o2.suspended_reason FROM (${FIRM_SELECT} WHERE o.id = ${id}) f
        JOIN organizations o2 ON o2.id = f.id`,
  );
  if (!row) throw notFound('Firm');
  const inv = await queryOne<{ id: string; email: string; accepted_at: Date | null; revoked_at: Date | null; expires_at: Date; created_at: Date }>(
    db,
    sql`SELECT id, email, accepted_at, revoked_at, expires_at, created_at FROM invitations
        WHERE organization_id = ${id} AND role = 'owner' AND invited_by_platform_admin_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
  );
  const state: PlatformInvitationState | null = !inv ? null : inv.accepted_at ? 'accepted' : inv.revoked_at ? 'revoked' : inv.expires_at < new Date() ? 'expired' : 'pending';
  const history = await listPlatformAudit(db, { organizationId: id, page: 1, pageSize: 50 });
  return {
    ...toSummary(row),
    platformNotes: row.platform_notes,
    suspendedAt: iso(row.suspended_at),
    suspendedReason: row.suspended_reason,
    invitation: inv && state ? { id: inv.id, email: inv.email, state, expiresAt: inv.expires_at.toISOString(), createdAt: inv.created_at.toISOString() } : null,
    history: history.items,
  };
}

async function lockFirm(db: Db, id: string) {
  const org = await queryOne<{ id: string; status: OrganizationStatus }>(db, sql`SELECT id, status FROM organizations WHERE id = ${id} FOR UPDATE`);
  if (!org) throw notFound('Firm');
  return org;
}

/** Revokes any open owner invite, creates a new one and queues the set-up email (link minted at send time). */
async function issueOwnerInvite(db: Db, auth: PlatformAuth, orgId: string, partnerName: string, partnerEmail: string): Promise<string> {
  await query(db, sql`UPDATE invitations SET revoked_at = now() WHERE organization_id = ${orgId} AND accepted_at IS NULL AND revoked_at IS NULL`);
  const inv = await queryOne<{ id: string }>(
    db,
    sql`INSERT INTO invitations (organization_id, email, role, invited_by_platform_admin_id, expires_at)
        VALUES (${orgId}, ${partnerEmail}, 'owner', ${auth.adminId}, now() + interval '7 days') RETURNING id`,
  );
  await emitEvent(db, {
    organizationId: orgId, eventType: 'MEMBER_INVITED', aggregateType: 'invitation', aggregateId: inv!.id,
    payload: { invitationId: inv!.id, email: partnerEmail, role: 'owner', platformInvite: true, partnerName }, actorUserId: null,
  });
  return inv!.id;
}

export async function inviteFirm(deps: Deps, auth: PlatformAuth, input: { firmName: string; partnerName: string; partnerEmail: string }, meta: RequestMeta) {
  const id = await withTransaction(deps.pool, async (tx) => {
    const org = await queryOne<{ id: string }>(tx, sql`INSERT INTO organizations (name, status) VALUES (${input.firmName}, 'invited') RETURNING id`);
    await issueOwnerInvite(tx, auth, org!.id, input.partnerName, input.partnerEmail);
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.invited', organizationId: org!.id, details: { partnerEmail: input.partnerEmail }, ip: meta.ip });
    return org!.id;
  });
  return getFirm(deps.pool, id);
}

export async function updateNotes(deps: Deps, auth: PlatformAuth, id: string, platformNotes: string | null, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    await lockFirm(tx, id);
    await query(tx, sql`UPDATE organizations SET platform_notes = ${platformNotes} WHERE id = ${id}`);
    // Notes can hold payment details; the audit records that they changed, not what they say.
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.notes_updated', organizationId: id, details: { length: platformNotes?.length ?? 0 }, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

export async function suspendFirm(deps: Deps, auth: PlatformAuth, id: string, reason: string, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const org = await lockFirm(tx, id);
    if (org.status !== 'active') throw conflict(`Only an active firm can be suspended (this one is ${org.status})`);
    await query(tx, sql`UPDATE organizations SET status = 'suspended', suspended_at = now(), suspended_reason = ${reason} WHERE id = ${id}`);
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.suspended', organizationId: id, details: { reason }, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

export async function reactivateFirm(deps: Deps, auth: PlatformAuth, id: string, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const org = await lockFirm(tx, id);
    if (org.status !== 'suspended') throw conflict(`Only a suspended firm can be reactivated (this one is ${org.status})`);
    await query(tx, sql`UPDATE organizations SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = ${id}`);
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.reactivated', organizationId: id, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

async function openOwnerInvite(db: Db, orgId: string) {
  return queryOne<{ id: string; email: string }>(
    db,
    sql`SELECT id, email FROM invitations WHERE organization_id = ${orgId} AND role = 'owner' AND accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
  );
}

export async function resendInvite(deps: Deps, auth: PlatformAuth, id: string, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const org = await lockFirm(tx, id);
    if (org.status !== 'invited') throw conflict('This firm has already been set up');
    const inv = await openOwnerInvite(tx, id);
    if (!inv) throw conflict('There is no open invitation; send a new one');
    // A new MEMBER_INVITED event sends a fresh email; minting its link replaces the old token and resets expiry.
    await query(tx, sql`UPDATE invitations SET expires_at = now() + interval '7 days' WHERE id = ${inv.id}`);
    const prior = await queryOne<{ name: string | null }>(
      tx,
      sql`SELECT payload->>'partnerName' AS name FROM outbox_events
          WHERE event_type = 'MEMBER_INVITED' AND payload->>'invitationId' = ${inv.id} ORDER BY created_at LIMIT 1`,
    );
    await emitEvent(tx, {
      organizationId: id, eventType: 'MEMBER_INVITED', aggregateType: 'invitation', aggregateId: inv.id,
      payload: { invitationId: inv.id, email: inv.email, role: 'owner', platformInvite: true, partnerName: prior?.name ?? '' }, actorUserId: null,
    });
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.invite_resent', organizationId: id, details: { partnerEmail: inv.email }, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

export async function revokeInvite(deps: Deps, auth: PlatformAuth, id: string, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const org = await lockFirm(tx, id);
    if (org.status !== 'invited') throw conflict('This firm has already been set up');
    const inv = await openOwnerInvite(tx, id);
    if (!inv) throw conflict('There is no open invitation');
    await query(tx, sql`UPDATE invitations SET revoked_at = now() WHERE id = ${inv.id}`);
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.invite_revoked', organizationId: id, details: { partnerEmail: inv.email }, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

export async function reinviteFirm(deps: Deps, auth: PlatformAuth, id: string, input: { partnerName: string; partnerEmail: string }, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const org = await lockFirm(tx, id);
    if (org.status !== 'invited') throw conflict('This firm has already been set up');
    await issueOwnerInvite(tx, auth, id, input.partnerName, input.partnerEmail);
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.reinvited', organizationId: id, details: { partnerEmail: input.partnerEmail }, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}
```

Verify before running: `emitEvent`'s argument type accepts `actorUserId: null` (check `apps/api/src/modules/outbox/outbox.service.ts`); `pageClause` returns `LIMIT … OFFSET …`; `likeContains` returns a `%…%` pattern with escaping. Adjust only the call shapes if they differ.

The resend relies on the existing behaviour that sending a `member_invite`-sensitive notification calls `issueInvitationToken`, which overwrites `token_hash` (voiding the old link). The test asserts this.

- [ ] **Step 4: Routes** — in `platform.routes.ts`, import the schemas (`inviteFirmSchema`, `reinviteFirmSchema`, `firmNotesSchema`, `suspendFirmSchema`, `listFirmsSchema`, `listPlatformAuditSchema`, `uuidSchema`) and `* as firms from './platform-firms.service.js'`; insert after `r.use(requirePlatformMfa);` and before the 404 handler:

```ts
  r.get('/firms', async (req, res) => {
    const f = parse(listFirmsSchema, req.query);
    const { items, meta } = await firms.listFirms(deps, f);
    res.json({ data: items, meta });
  });
  r.post('/firms', async (req, res) => {
    const input = parse(inviteFirmSchema, req.body);
    res.status(201).json({ data: await firms.inviteFirm(deps, platformCtx(req), input, requestMeta(req)) });
  });
  r.get('/firms/:firmId', async (req, res) => {
    res.json({ data: await firms.getFirm(deps.pool, parse(uuidSchema, req.params.firmId)) });
  });
  r.patch('/firms/:firmId', async (req, res) => {
    const { platformNotes } = parse(firmNotesSchema, req.body);
    res.json({ data: await firms.updateNotes(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), platformNotes, requestMeta(req)) });
  });
  r.post('/firms/:firmId/suspend', async (req, res) => {
    const { reason } = parse(suspendFirmSchema, req.body);
    res.json({ data: await firms.suspendFirm(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), reason, requestMeta(req)) });
  });
  r.post('/firms/:firmId/reactivate', async (req, res) => {
    res.json({ data: await firms.reactivateFirm(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), requestMeta(req)) });
  });
  r.post('/firms/:firmId/invitation/resend', async (req, res) => {
    res.json({ data: await firms.resendInvite(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), requestMeta(req)) });
  });
  r.post('/firms/:firmId/invitation/revoke', async (req, res) => {
    res.json({ data: await firms.revokeInvite(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), requestMeta(req)) });
  });
  r.post('/firms/:firmId/invitation', async (req, res) => {
    const input = parse(reinviteFirmSchema, req.body);
    res.json({ data: await firms.reinviteFirm(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), input, requestMeta(req)) });
  });
  r.get('/audit-logs', async (req, res) => {
    const { items, meta } = await firms.listPlatformAudit(deps.pool, parse(listPlatformAuditSchema, req.query));
    res.json({ data: items, meta });
  });
```

- [ ] **Step 5: Owner-invite email** — in `apps/api/src/modules/workflows/processor.ts`, replace the whole `MEMBER_INVITED` branch of `handleSystemEvent` with:

```ts
  if (event.event_type === 'MEMBER_INVITED' && p.invitationId && p.email) {
    // Platform invites (LexForgeX team → firm owner) use their own template and greet the partner by first name.
    const platformInvite = (event.payload as Record<string, unknown>).platformInvite === true;
    const inviter = await queryOne<{ name: string }>(
      db,
      sql`SELECT trim(u.first_name || ' ' || COALESCE(u.last_name, '')) AS name FROM invitations i JOIN users u ON u.id = i.invited_by WHERE i.id = ${p.invitationId}`,
    );
    await createNotification(db, deps.env.APP_URL, {
      organizationId: event.organization_id,
      templateKey: platformInvite ? 'firm_owner_invite' : 'member_invite',
      recipient: { type: 'external', email: p.email, name: platformInvite && p.partnerName ? p.partnerName.split(' ')[0]! : null },
      refs: {},
      now,
      sourceEventId: event.id,
      idempotencyKey: `event:${event.id}`,
      extraVars: { invite: { role: ROLE_LABELS[p.role as Role] ?? p.role ?? '', invited_by: inviter?.name ?? '' } },
      sensitive: { kind: 'member_invite', invitationId: p.invitationId },
    });
  }
```

- [ ] **Step 6: Activate on acceptance** — in `apps/api/src/modules/auth/auth.service.ts` `acceptInvitation`, right after `UPDATE invitations SET accepted_at = now() …`:

```ts
    // A platform-invited firm becomes active when its owner accepts (spec §5.1).
    await query(tx, sql`UPDATE organizations SET status = 'active' WHERE id = ${invite.organization_id} AND status = 'invited'`);
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @legalops/api exec vitest run test/platform-firms.test.ts`
Expected: PASS.

- [ ] **Step 8: Checkpoint** — full API suite, typecheck, lint. Suggested message: `feat(platform): invite, notes, suspend and reactivate firms`.

---

### Task 5: Suspension enforcement (API, `/auth/me`, worker)

**Files:**
- Create: `apps/api/src/middleware/suspension.ts`
- Modify: `apps/api/src/http/context.ts` (`AuthContext.orgStatus`), `apps/api/src/modules/auth/auth.service.ts` (`loadSession`, `getMe`), `packages/types/src/api.ts` (`MeResponse.organization.status`), `apps/api/src/app.ts`
- Modify: `apps/api/src/modules/notifications/context.ts` (`raw.orgStatus`), `apps/api/src/modules/workflows/engine.ts` (`executeScheduledAction`)
- Test: `apps/api/test/suspension.test.ts`

**Interfaces:**
- Consumes: `organizations.status` (Task 1).
- Produces: `AuthContext.orgStatus: OrganizationStatus`; `MeResponse.organization.status: OrganizationStatus`; `blockWritesWhenSuspended` middleware; `ContextRaw.orgStatus: OrganizationStatus`; scheduled actions for suspended firms finish `skipped` with `{ reason: 'Firm suspended' }`.

- [ ] **Step 1: Write the failing tests** — `apps/api/test/suspension.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import type { EmailMessage, EmailProvider } from '../src/modules/notifications/providers.js';
import { tick } from '../src/modules/workflows/processor.js';
import { addDays, buildApp, createFirm, deps as baseDeps, loginAs, pool, practiceFixture, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const suspend = (orgId: string) =>
  pool.query(`UPDATE organizations SET status = 'suspended', suspended_at = now(), suspended_reason = 'Unpaid' WHERE id = $1`, [orgId]);
const reactivate = (orgId: string) =>
  pool.query(`UPDATE organizations SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = $1`, [orgId]);

class CaptureEmail implements EmailProvider {
  readonly name = 'capture';
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return { providerMessageId: `cap-${this.sent.length}` };
  }
}
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

describe('suspended firms are read-only', () => {
  it('reads and exports still work; /auth/me reports the status', async () => {
    const { firm, main } = await practiceFixture(app);
    await suspend(firm.orgId);
    const owner = await loginAs(app, 'owner@a.test');
    expect((await owner.agent.get('/api/v1/auth/me')).body.data.organization.status).toBe('suspended');
    expect((await owner.agent.get(`/api/v1/matters/${main.matterId}`)).status).toBe(200);
    expect((await owner.agent.get('/api/v1/clients')).status).toBe(200);
  });

  it('sweep: every write under every mounted prefix, and an unknown path, is refused', async () => {
    const { firm } = await practiceFixture(app);
    await suspend(firm.orgId);
    const owner = await loginAs(app, 'owner@a.test');
    const prefixes = ['/organization', '/clients', '/matters', '/cases', '/courts', '/search', '/hearings', '/tasks', '/dashboard',
      '/invoices', '/payments', '/expenses', '/fee-agreements', '/fee-milestones', '/billing', '/notifications', '/email-templates',
      '/workflows', '/no-such-route'];
    for (const prefix of prefixes) {
      for (const method of ['post', 'patch', 'delete'] as const) {
        const res = await owner.agent[method](`/api/v1${prefix}/anything`).set('X-CSRF-Token', owner.csrf).send({});
        expect({ prefix, method, code: res.body.error?.code }).toEqual({ prefix, method, code: 'FIRM_SUSPENDED' });
        expect(res.status).toBe(403);
      }
    }
  });

  it('logout and login still work while suspended', async () => {
    const { firm } = await practiceFixture(app);
    await suspend(firm.orgId);
    const owner = await loginAs(app, 'owner@a.test');
    expect((await owner.agent.post('/api/v1/auth/logout').set('X-CSRF-Token', owner.csrf).send({})).status).toBeLessThan(300);
  });

  it('multi-firm user: can switch to their active firm and write there', async () => {
    const { firm } = await practiceFixture(app);
    const other = await createFirm('Firm B', [{ email: 'owner@a.test', role: 'owner' }]);
    await suspend(firm.orgId);
    const owner = await loginAs(app, 'owner@a.test');
    const switched = await owner.agent.post('/api/v1/auth/switch-organization').set('X-CSRF-Token', owner.csrf).send({ organizationId: other.orgId });
    expect(switched.status).toBe(200);
    const csrf = switched.body.data.csrfToken;
    const created = await owner.agent.post('/api/v1/clients').set('X-CSRF-Token', csrf).send({ name: 'New client' });
    expect(created.status).toBe(201);
  });

  it('reactivation: reminders due during suspension are skipped, nothing stale is sent, later ones resume', async () => {
    const { firm, owner, main, today } = await practiceFixture(app);
    await pool.query(`UPDATE clients SET email = 'raj@client.test' WHERE organization_id = $1`, [firm.orgId]);
    const email = new CaptureEmail();
    const deps = { ...baseDeps, email } as Deps;
    const date = addDays(today, 5);
    await owner.agent.post('/api/v1/hearings').set('X-CSRF-Token', owner.csrf).send({ caseId: main.caseId, scheduledDate: date });
    await tick(deps, new Date());
    await suspend(firm.orgId);
    await tick(deps, ist(addDays(date, -1), '09:01')); // day-before client reminder falls due while suspended
    expect(email.sent.filter((m) => m.to === 'raj@client.test')).toHaveLength(0);
    const skipped = (await pool.query(`SELECT result->>'reason' AS reason FROM scheduled_actions WHERE status = 'skipped'`)).rows;
    expect(skipped.map((r) => r.reason)).toContain('Firm suspended');
    await reactivate(firm.orgId);
    await tick(deps, ist(addDays(date, -1), '09:02'));
    expect(email.sent.filter((m) => m.to === 'raj@client.test')).toHaveLength(0); // the skipped one is not resent
    await tick(deps, ist(date, '07:31'));
    expect(email.sent.filter((m) => m.to === 'raj@client.test').map((m) => m.subject)).toEqual([expect.stringMatching(/^Today:/)]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @legalops/api exec vitest run test/suspension.test.ts`
Expected: FAIL — `organization.status` undefined; writes succeed or 404 instead of `FIRM_SUSPENDED`; reminder is sent while suspended.

- [ ] **Step 3: Carry status on the session** —
  - `packages/types/src/api.ts`: in `MeResponse.organization` add `status: OrganizationStatus` (import from `./platform.js`).
  - `apps/api/src/http/context.ts`: `export type AuthContext = TenantContext & { sessionId: string; csrfSecret: string; orgStatus: OrganizationStatus };` (import type from `@legalops/types`).
  - `auth.service.ts` `loadSession`: add `JOIN organizations o ON o.id = s.active_organization_id` and select `o.status AS org_status`; return `orgStatus: row.org_status`.
  - `auth.service.ts` `getMe`: select `o.status AS org_status` and add `status: row.org_status` to `organization`.

- [ ] **Step 4: The middleware** — `apps/api/src/middleware/suspension.ts`:

```ts
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../http/errors.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Writes a suspended firm's users may still make: leaving, or moving to another firm. */
const ALLOWED = new Set(['POST /auth/logout', 'POST /auth/switch-organization', 'POST /auth/login']);

/**
 * Suspended firms are read-only (L-12). Mounted on the firm router before every sub-router, so it
 * covers every route, including ones added later, by construction.
 */
export function blockWritesWhenSuspended(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE.has(req.method) || req.auth?.orgStatus !== 'suspended') return next();
  if (ALLOWED.has(`${req.method} ${req.path}`)) return next();
  next(new AppError(403, 'FIRM_SUSPENDED', 'This account is suspended, so changes can’t be saved. Contact LexForgeX.'));
}
```

In `app.ts`, add `api.use(blockWritesWhenSuspended);` immediately after `api.use(csrfProtection);`.

Note on order: CSRF runs first, so a forged cross-site write still gets `CSRF_INVALID`, not a hint about suspension. The sweep test sends a valid CSRF token.

- [ ] **Step 5: Worker** — in `apps/api/src/modules/notifications/context.ts`: add `orgStatus: OrganizationStatus;` to `ContextRaw`; select `status` in the org query and set `raw = { today: org.today, leadUserId: null, orgStatus: org.status }`. In `apps/api/src/modules/workflows/engine.ts` `executeScheduledAction`, right after `const context = await buildContext(...)`:

```ts
    // Suspended firms send nothing; due actions are recorded as skipped, never deferred (L-12).
    if (context.raw.orgStatus === 'suspended') return finish('skipped', { reason: 'Firm suspended' });
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @legalops/api exec vitest run test/suspension.test.ts`
Expected: PASS. Then the full API suite — existing tests must still pass (sessions for active firms are unaffected).

- [ ] **Step 7: Checkpoint** — typecheck, lint. Suggested message: `feat(platform): suspended firms are read-only in the API and worker`.

---

### Task 6: Platform console (web)

**Files:**
- Create: `apps/web/src/platform/api.ts`, `apps/web/src/platform/auth.ts`, `apps/web/src/platform/PlatformShell.tsx`, `apps/web/src/platform/PlatformLoginPage.tsx`, `apps/web/src/platform/FirmsPage.tsx`, `apps/web/src/platform/InviteFirmSheet.tsx`, `apps/web/src/platform/FirmDetailPage.tsx`, `apps/web/src/platform/AuditLogPage.tsx`, `apps/web/src/platform/PlatformApp.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: platform endpoints (Tasks 3–4); types `PlatformMe`, `PlatformFirmSummary`, `PlatformFirmDetail`, `PlatformAuditEntry`; validation `inviteFirmSchema`, `suspendFirmSchema`.
- Produces: routes `/platform/login`, `/platform` (→ `/platform/firms`), `/platform/firms`, `/platform/firms/:firmId`, `/platform/audit`, all lazy-loaded in one chunk.

- [ ] **Step 1: API client with its own CSRF** — `apps/web/src/platform/api.ts`:

```ts
import type { ApiErrorCode } from '@legalops/types';
import { ApiError, type PageMeta } from '../lib/api.js';

/** Separate from the firm client: different base path and CSRF token, never shared. */
let csrfToken: string | null = null;
export const setPlatformCsrf = (t: string | null) => {
  csrfToken = t;
};

async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ data: T; meta?: PageMeta }> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/platform${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'You appear to be offline.');
  }
  if (res.status === 204) return { data: undefined as T };
  const json = (await res.json().catch(() => null)) as { data?: T; meta?: PageMeta; error?: { code: ApiErrorCode; message: string; details?: [] } } | null;
  if (!res.ok || !json || json.error) {
    throw new ApiError(res.status, json?.error?.code ?? 'INTERNAL_ERROR', json?.error?.message ?? 'Something went wrong.', json?.error?.details ?? []);
  }
  return { data: json.data as T, ...(json.meta ? { meta: json.meta } : {}) };
}

export const platformApi = {
  get: async <T>(path: string) => (await call<T>('GET', path)).data,
  page: async <T>(path: string) => {
    const r = await call<T[]>('GET', path);
    return { items: r.data, meta: r.meta ?? { page: 1, pageSize: r.data.length, total: r.data.length } };
  },
  post: async <T>(path: string, body?: unknown) => (await call<T>('POST', path, body)).data,
  patch: async <T>(path: string, body?: unknown) => (await call<T>('PATCH', path, body)).data,
};
```

Export `PageMeta` from `apps/web/src/lib/api.ts` if it isn't already (it is declared `export type PageMeta`).

- [ ] **Step 2: Hooks** — `apps/web/src/platform/auth.ts`:

```ts
import type { PlatformMe } from '@legalops/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api.js';
import { platformApi, setPlatformCsrf } from './api.js';

export const PLATFORM_ME = ['platform', 'me'] as const;

export function usePlatformMe() {
  return useQuery({
    queryKey: PLATFORM_ME,
    queryFn: async () => {
      try {
        const me = await platformApi.get<PlatformMe>('/auth/me');
        setPlatformCsrf(me.csrfToken);
        return me;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setPlatformCsrf(null);
          return null;
        }
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

const useSetMe = () => {
  const qc = useQueryClient();
  return (me: PlatformMe | null) => {
    setPlatformCsrf(me?.csrfToken ?? null);
    qc.setQueryData(PLATFORM_ME, me);
  };
};

export function usePlatformLogin() {
  const setMe = useSetMe();
  return useMutation({ mutationFn: (b: { email: string; password: string }) => platformApi.post<PlatformMe>('/auth/login', b), onSuccess: setMe });
}
export function useStartEnrolment() {
  return useMutation({ mutationFn: () => platformApi.post<{ secret: string; otpauthUrl: string }>('/auth/totp/enroll') });
}
export function useVerifyCode() {
  const setMe = useSetMe();
  return useMutation({ mutationFn: (code: string) => platformApi.post<PlatformMe>('/auth/totp/verify', { code }), onSuccess: setMe });
}
export function usePlatformLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => platformApi.post<void>('/auth/logout'),
    onSettled: () => {
      setPlatformCsrf(null);
      qc.removeQueries({ queryKey: ['platform'] });
      qc.setQueryData(PLATFORM_ME, null);
    },
  });
}
```

- [ ] **Step 3: Login + TOTP page** — `apps/web/src/platform/PlatformLoginPage.tsx`:

```tsx
import { Alert, Button, TextField } from '@legalops/ui';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { ApiError } from '../lib/api.js';
import { usePlatformLogin, usePlatformMe, useStartEnrolment, useVerifyCode } from './auth.js';

export function PlatformLoginPage() {
  const { data: me } = usePlatformMe();
  const login = usePlatformLogin();
  const enrol = useStartEnrolment();
  const verify = useVerifyCode();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  if (me?.mfaVerified) return <Navigate to="/platform/firms" replace />;
  const error = [login.error, enrol.error, verify.error].find((e) => e instanceof ApiError) as ApiError | undefined;

  const onPassword = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: (m) => (!m.mfaEnrolled ? enrol.mutate() : undefined) });
  };
  const onCode = (e: FormEvent) => {
    e.preventDefault();
    verify.mutate(code.trim());
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-950 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">LexForgeX Platform</p>
        <h1 className="mt-1 text-xl font-semibold">{me ? 'Two-factor sign-in' : 'Sign in'}</h1>
        {error ? (
          <div className="mt-4">
            <Alert tone="danger">{error.message}</Alert>
          </div>
        ) : null}
        {!me ? (
          <form className="mt-4 space-y-4" onSubmit={onPassword}>
            <TextField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Button type="submit" className="w-full" disabled={login.isPending}>
              Continue
            </Button>
          </form>
        ) : (
          <form className="mt-4 space-y-4" onSubmit={onCode}>
            {!me.mfaEnrolled && enrol.data ? (
              <div className="space-y-2 rounded-lg border border-line p-3 text-sm">
                <p>Add LexForgeX Platform to your authenticator app with this key, then enter the code it shows.</p>
                <p className="font-mono text-base tracking-wider break-all select-all">{enrol.data.secret.match(/.{1,4}/g)?.join(' ')}</p>
                <a className="text-brand-700 underline" href={enrol.data.otpauthUrl}>
                  Open in authenticator app
                </a>
              </div>
            ) : (
              <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>
            )}
            <TextField label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
            <Button type="submit" className="w-full" disabled={verify.isPending || code.length !== 6}>
              Verify
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Shell and guard** — `apps/web/src/platform/PlatformShell.tsx`:

```tsx
import { Button, Spinner } from '@legalops/ui';
import { Suspense } from 'react';
import { Navigate, NavLink, Outlet, useNavigate } from 'react-router';
import { usePlatformLogout, usePlatformMe } from './auth.js';

const link = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-white/15 text-white' : 'text-slate-300 hover:text-white'}`;

/** Visually distinct from any firm workspace (dark header) so no admin mistakes one for the other. */
export function PlatformShell() {
  const { data: me, isPending } = usePlatformMe();
  const logout = usePlatformLogout();
  const navigate = useNavigate();
  if (isPending) return <div className="grid min-h-dvh place-items-center"><Spinner className="size-8" /></div>;
  if (!me?.mfaVerified) return <Navigate to="/platform/login" replace />;
  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="bg-slate-950 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <span className="font-semibold">LexForgeX Platform</span>
          <nav className="flex gap-1">
            <NavLink to="/platform/firms" className={link}>Firms</NavLink>
            <NavLink to="/platform/audit" className={link}>Audit log</NavLink>
          </nav>
          <span className="ml-auto hidden text-sm text-slate-400 sm:inline">{me.admin.email}</span>
          <Button size="sm" variant="secondary" onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/platform/login') })}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <Suspense fallback={<Spinner className="size-6" />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
```

(Check `Button` accepts `size="sm"`; the `Size` type in `Button.tsx` includes `'sm'`.)

- [ ] **Step 5: Firms list + invite sheet**

`apps/web/src/platform/InviteFirmSheet.tsx`:

```tsx
import type { PlatformFirmDetail } from '@legalops/types';
import { inviteFirmSchema } from '@legalops/validation';
import { Alert, Button, Sheet, TextField } from '@legalops/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../lib/api.js';
import { platformApi } from './api.js';

export function InviteFirmSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ firmName: '', partnerName: '', partnerEmail: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invite = useMutation({
    mutationFn: (body: typeof form) => platformApi.post<PlatformFirmDetail>('/firms', body),
    onSuccess: (firm) => {
      void qc.invalidateQueries({ queryKey: ['platform', 'firms'] });
      onClose();
      navigate(`/platform/firms/${firm.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const parsed = inviteFirmSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    invite.mutate(parsed.data);
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Sheet open={open} onClose={onClose} title="Invite a firm">
      <form className="space-y-4" onSubmit={submit}>
        {invite.error instanceof ApiError ? <Alert tone="danger">{invite.error.message}</Alert> : null}
        <TextField label="Firm name" value={form.firmName} onChange={set('firmName')} error={errors.firmName} />
        <TextField label="Managing partner’s name" value={form.partnerName} onChange={set('partnerName')} error={errors.partnerName} />
        <TextField label="Partner’s email" type="email" value={form.partnerEmail} onChange={set('partnerEmail')} error={errors.partnerEmail} />
        <p className="text-sm text-muted">They get a set-up link valid for 7 days. Only invite firms that have paid.</p>
        <Button type="submit" className="w-full" disabled={invite.isPending}>Send invitation</Button>
      </form>
    </Sheet>
  );
}
```

`apps/web/src/platform/FirmsPage.tsx`:

```tsx
import type { OrganizationStatus, PlatformFirmSummary } from '@legalops/types';
import { Badge, Button, EmptyState, PageHeader, SearchInput, SkeletonList, type Tone } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { qs } from '../lib/api.js';
import { platformApi } from './api.js';
import { InviteFirmSheet } from './InviteFirmSheet.js';

export const STATUS: Record<OrganizationStatus, { label: string; tone: Tone }> = {
  invited: { label: 'Invited', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  suspended: { label: 'Suspended', tone: 'danger' },
};
const when = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export function FirmsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<OrganizationStatus | ''>('');
  const [inviting, setInviting] = useState(false);
  const q = useQuery({
    queryKey: ['platform', 'firms', search, status],
    queryFn: () => platformApi.page<PlatformFirmSummary>(`/firms${qs({ search, status, pageSize: 100 })}`),
  });
  return (
    <>
      <PageHeader title="Firms" description="Every firm on LexForgeX." actions={<Button onClick={() => setInviting(true)}>Invite firm</Button>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <SearchInput className="min-w-0 flex-1" placeholder="Search firms" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="rounded-lg border border-line bg-surface px-3 text-sm" value={status} onChange={(e) => setStatus(e.target.value as OrganizationStatus | '')}>
          <option value="">All statuses</option>
          <option value="invited">Invited</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>
      {q.isPending ? (
        <SkeletonList rows={5} />
      ) : !q.data?.items.length ? (
        <EmptyState title="No firms yet" description="Invite a firm once their payment is settled." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted uppercase">
              <tr>
                <th className="px-4 py-2">Firm</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Owner</th>
                <th className="px-4 py-2 text-right">Users</th><th className="px-4 py-2 text-right">Cases</th><th className="px-4 py-2">Last active</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((f) => (
                <tr key={f.id} className="border-t border-line">
                  <td className="px-4 py-3"><Link className="font-medium text-brand-700 hover:underline" to={`/platform/firms/${f.id}`}>{f.name}</Link></td>
                  <td className="px-4 py-3"><Badge tone={STATUS[f.status].tone}>{STATUS[f.status].label}</Badge></td>
                  <td className="px-4 py-3">{f.ownerEmail ?? (f.inviteEmail ? <span className="text-muted">Invited: {f.inviteEmail}</span> : '—')}</td>
                  <td className="px-4 py-3 text-right">{f.userCount}</td>
                  <td className="px-4 py-3 text-right">{f.caseCount}</td>
                  <td className="px-4 py-3">{when(f.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <InviteFirmSheet open={inviting} onClose={() => setInviting(false)} />
    </>
  );
}
```

(Verify `Badge` takes `tone` and children; adjust the prop name only if it differs.)

- [ ] **Step 6: Firm detail** — `apps/web/src/platform/FirmDetailPage.tsx`:

```tsx
import type { PlatformFirmDetail } from '@legalops/types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, PageHeader, Sheet, SkeletonList, TextAreaField, TextField } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '../lib/api.js';
import { platformApi } from './api.js';
import { STATUS } from './FirmsPage.js';

const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function FirmDetailPage() {
  const { firmId = '' } = useParams();
  const qc = useQueryClient();
  const key = ['platform', 'firms', firmId];
  const q = useQuery({ queryKey: key, queryFn: () => platformApi.get<PlatformFirmDetail>(`/firms/${firmId}`) });
  const act = useMutation({
    mutationFn: ({ path, body, method = 'post' }: { path: string; body?: unknown; method?: 'post' | 'patch' }) =>
      platformApi[method]<PlatformFirmDetail>(`/firms/${firmId}${path}`, body),
    onSuccess: (firm) => {
      qc.setQueryData(key, firm);
      void qc.invalidateQueries({ queryKey: ['platform', 'firms'], exact: false });
    },
  });
  const [notes, setNotes] = useState<string | null>(null);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState('');
  const [reinvite, setReinvite] = useState(false);
  const [partner, setPartner] = useState({ partnerName: '', partnerEmail: '' });
  const timer = useRef<number>(undefined);

  useEffect(() => {
    if (q.data && notes === null) setNotes(q.data.platformNotes ?? '');
  }, [q.data, notes]);
  // Autosave notes 800 ms after typing stops.
  useEffect(() => {
    if (notes === null || !q.data || notes === (q.data.platformNotes ?? '')) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setSaved('saving');
      act.mutate({ path: '', method: 'patch', body: { platformNotes: notes || null } }, { onSuccess: () => setSaved('saved') });
    }, 800);
    return () => window.clearTimeout(timer.current);
  }, [notes]); // q.data/act are read at fire time; the equality guard above prevents save loops

  if (q.isPending) return <SkeletonList rows={4} />;
  if (!q.data) return <Alert tone="danger">Firm not found.</Alert>;
  const f = q.data;
  const inv = f.invitation;

  return (
    <>
      <Link to="/platform/firms" className="text-sm text-muted hover:underline">← Firms</Link>
      <PageHeader
        title={f.name}
        description={<Badge tone={STATUS[f.status].tone}>{STATUS[f.status].label}</Badge>}
        actions={
          f.status === 'active' ? (
            <Button variant="danger" onClick={() => setSuspending(true)}>Suspend</Button>
          ) : f.status === 'suspended' ? (
            <Button onClick={() => act.mutate({ path: '/reactivate' })} disabled={act.isPending}>Reactivate</Button>
          ) : null
        }
      />
      {act.error instanceof ApiError ? <div className="mb-4"><Alert tone="danger">{act.error.message}</Alert></div> : null}
      {f.status === 'suspended' ? (
        <div className="mb-4"><Alert tone="warning" title={`Suspended ${when(f.suspendedAt)}`}>{f.suspendedReason}</Alert></div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Notes" />
            <CardBody>
              <TextAreaField label="Payment and account notes (LexForgeX team only)" rows={5} value={notes ?? ''} onChange={(e) => setNotes(e.target.value)}
                hint={saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved' : 'Saves automatically. Never shown to the firm.'} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="History" />
            <CardBody>
              <ul className="space-y-2 text-sm">
                {f.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap justify-between gap-2">
                    <span><span className="font-medium">{h.action.replace('firm.', '').replace(/_/g, ' ')}</span>{typeof h.details.reason === 'string' ? ` — ${h.details.reason}` : ''}</span>
                    <span className="text-muted">{h.adminName} · {when(h.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Firm" />
            <CardBody className="space-y-1 text-sm">
              <p>Owner: {f.ownerEmail ?? '—'}</p><p>Users: {f.userCount}</p><p>Cases: {f.caseCount}</p>
              <p>Last active: {when(f.lastActivityAt)}</p><p>Created: {when(f.createdAt)}</p>
            </CardBody>
          </Card>
          {inv ? (
            <Card>
              <CardHeader title="Owner invitation" />
              <CardBody className="space-y-2 text-sm">
                <p>{inv.email}</p>
                <p className="text-muted">{inv.state === 'pending' ? `Expires ${when(inv.expiresAt)}` : inv.state}</p>
                {f.status === 'invited' ? (
                  <div className="flex flex-wrap gap-2">
                    {inv.state === 'pending' ? (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => act.mutate({ path: '/invitation/resend' })}>Resend</Button>
                        <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: '/invitation/revoke' })}>Revoke</Button>
                      </>
                    ) : null}
                    <Button size="sm" variant="secondary" onClick={() => setReinvite(true)}>Invite a different email</Button>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      <Sheet open={suspending} onClose={() => setSuspending(false)} title={`Suspend ${f.name}`}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); act.mutate({ path: '/suspend', body: { reason } }, { onSuccess: () => { setSuspending(false); setReason(''); } }); }}>
          <p className="text-sm">The firm keeps read-only access and can export its data. Nothing is deleted. Reminders and client emails stop until you reactivate.</p>
          <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
          <Button type="submit" variant="danger" className="w-full" disabled={!reason.trim() || act.isPending}>Suspend firm</Button>
        </form>
      </Sheet>
      <Sheet open={reinvite} onClose={() => setReinvite(false)} title="Invite a different email">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); act.mutate({ path: '/invitation', body: partner }, { onSuccess: () => setReinvite(false) }); }}>
          <TextField label="Partner’s name" value={partner.partnerName} onChange={(e) => setPartner((p) => ({ ...p, partnerName: e.target.value }))} required />
          <TextField label="Partner’s email" type="email" value={partner.partnerEmail} onChange={(e) => setPartner((p) => ({ ...p, partnerEmail: e.target.value }))} required />
          <Button type="submit" className="w-full" disabled={act.isPending}>Send invitation</Button>
        </form>
      </Sheet>
    </>
  );
}
```

- [ ] **Step 7: Audit log page** — `apps/web/src/platform/AuditLogPage.tsx`:

```tsx
import type { PlatformAuditEntry } from '@legalops/types';
import { EmptyState, PageHeader, SkeletonList } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { platformApi } from './api.js';

export function AuditLogPage() {
  const q = useQuery({ queryKey: ['platform', 'audit'], queryFn: () => platformApi.page<PlatformAuditEntry>('/audit-logs?pageSize=100') });
  return (
    <>
      <PageHeader title="Audit log" description="Every action taken in the platform console." />
      {q.isPending ? <SkeletonList rows={6} /> : !q.data?.items.length ? <EmptyState title="Nothing yet" /> : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
          {q.data.items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
              <span>
                <span className="font-medium">{a.action}</span>
                {a.organizationId ? <> · <Link className="text-brand-700 hover:underline" to={`/platform/firms/${a.organizationId}`}>{a.organizationName}</Link></> : null}
              </span>
              <span className="text-muted">{a.adminName} · {new Date(a.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
```

- [ ] **Step 8: Routes** — In `apps/web/src/App.tsx`, lazy-load them so firm users never download the console: add near the other lazy imports

```tsx
const PlatformApp = lazy(() => import('./platform/PlatformApp.js').then((m) => ({ default: m.PlatformApp })));
```

and create `apps/web/src/platform/PlatformApp.tsx`:

```tsx
import { Spinner } from '@legalops/ui';
import { Suspense } from 'react';
import { Route, Routes, Navigate } from 'react-router';
import { AuditLogPage } from './AuditLogPage.js';
import { FirmDetailPage } from './FirmDetailPage.js';
import { FirmsPage } from './FirmsPage.js';
import { PlatformLoginPage } from './PlatformLoginPage.js';
import { PlatformShell } from './PlatformShell.js';

/** The whole console in one lazy chunk, mounted at /platform/*. */
export function PlatformApp() {
  return (
    <Suspense fallback={<Spinner className="size-8" />}>
      <Routes>
        <Route path="login" element={<PlatformLoginPage />} />
        <Route element={<PlatformShell />}>
          <Route index element={<Navigate to="firms" replace />} />
          <Route path="firms" element={<FirmsPage />} />
          <Route path="firms/:firmId" element={<FirmDetailPage />} />
          <Route path="audit" element={<AuditLogPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
```

Then add as the **first** top-level entry of the `createBrowserRouter([...])` array: `{ path: '/platform/*', element: <PlatformApp /> },`. Links inside the console use absolute `/platform/...` paths, which work under the splat route.

- [ ] **Step 9: Typecheck and lint**

Run: `pnpm --filter @legalops/web typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 10: Browser verification** — create a dev admin (`pnpm --filter @legalops/api platform:create-admin -- --email ops@legalforgex.local --name "Ops"`, note the printed password), then in the preview:
  - `/platform/login`: password → enrolment key shown; add the key to an authenticator *or* compute a code in the terminal (`pnpm --filter @legalops/api exec tsx -e "import('./src/modules/platform/totp.ts').then(t=>console.log(t.totpCode('<KEY>', t.currentStep(Date.now()))))"`); verify → lands on Firms.
  - Invite firm "Verification Firm" → detail page shows Invited + pending invitation; Mailpit (`http://localhost:8025`) shows "Set up Verification Firm on LexForgeX".
  - Type notes → "Saved"; reload → notes persist.
  - On the seed firm "Sharma & Associates": Suspend with a reason → status Suspended + reason; History lists it; Reactivate.
  - Audit log lists all of the above.
  - Repeat the Firms list at 375 px width (table scrolls horizontally inside its card; page does not).
  - Screenshot login, firms list and firm detail.

- [ ] **Step 11: Checkpoint** — suggested message: `feat(web): LexForgeX platform console`.

---

### Task 7: Firm-side suspended experience (web)

**Files:**
- Modify: `apps/web/src/lib/auth.ts` (`useCan`)
- Create: `apps/web/src/components/layout/SuspendedBanner.tsx`
- Modify: `apps/web/src/components/layout/AppShell.tsx`

**Interfaces:**
- Consumes: `MeResponse.organization.status`, `allowedWhileSuspended` (types).

- [ ] **Step 1: Read-only permissions while suspended** — in `apps/web/src/lib/auth.ts`, import `allowedWhileSuspended` and replace `useCan`:

```ts
export function useCan(permission: Permission): boolean {
  const { data } = useMe();
  if (!data) return false;
  // A suspended firm keeps read access only; every permission-gated create/edit control disappears.
  if (data.organization.status === 'suspended' && !allowedWhileSuspended(permission)) return false;
  return can(data.role, permission);
}
```

- [ ] **Step 2: Banner** — `apps/web/src/components/layout/SuspendedBanner.tsx`:

```tsx
import { useMe } from '../../lib/auth.js';

export function SuspendedBanner() {
  const { data } = useMe();
  if (data?.organization.status !== 'suspended') return null;
  return (
    <div role="status" className="border-b border-warning-200 bg-warning-50 px-4 py-2 text-center text-sm text-warning-900">
      This account is suspended. You can view and export your records, but changes can’t be saved. Contact LexForgeX to reactivate.
    </div>
  );
}
```

(Check the Tailwind theme has `warning-*` tokens — `Alert`'s warning tone uses them; copy its exact classes from `packages/ui/src/Alert.tsx` if the names differ.)

In `AppShell.tsx`, render `<SuspendedBanner />` as the first child inside the main column, directly above the mobile `<header>` (so it shows on both desktop and mobile).

- [ ] **Step 3: Typecheck** — `pnpm --filter @legalops/web typecheck`. Expected: clean.

- [ ] **Step 4: Browser verification** — suspend "Sharma & Associates" from the console; as `partner@example.com`, reload: banner visible; Cases page has no "New case"/"Add" controls; a matter page shows no "Add hearing"/"Edit"; Billing has no "New invoice"; reading works. Reactivate; reload: controls return, banner gone. Screenshot both states (desktop + 375 px).

- [ ] **Step 5: Checkpoint** — suggested message: `feat(web): read-only experience for suspended firms`.

---

### Task 8: Docs and final verification

**Files:**
- Modify: `docs/decisions.md`, `README.md`, `.env.example`, `docs/superpowers/plans/2026-10-17-legalforgex-phase1-roadmap.md`

- [ ] **Step 1: D-014** — append to `docs/decisions.md`:

```markdown
## D-014 · Platform realm and firm suspension (2026-10-17)

- LexForgeX team members are `platform_admins`, a realm separate from firm users: own table, session table, cookie (`lf_psid`, path `/api/v1/platform`, SameSite=Strict), CSRF secret and router mounted before the firm router. Password + TOTP (RFC 6238, replay-guarded) on every sign-in; 30-minute idle and 12-hour absolute session limits. Admins are created or reset only by `pnpm --filter @legalops/api platform:create-admin`.
- Firms are created by a platform invite (`status = 'invited'`) and become `active` when the owner accepts. Payment is tracked manually in `platform_notes` (never exposed to firms; audit records only that notes changed).
- Suspended firms are read-only: one middleware on the firm router (before every sub-router, so new routes are covered by construction) returns `FIRM_SUSPENDED` for writes except logout/switch-organization; the worker records due actions as skipped ("Firm suspended") and never resends them. The web app hides non-read controls via `useCan` and shows a banner.
- TOTP enrolment shows the key and an `otpauth://` link; no QR image (deferred).
```

- [ ] **Step 2: README + env** — add to `README.md` a "Platform admins" section: how to create an admin, where to sign in (`/platform/login`), that TOTP is required, and how to reset (`--reset`). Add to `.env.example`: `# Required in production (≥32 chars): encrypts platform admins' TOTP secrets` and `PLATFORM_SECRET_KEY=`.

- [ ] **Step 3: Roadmap** — in the roadmap table set Track 1 Status to **Done (merged 2026-10-17)** and Track 2 to **Done** once this task's suite passes.

- [ ] **Step 4: Final verification**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean/green; `DB invariants: 27 passed`; API suite includes the new platform-auth, platform-firms and suspension files.

- [ ] **Step 5: Checkpoint** — suggested message: `docs: D-014 platform realm and suspension`.
