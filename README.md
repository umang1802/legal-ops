# LegalOps

Mobile-first practice operations for Indian litigation firms: cases, hearings, tasks, client email, billing and collections.

**Status:** Phase 1 started. The decisions are recorded in [docs/decisions.md](docs/decisions.md), and the corrected schema is in `packages/db/migrations/0001_init.sql` (verified by `packages/db/tests/invariants.sql`).

## Read first

- [docs/prd/legalops_v1_prd.md](docs/prd/legalops_v1_prd.md): the full product spec
- [docs/prd/legalops_v1_coding_agent_prompt.md](docs/prd/legalops_v1_coding_agent_prompt.md): build instructions
- [docs/prd/legalops_v1_schema.sql](docs/prd/legalops_v1_schema.sql): original schema (**superseded** once `packages/db/migrations` lands)
- [docs/gap-analysis.md](docs/gap-analysis.md): spec gaps and the open decisions that block the Phase 1 schema

## Layout

```
apps/web        React + Vite + Tailwind (mobile-first PWA)
apps/api        Node/TS HTTP API (/api/v1)
apps/worker     Outbox relay, scheduler, BullMQ workers
packages/db     SQL migrations, seed, query helpers
packages/types  Shared enums/DTO types
packages/validation  Zod schemas shared by API + web
packages/ui     Design-system primitives
infra/          Deployment
```

## Local dependencies

```bash
cp .env.example .env
pnpm dev:deps   # Postgres :5433, Redis :6380, MinIO :9000 (console :9001)
```

Ports are offset from defaults so they don't collide with the EduForgeX stack.

## Database

```bash
docker compose exec -T postgres psql -U legalops -d legalops -v ON_ERROR_STOP=1 < packages/db/migrations/0001_init.sql
docker compose exec -T postgres psql -U legalops -d legalops -v ON_ERROR_STOP=1 < packages/db/tests/invariants.sql
```
