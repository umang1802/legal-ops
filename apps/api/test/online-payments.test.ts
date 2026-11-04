import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signZohoWebhook } from '../src/integrations/zohopay/signature.js';
import { buildApp, loginAs, pool, practiceFixture, type Session, useDatabase } from './helpers.js';
import { createPlatformAdmin, platformLogin, type PlatformSession } from './platform-helpers.js';

useDatabase();
const app = buildApp();
const P = '/api/v1/platform';

const ACCOUNT = '105078477';
const SIGNING_KEY = 'whsec-test-signing-key-0123456789abcdef';
const SECRETS = {
  clientSecret: 'client-secret-value-123',
  refreshToken: '1000.refresh.token-value-456',
  signingKey: SIGNING_KEY,
};

const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const platformPatch = (s: PlatformSession, path: string, body: object) =>
  s.agent.patch(`${P}${path}`).set('X-CSRF-Token', s.csrf).send(body);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Stands in for Zoho: token exchange, create link, cancel link. Records what was asked of it. */
function fakeZoho() {
  const calls: { url: string; method: string; body: Record<string, unknown> | null; auth: string | null }[] =
    [];
  let n = 0;
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === 'string' && headers.get('content-type') === 'application/json'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    calls.push({ url, method, body, auth: headers.get('authorization') });
    if (url.includes('accounts.zoho.in/oauth/v2/token'))
      return json({ access_token: 'access-token-xyz', expires_in: 3600 });
    if (url.includes('/paymentlinks') && url.includes('/cancel'))
      return json({ code: 0, message: 'Payment link Cancelled' });
    if (url.includes('/paymentlinks') && method === 'POST') {
      n += 1;
      return json(
        {
          code: 0,
          message: 'Payment link created successfully',
          payment_links: {
            payment_link_id: `PL${n}`,
            url: `https://payments.zoho.in/paymentlinks/token${n}`,
            amount: Number(body!.amount).toFixed(2),
            currency: 'INR',
            status: 'active',
            expires_at: body!.expires_at,
          },
        },
        201,
      );
    }
    return json({ code: 1, message: 'unexpected call' }, 404);
  });
  return { impl, calls };
}

let zoho: ReturnType<typeof fakeZoho>;
beforeEach(() => {
  zoho = fakeZoho();
  vi.stubGlobal('fetch', zoho.impl);
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const fx = await practiceFixture(app);
  const { secret } = await createPlatformAdmin('ops@lfx.test');
  const ops = await platformLogin(app, 'ops@lfx.test', secret);
  const fin = await loginAs(app, 'finance@a.test');
  const clientId = (await pool.query(`SELECT client_id FROM matters WHERE id = $1`, [fx.main.matterId]))
    .rows[0].client_id as string;
  const invoice = async (amount = '5000') => {
    const res = await post(fin, '/invoices', {
      matterId: fx.main.matterId,
      items: [{ description: 'Professional fees', unitPrice: amount }],
      issue: true,
    });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.data as { id: string };
  };
  const configure = (extra: object = {}) =>
    platformPatch(ops, `/firms/${fx.firm.orgId}/zohopay`, {
      environment: 'sandbox',
      accountId: ACCOUNT,
      clientId: '1000.CLIENTIDEXAMPLE',
      ...SECRETS,
      enabled: true,
      ...extra,
    });
  const webhook = (body: string, header?: string) =>
    request(app)
      .post(`/api/v1/webhooks/zohopay/${fx.firm.orgId}`)
      .set('Content-Type', 'application/json')
      .set('X-Zoho-Webhook-Signature', header ?? signZohoWebhook(body, SIGNING_KEY))
      .send(body);
  return { ...fx, ops, fin, clientId, invoice, configure, webhook };
}

const paidEvent = (linkId: string, amount: string, eventId = 1001) =>
  JSON.stringify({
    event_id: eventId,
    event_type: 'payment_link.paid',
    account_id: Number(ACCOUNT),
    live_mode: false,
    event_time: Date.now(),
    event_object: {
      payment_links: {
        payment_link_id: linkId,
        amount_paid: amount,
        status: 'paid',
        payments: [
          {
            payment_id: 'ZP-1',
            type: 'upi',
            status: 'succeeded',
            amount,
            date: Math.floor(Date.now() / 1000),
          },
        ],
      },
    },
  });

describe('platform: Zoho Pay settings', () => {
  it('saves credentials encrypted, never returns them, and audits without values', async () => {
    const { ops, firm, configure } = await setup();
    const res = await configure();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      configured: true,
      enabled: true,
      environment: 'sandbox',
      accountId: ACCOUNT,
      hasClientSecret: true,
      hasRefreshToken: true,
      hasSigningKey: true,
    });
    const text = JSON.stringify(res.body);
    for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
    expect(res.body.data.webhookUrl).toContain(`/api/v1/webhooks/zohopay/${firm.orgId}`);

    const row = (
      await pool.query(
        `SELECT client_secret_enc, refresh_token_enc, signing_key_enc FROM organization_payment_gateways WHERE organization_id = $1`,
        [firm.orgId],
      )
    ).rows[0];
    for (const v of Object.values(SECRETS)) expect(JSON.stringify(row)).not.toContain(v);
    const audit = JSON.stringify(
      (await pool.query(`SELECT details FROM platform_audit_logs WHERE action LIKE 'firm.zohopay%'`)).rows,
    );
    for (const v of Object.values(SECRETS)) expect(audit).not.toContain(v);
    expect((await ops.agent.get(`${P}/firms/${firm.orgId}/zohopay`)).body.data.hasSigningKey).toBe(true);
  });

  it('needs the full set on first save, and the signing key before it can be turned on', async () => {
    const { ops, firm, configure } = await setup();
    const partial = await platformPatch(ops, `/firms/${firm.orgId}/zohopay`, { accountId: ACCOUNT });
    expect(partial.status).toBe(422);
    const noKey = await configure({ signingKey: undefined });
    expect(noKey.status).toBe(422);
    expect(JSON.stringify(noKey.body)).toContain('signing key');
    expect((await configure({ enabled: false, signingKey: undefined })).status).toBe(200);
  });

  it('an update that leaves a secret out keeps the stored one', async () => {
    const { ops, firm, configure } = await setup();
    await configure();
    const res = await platformPatch(ops, `/firms/${firm.orgId}/zohopay`, { environment: 'live' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      environment: 'live',
      hasClientSecret: true,
      hasSigningKey: true,
      lastTestOk: null,
    });
  });

  it('test connection signs in to Zoho and records the result', async () => {
    const { ops, firm, configure } = await setup();
    await configure();
    const res = await ops.agent
      .post(`${P}/firms/${firm.orgId}/zohopay/test`)
      .set('X-CSRF-Token', ops.csrf)
      .send({});
    expect(res.body.data).toMatchObject({ lastTestOk: true });
    const token = zoho.calls.find((c) => c.url.includes('/oauth/v2/token'));
    expect(token).toBeTruthy();
  });

  it('a firm user cannot reach the platform settings', async () => {
    const { firm, fin } = await setup();
    const res = await fin.agent.get(`${P}/firms/${firm.orgId}/zohopay`);
    expect(res.status).toBe(401);
  });
});

describe('payment links and the Zoho webhook', () => {
  it('creates a link for the amount due, once, against the sandbox host', async () => {
    const { fin, invoice, configure } = await setup();
    await configure();
    const inv = await invoice('5000');
    const res = await post(fin, `/invoices/${inv.id}/payment-links`, {});
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      amount: '5000.00',
      status: 'active',
      url: 'https://payments.zoho.in/paymentlinks/token1',
      environment: 'sandbox',
    });
    const create = zoho.calls.find((c) => c.method === 'POST' && c.url.includes('/paymentlinks'))!;
    expect(create.url).toContain('paymentssandbox.zoho.in/api/v1/paymentlinks?account_id=' + ACCOUNT);
    expect(create.auth).toBe('Zoho-oauthtoken access-token-xyz');
    expect(create.body).toMatchObject({
      amount: 5000,
      currency: 'INR',
      notify_customer: { email: false, sms: false },
    });
    expect(String(create.body!.reference_id)).toMatch(/^[0-9a-f]{32}$/);

    const again = await post(fin, `/invoices/${inv.id}/payment-links`, {});
    expect(again.status).toBe(409);
  });

  it('refuses when online payments are off, and for more than is due', async () => {
    const { fin, invoice, configure } = await setup();
    const inv = await invoice('5000');
    expect((await post(fin, `/invoices/${inv.id}/payment-links`, {})).status).toBe(409);
    await configure();
    expect((await post(fin, `/invoices/${inv.id}/payment-links`, { amount: '6000' })).status).toBe(422);
    const partial = await post(fin, `/invoices/${inv.id}/payment-links`, { amount: '1500.50' });
    expect(partial.body.data.amount).toBe('1500.50');
  });

  it('a signed payment_link.paid records the receipt, settles the invoice, and a replay does nothing', async () => {
    const { fin, invoice, configure, webhook } = await setup();
    await configure();
    const inv = await invoice('5000');
    const link = (await post(fin, `/invoices/${inv.id}/payment-links`, {})).body.data;

    const body = paidEvent('PL1', '5000.00');
    const res = await webhook(body);
    expect(res.status).toBe(200);

    const after = (await fin.agent.get(`/api/v1/invoices/${inv.id}`)).body.data;
    expect(after).toMatchObject({ displayStatus: 'paid', amountDue: '0.00' });
    const pays = (await pool.query(`SELECT payment_method, reference_number, amount::text FROM payments`))
      .rows;
    expect(pays).toEqual([{ payment_method: 'upi', reference_number: 'ZP-1', amount: '5000.00' }]);
    const links = (await fin.agent.get(`/api/v1/invoices/${inv.id}/payment-links`)).body.data;
    expect(links.links[0]).toMatchObject({ id: link.id, status: 'paid' });
    expect(links.links[0].receiptNumber).toBeTruthy();

    const replay = await webhook(body);
    expect(replay.status).toBe(200);
    expect(replay.body.message).toBe('Duplicate event');
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments`)).rows[0].n).toBe(1);
  });

  it('refuses an unsigned or wrongly signed webhook and records nothing', async () => {
    const { fin, invoice, configure, webhook } = await setup();
    await configure();
    const inv = await invoice('5000');
    await post(fin, `/invoices/${inv.id}/payment-links`, {});
    const body = paidEvent('PL1', '5000.00');
    expect((await webhook(body, 't=1,v=' + 'a'.repeat(64))).status).toBe(401);
    expect((await webhook(body, signZohoWebhook(body, 'some-other-key'))).status).toBe(401);
    expect((await webhook(body.replace('5000.00', '1.00'), signZohoWebhook(body, SIGNING_KEY))).status).toBe(
      401,
    );
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM payment_gateway_events`)).rows[0].n).toBe(0);
  });

  it('keeps money that arrives after the invoice was already settled, as an advance', async () => {
    const { fin, invoice, configure, webhook, clientId, today } = await setup();
    await configure();
    const inv = await invoice('5000');
    await post(fin, `/invoices/${inv.id}/payment-links`, {});
    const manual = await post(fin, '/payments', {
      clientId,
      amount: '5000',
      paymentDate: today,
      method: 'cash',
      allocations: [{ invoiceId: inv.id, amount: '5000' }],
    });
    expect(manual.status).toBe(201);

    const res = await webhook(paidEvent('PL1', '5000.00'));
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('kept as advance');
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments`)).rows[0].n).toBe(2);
  });

  it('expired and canceled events update the link, and a firm can cancel its own link', async () => {
    const { fin, invoice, configure, webhook } = await setup();
    await configure();
    const inv = await invoice('5000');
    const link = (await post(fin, `/invoices/${inv.id}/payment-links`, {})).body.data;
    const expired = JSON.stringify({
      event_id: 2002,
      event_type: 'payment_link.expired',
      account_id: Number(ACCOUNT),
      live_mode: false,
      event_object: { payment_links: { payment_link_id: 'PL1', status: 'expired' } },
    });
    expect((await webhook(expired)).status).toBe(200);
    expect((await fin.agent.get(`/api/v1/invoices/${inv.id}/payment-links`)).body.data.links[0].status).toBe(
      'expired',
    );

    const next = (await post(fin, `/invoices/${inv.id}/payment-links`, {})).body.data;
    expect(next.id).not.toBe(link.id);
    const cancel = await post(fin, `/invoices/${inv.id}/payment-links/${next.id}/cancel`, {});
    expect(cancel.body.data.status).toBe('canceled');
    expect(zoho.calls.some((c) => c.method === 'PUT' && c.url.includes('/PL2/cancel'))).toBe(true);
  });

  it('ignores events for another Zoho account or environment', async () => {
    const { fin, invoice, configure, webhook } = await setup();
    await configure();
    const inv = await invoice('5000');
    await post(fin, `/invoices/${inv.id}/payment-links`, {});
    const wrongAccount = paidEvent('PL1', '5000.00').replace(ACCOUNT, '999999');
    expect((await webhook(wrongAccount)).body.message).toContain('account mismatch');
    const live = paidEvent('PL1', '5000.00', 3003).replace('"live_mode":false', '"live_mode":true');
    expect((await webhook(live)).body.message).toContain('environment mismatch');
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments`)).rows[0].n).toBe(0);
  });
});
