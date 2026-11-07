import { describe, expect, it } from 'vitest';
import { addDays, buildApp, loginAs, pool, practiceFixture, type Session, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const patch = (s: Session, path: string, body: object) =>
  s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);

async function setup() {
  const fx = await practiceFixture(app);
  const fin = await loginAs(app, 'finance@a.test');
  const clientId = (await pool.query(`SELECT client_id FROM matters WHERE id = $1`, [fx.main.matterId]))
    .rows[0].client_id as string;
  const body = (extra: Record<string, unknown> = {}) => ({
    matterId: fx.main.matterId,
    items: [{ description: 'Professional fees', unitPrice: '30000' }],
    ...extra,
  });
  const sched = (a: string[], dates: string[]) => a.map((amount, i) => ({ amount, dueDate: dates[i]! }));
  const pay = (invoiceId: string, amount: string, today: string, extra: object = {}) =>
    post(fin, '/payments', {
      clientId,
      amount,
      paymentDate: today,
      method: 'upi',
      allocations: [{ invoiceId, amount }],
      ...extra,
    });
  return { ...fx, fin, clientId, body, sched, pay };
}

describe('billing parity: instalments', () => {
  it('draft with 3 instalments summing to total saves; due_date = last', async () => {
    const { fin, today, body, sched } = await setup();
    const dates = [addDays(today, 10), addDays(today, 20), addDays(today, 30)];
    const res = await post(fin, '/invoices', body({ instalments: sched(['10000', '10000', '10000'], dates) }));
    expect(res.status).toBe(201);
    expect(res.body.data.dueDate).toBe(dates[2]);
    expect(res.body.data.instalments).toHaveLength(3);
    expect(res.body.data.instalments.map((i: { seq: number }) => i.seq)).toEqual([1, 2, 3]);
    expect(res.body.data.instalments[0]).toMatchObject({ amount: '10000.00', status: 'due', paid: '0.00', activeLink: null });
  });

  it('instalments not summing to total → 422 at instalments', async () => {
    const { fin, today, body, sched } = await setup();
    const dates = [addDays(today, 10), addDays(today, 20)];
    const res = await post(fin, '/invoices', body({ instalments: sched(['10000', '10000'], dates) }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toContain('instalments');
    expect((await pool.query(`SELECT count(*)::int n FROM invoices`)).rows[0].n).toBe(0);
  });

  it('partial payment of 1.5 instalments → [paid, part_paid, due]', async () => {
    const { fin, today, body, sched, pay } = await setup();
    const dates = [addDays(today, 10), addDays(today, 20), addDays(today, 30)];
    const inv = (
      await post(fin, '/invoices', body({ issue: true, instalments: sched(['10000', '10000', '10000'], dates) }))
    ).body.data;
    expect((await pay(inv.id, '15000', today)).status).toBe(201);
    const got = (await fin.agent.get(`/api/v1/invoices/${inv.id}`)).body.data;
    expect(got.instalments.map((i: { status: string }) => i.status)).toEqual(['paid', 'part_paid', 'due']);
    expect(got.instalments[1]).toMatchObject({ paid: '5000.00', remaining: '5000.00' });
  });

  it('TDS allocations count towards instalments', async () => {
    const { fin, today, body, sched } = await setup();
    const dates = [addDays(today, 10), addDays(today, 20)];
    const inv = (await post(fin, '/invoices', body({ issue: true, instalments: sched(['15000', '15000'], dates) })))
      .body.data;
    // 13500 received + 1500 TDS, allocated 15000 in total
    const res = await post(fin, '/payments', {
      clientId: (await pool.query(`SELECT client_id FROM invoices WHERE id = $1`, [inv.id])).rows[0].client_id,
      amount: '13500',
      tdsAmount: '1500',
      paymentDate: today,
      method: 'cheque',
      allocations: [{ invoiceId: inv.id, amount: '15000' }],
    });
    expect(res.status).toBe(201);
    const got = (await fin.agent.get(`/api/v1/invoices/${inv.id}`)).body.data;
    expect(got.instalments.map((i: { status: string }) => i.status)).toEqual(['paid', 'due']);
  });

  it('instalment past due and unpaid → overdue; part-paid past due → overdue', async () => {
    const { fin, today, body, sched, pay } = await setup();
    const dates = [addDays(today, -5), addDays(today, -1), addDays(today, 30)];
    const inv = (
      await post(fin, '/invoices', body({ issue: true, instalments: sched(['10000', '10000', '10000'], dates) }))
    ).body.data;
    expect(inv.instalments.map((i: { status: string }) => i.status)).toEqual(['overdue', 'overdue', 'due']);
    await pay(inv.id, '12000', today);
    const got = (await fin.agent.get(`/api/v1/invoices/${inv.id}`)).body.data;
    expect(got.instalments.map((i: { status: string }) => i.status)).toEqual(['paid', 'overdue', 'due']);
  });

  it('invoice without instalments → instalments: []', async () => {
    const { fin, body } = await setup();
    const res = await post(fin, '/invoices', body({ issue: true }));
    expect(res.status).toBe(201);
    expect(res.body.data.instalments).toEqual([]);
  });

  it('updating a draft without the instalments key keeps the schedule', async () => {
    const { fin, today, body, sched } = await setup();
    const dates = [addDays(today, 10), addDays(today, 20)];
    const inv = (await post(fin, '/invoices', body({ instalments: sched(['15000', '15000'], dates) }))).body.data;
    const upd = await patch(fin, `/invoices/${inv.id}`, {
      notes: 'unrelated edit',
      items: [{ description: 'Professional fees', unitPrice: '30000' }],
    });
    expect(upd.status).toBe(200);
    expect(upd.body.data.instalments).toHaveLength(2);
    expect(upd.body.data.dueDate).toBe(dates[1]);
  });

  it('updating with [] clears the schedule; 2–24 replaces it', async () => {
    const { fin, today, body, sched } = await setup();
    const dates = [addDays(today, 10), addDays(today, 20)];
    const inv = (await post(fin, '/invoices', body({ instalments: sched(['15000', '15000'], dates) }))).body.data;
    const items = [{ description: 'Professional fees', unitPrice: '30000' }];
    const rep = await patch(fin, `/invoices/${inv.id}`, {
      items,
      instalments: sched(['10000', '20000'], [addDays(today, 5), addDays(today, 6)]),
    });
    expect(rep.status).toBe(200);
    expect(rep.body.data.instalments.map((i: { amount: string }) => i.amount)).toEqual(['10000.00', '20000.00']);
    const cleared = await patch(fin, `/invoices/${inv.id}`, { items, instalments: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.instalments).toEqual([]);
  });

  it('issue re-checks the sum', async () => {
    const { fin, today, body, sched } = await setup();
    const dates = [addDays(today, 10), addDays(today, 20)];
    const inv = (await post(fin, '/invoices', body({ instalments: sched(['15000', '15000'], dates) }))).body.data;
    const upd = await patch(fin, `/invoices/${inv.id}`, {
      items: [{ description: 'Professional fees', unitPrice: '40000' }],
    });
    expect(upd.status).toBe(200);
    const issued = await post(fin, `/invoices/${inv.id}/issue`);
    expect(issued.status).toBe(422);
    expect(JSON.stringify(issued.body.error.details)).toContain('instalments');
    expect((await pool.query(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).rows[0].status).toBe('draft');
  });
});
