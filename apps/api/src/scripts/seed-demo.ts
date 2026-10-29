/**
 * Demo billing data (PRD §36: one paid, one partially paid, one overdue, one upcoming invoice), created
 * through the real services so ledger, timeline, outbox and audit stay consistent. Dev only.
 */
import {
  createInvoiceSchema,
  expenseSchema,
  feeAgreementSchema,
  recordPaymentSchema,
} from '@legalops/validation';
import { pino } from 'pino';
import { loadEnv } from '../config/env.js';
import { createPool, queryOne } from '../db/pool.js';
import { sql } from '../db/sql.js';
import type { Deps } from '../deps.js';
import type { RequestMeta, TenantContext } from '../http/context.js';
import { NoopCourtProvider } from '../integrations/courts/noop-provider.js';
import { DisabledDocumentStorage } from '../integrations/storage/s3-storage.js';
import { DisabledEmailProvider } from '../modules/notifications/providers.js';
import { createExpense } from '../modules/billing/expenses.service.js';
import { createFeeAgreement } from '../modules/billing/fee-agreements.service.js';
import { createInvoice } from '../modules/billing/invoices.service.js';
import { recordPayment } from '../modules/billing/payments.service.js';

const env = loadEnv();
if (env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
const pool = createPool(env.DATABASE_URL);
const deps: Deps = { pool, env, log: pino({ level: 'silent' }), courts: new NoopCourtProvider(), email: new DisabledEmailProvider(), storage: new DisabledDocumentStorage() };
const meta: RequestMeta = { requestId: 'seed-demo', ip: null, userAgent: 'seed' };

try {
  const org = await queryOne<{ id: string; owner: string; today: string }>(
    pool,
    sql`SELECT o.id, m.user_id AS owner, ((now() AT TIME ZONE o.timezone)::date)::text AS today
        FROM organizations o JOIN organization_members m ON m.organization_id = o.id AND m.role = 'owner'
        WHERE o.name = 'Sharma & Associates' LIMIT 1`,
  );
  if (!org) throw new Error('Run the base seed first');
  const ctx: TenantContext = { organizationId: org.id, userId: org.owner, role: 'owner' };
  const day = async (offset: number) =>
    (await queryOne<{ d: string }>(pool, sql`SELECT (${org.today}::date + ${offset}::int)::text AS d`))!.d;
  const matter = async (title: string) =>
    (await queryOne<{ id: string; client_id: string }>(
      pool,
      sql`SELECT id, client_id FROM matters WHERE organization_id = ${org.id} AND title = ${title}`,
    ))!;

  const sharma = await matter('Sharma v ABC');
  const abc = await matter('ABC Contract Dispute');
  const verma = await matter('Verma Property Matter');

  // Fee agreement with milestones on the ABC matter; the retainer gets invoiced and paid.
  const fa = await createFeeAgreement(
    deps,
    ctx,
    feeAgreementSchema.parse({
      matterId: abc.id,
      agreementType: 'milestone',
      description: 'Arbitration petition: fixed fee in three stages',
      agreedAmount: '150000.00',
      taxIncluded: false,
      milestones: [
        { name: 'Retainer', amount: '50000.00', dueDate: await day(-30) },
        { name: 'Filing of petition', amount: '50000.00', dueDate: await day(20) },
        { name: 'Final arguments', amount: '50000.00', dueDate: null },
      ],
    }),
    meta,
  );

  const issue = (
    matterId: string,
    issueDate: string,
    dueDate: string,
    items: {
      description: string;
      unitPrice: string;
      feeMilestoneId?: string;
      expenseId?: string;
      isPureAgent?: boolean;
    }[],
  ) =>
    createInvoice(
      deps,
      ctx,
      createInvoiceSchema.parse({ matterId, issueDate, dueDate, issue: true, items }),
      meta,
    );

  // 1. Paid
  const paid = await issue(abc.id, await day(-30), await day(-15), [
    {
      description: 'Retainer: arbitration petition',
      unitPrice: '50000.00',
      feeMilestoneId: fa.milestones[0]!.id,
    },
  ]);
  await recordPayment(
    deps,
    ctx,
    recordPaymentSchema.parse({
      clientId: abc.client_id,
      amount: '45000.00',
      tdsAmount: '5000.00',
      paymentDate: await day(-18),
      method: 'bank_transfer',
      referenceNumber: 'NEFT/ABC/0921',
      allocations: [{ invoiceId: paid.id, amount: '50000.00' }],
      keepRemainderAsAdvance: false,
    }),
    meta,
  );

  // 2. Partially paid (court fee billed as a pure-agent reimbursement)
  const courtFee = await createExpense(
    deps,
    ctx,
    expenseSchema.parse({
      matterId: sharma.id,
      category: 'Court fees',
      amount: '2500.00',
      expenseDate: await day(-12),
      description: 'Court fee stamps on plaint',
      billableToClient: true,
      reimbursable: true,
    }),
    meta,
  );
  const partial = await issue(sharma.id, await day(-10), await day(5), [
    { description: 'Drafting and filing of suit', unitPrice: '40000.00' },
    {
      description: 'Court fees (reimbursement)',
      unitPrice: '2500.00',
      expenseId: courtFee.id,
      isPureAgent: true,
    },
  ]);
  await recordPayment(
    deps,
    ctx,
    recordPaymentSchema.parse({
      clientId: sharma.client_id,
      amount: '15000.00',
      tdsAmount: '0',
      paymentDate: await day(-3),
      method: 'upi',
      referenceNumber: 'UPI/4471',
      allocations: [{ invoiceId: partial.id, amount: '15000.00' }],
      keepRemainderAsAdvance: false,
    }),
    meta,
  );

  // 3. Overdue
  await issue(verma.id, await day(-45), await day(-20), [
    { description: 'Title search and legal opinion', unitPrice: '25000.00' },
  ]);

  // 4. Upcoming
  await issue(sharma.id, org.today, await day(12), [
    { description: 'Appearance: arguments', unitPrice: '30000.00' },
  ]);

  // Unbilled expense for the matter billing tab.
  await createExpense(
    deps,
    ctx,
    expenseSchema.parse({
      matterId: sharma.id,
      category: 'Certified copies',
      amount: '640.00',
      expenseDate: await day(-1),
      description: 'Certified copy of order',
      billableToClient: true,
      reimbursable: true,
    }),
    meta,
  );

  console.log(
    'seeded demo billing: 4 invoices (paid, partial, overdue, upcoming), 2 payments, fee agreement, expenses',
  );
} finally {
  await pool.end();
}
