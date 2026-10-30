import { createServer } from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DisabledDocumentStorage } from '../src/integrations/storage/s3-storage.js';
import type { EmailMessage, EmailProvider } from '../src/modules/notifications/providers.js';
import { tick } from '../src/modules/workflows/processor.js';
import { buildApp, createFirm, deps, loginAs, pool, practiceFixture, type Session, storage, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 1)]);
const JPG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(200, 2)]);
const post = (s: Session, path: string, body: object = {}) => s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
/** Where the browser's signed PUT lands: a staging key the public route can never reach. */
const stagingKey = (orgId: string, logoId: string) => `incoming/logos/${orgId}/${logoId}`;

/** Start → (the browser's PUT to the staging key) → complete. */
async function upload(s: Session, orgId: string, contentType: string, bytes: Buffer, declaredSize = bytes.length) {
  const start = await post(s, '/organization/logo/uploads', { contentType, sizeBytes: declaredSize });
  if (start.status !== 201) return { start, done: null, key: null };
  const key = stagingKey(orgId, start.body.data.logoId);
  storage.putDirect(key, bytes);
  const done = await post(s, `/organization/logo/${start.body.data.logoId}/complete`);
  return { start, done, key };
}

describe('firm logo', () => {
  it('a firm without a logo has logoUrl null in its organization and in /auth/me', async () => {
    const { owner } = await practiceFixture(app);
    expect((await owner.agent.get('/api/v1/organization')).body.data.logoUrl).toBeNull();
    expect((await owner.agent.get('/api/v1/auth/me')).body.data.organization.logoUrl).toBeNull();
  });

  it('the owner uploads a PNG; it shows in organization and /auth/me, and is audited', async () => {
    const { owner, firm } = await practiceFixture(app);
    const { start, done } = await upload(owner, firm.orgId, 'image/png', PNG);
    expect(start.status).toBe(201);
    expect(start.headers['cache-control']).toBe('no-store');
    expect(start.body.data).toMatchObject({ uploadUrl: expect.any(String), expiresInSeconds: 300 });
    const url = `/api/v1/public/logos/${firm.orgId}/${start.body.data.logoId}.png`;
    expect(done!.status).toBe(200);
    expect(done!.body.data.logoUrl).toBe(url);
    expect((await owner.agent.get('/api/v1/auth/me')).body.data.organization.logoUrl).toBe(url);
    const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'organization.logo_updated' AND organization_id = $1`, [firm.orgId]);
    expect(audit.rowCount).toBe(1);
  });

  it('the public route serves the logo without a session, with long-lived caching', async () => {
    const { owner, firm } = await practiceFixture(app);
    const { done } = await upload(owner, firm.orgId, 'image/png', PNG);
    const res = await request(app).get(done!.body.data.logoUrl).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses a file that isn’t a PNG or JPG whatever it was declared as, deletes it, and keeps the old logo', async () => {
    const { owner, firm } = await practiceFixture(app);
    const first = await upload(owner, firm.orgId, 'image/png', PNG);
    const before = first.done!.body.data.logoUrl;
    for (const bytes of [Buffer.from('%PDF-1.4 not an image'), Buffer.from('<html><script>alert(1)</script></html>')]) {
      const { done, key } = await upload(owner, firm.orgId, 'image/png', bytes);
      expect(done!.status).toBe(422);
      expect(JSON.stringify(done!.body)).toMatch(/That file isn’t a PNG or JPG/);
      expect(storage.removed).toContain(key);
    }
    expect((await owner.agent.get('/api/v1/organization')).body.data.logoUrl).toBe(before);
  });

  it('the file’s real type wins over the declared one (a JPG named .png is a JPG)', async () => {
    const { owner, firm } = await practiceFixture(app);
    const { done } = await upload(owner, firm.orgId, 'image/png', JPG);
    expect(done!.status).toBe(200);
    expect(done!.body.data.logoUrl).toMatch(/\.jpg$/);
    expect((await request(app).get(done!.body.data.logoUrl)).headers['content-type']).toBe('image/jpeg');
  });

  it('the server writes the checked logo itself: re-using the upload link afterwards changes nothing', async () => {
    const { owner, firm } = await practiceFixture(app);
    const { start, done, key } = await upload(owner, firm.orgId, 'image/png', PNG);
    const url = done!.body.data.logoUrl as string;
    expect(storage.data.has(key!)).toBe(false); // staging copy removed once checked
    storage.putDirect(key!, Buffer.from('<html>replaced after the check</html>')); // same signed link, PUT again
    const again = await post(owner, `/organization/logo/${start.body.data.logoId}/complete`);
    expect(again.status).toBe(409); // that upload was already used
    const served = await request(app).get(url).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(Buffer.compare(served.body as Buffer, PNG)).toBe(0);
  });

  it('refuses logos over 1 MB, both declared and actual', async () => {
    const { owner, firm } = await practiceFixture(app);
    const declared = await post(owner, '/organization/logo/uploads', { contentType: 'image/png', sizeBytes: 1048577 });
    expect(declared.status).toBe(422);
    expect(JSON.stringify(declared.body)).toMatch(/up to 1 MB/);
    const big = Buffer.concat([PNG, Buffer.alloc(1048577 - PNG.length)]);
    const { done, key } = await upload(owner, firm.orgId, 'image/png', big, 1000);
    expect(done!.status).toBe(422);
    expect(JSON.stringify(done!.body)).toMatch(/up to 1 MB/);
    expect(storage.removed).toContain(key);
  });

  it('the public route never serves another firm’s file, other keys or other types', async () => {
    const { owner, firm } = await practiceFixture(app);
    const { start } = await upload(owner, firm.orgId, 'image/png', PNG);
    const logoId = start.body.data.logoId as string;
    const other = await createFirm('Firm B', []);
    const get = (path: string) => request(app).get(`/api/v1/public/logos/${path}`);
    expect((await get(`${other.orgId}/${logoId}.png`)).status).toBe(404);
    expect((await get(`${firm.orgId}/..%2F..%2Fsecret.png`)).status).toBe(404);
    expect((await get(`${firm.orgId}/${logoId}.gif`)).status).toBe(404);
    expect((await get(`${firm.orgId}/00000000-0000-4000-8000-000000000000.png`)).status).toBe(404);
    expect((await get(`not-a-uuid/${logoId}.png`)).status).toBe(404);
  });

  it('an upload that is started but never completed changes nothing', async () => {
    const { owner } = await practiceFixture(app);
    expect((await post(owner, '/organization/logo/uploads', { contentType: 'image/png', sizeBytes: PNG.length })).status).toBe(201);
    expect((await owner.agent.get('/api/v1/organization')).body.data.logoUrl).toBeNull();
  });

  it('replacing a logo keeps the old file serving, so sent emails keep theirs', async () => {
    const { owner, firm } = await practiceFixture(app);
    const a = (await upload(owner, firm.orgId, 'image/png', PNG)).done!.body.data.logoUrl as string;
    const b = (await upload(owner, firm.orgId, 'image/jpeg', JPG)).done!.body.data.logoUrl as string;
    expect(b).toMatch(/\.jpg$/);
    expect((await request(app).get(a)).status).toBe(200);
    expect((await request(app).get(b)).headers['content-type']).toBe('image/jpeg');
  });

  it('removing the logo clears it, is audited, and keeps the file', async () => {
    const { owner, firm } = await practiceFixture(app);
    const url = (await upload(owner, firm.orgId, 'image/png', PNG)).done!.body.data.logoUrl as string;
    const res = await owner.agent.delete('/api/v1/organization/logo').set('X-CSRF-Token', owner.csrf);
    expect(res.status).toBe(200);
    expect(res.body.data.logoUrl).toBeNull();
    const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'organization.logo_removed' AND organization_id = $1`, [firm.orgId]);
    expect(audit.rowCount).toBe(1);
    expect((await request(app).get(url)).status).toBe(200);
  });

  it('only owners and admins of an active firm can change the logo', async () => {
    const { firm } = await practiceFixture(app);
    const lawyer = await loginAs(app, 'l1@a.test');
    expect((await post(lawyer, '/organization/logo/uploads', { contentType: 'image/png', sizeBytes: 10 })).status).toBe(403);
    expect((await lawyer.agent.delete('/api/v1/organization/logo').set('X-CSRF-Token', lawyer.csrf)).status).toBe(403);
    await pool.query(`UPDATE organizations SET status = 'suspended', suspended_at = now() WHERE id = $1`, [firm.orgId]);
    const owner = await loginAs(app, 'owner@a.test');
    const res = await post(owner, '/organization/logo/uploads', { contentType: 'image/png', sizeBytes: 10 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FIRM_SUSPENDED');
  });

  it('a server without document storage answers 503 to an upload', async () => {
    const server = createServer(createApp({ ...deps, storage: new DisabledDocumentStorage() }, {})).listen(0);
    try {
      await practiceFixture(app);
      const owner = await loginAs(server, 'owner@a.test');
      const res = await post(owner, '/organization/logo/uploads', { contentType: 'image/png', sizeBytes: 10 });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('NOT_CONFIGURED');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('firm logo in client emails', () => {
  it('emails carry the firm’s logo (absolute URL) and “Powered by LexForgeX”', async () => {
    const { owner, firm, main, uid } = await practiceFixture(app);
    const url = (await upload(owner, firm.orgId, 'image/png', PNG)).done!.body.data.logoUrl as string;
    await post(owner, '/tasks', { title: 'File vakalatnama', matterId: main.matterId, assigneeId: uid('l1@a.test') });
    const sent: EmailMessage[] = [];
    const capture: EmailProvider = { name: 'capture', send: async (m) => (sent.push(m), { providerMessageId: `cap-${sent.length}` }) };
    await tick({ ...deps, email: capture }, new Date());
    const html = sent.find((m) => m.to === 'l1@a.test')!.html;
    expect(html).toContain(`<img src="${deps.env.APP_URL.replace(/\/$/, '')}${url}"`);
    expect(html).toContain('Powered by LexForgeX');
  });
});

describe('firm logo: the public route serves only checked logos', () => {
  it('a file uploaded to the signed URL but never completed is not served, whatever it contains', async () => {
    const { owner, firm } = await practiceFixture(app);
    for (const bytes of [PNG, Buffer.from('<html><script>alert(1)</script></html>')]) {
      const start = await post(owner, '/organization/logo/uploads', { contentType: 'image/png', sizeBytes: bytes.length });
      const logoId = start.body.data.logoId as string;
      storage.putDirect(`org/${firm.orgId}/branding/${logoId}.png`, bytes);
      expect((await request(app).get(`/api/v1/public/logos/${firm.orgId}/${logoId}.png`)).status).toBe(404);
    }
  });

  it('a checked logo is served only under its own firm and its own type', async () => {
    const { owner, firm } = await practiceFixture(app);
    const { start } = await upload(owner, firm.orgId, 'image/png', PNG);
    const logoId = start.body.data.logoId as string;
    // Same bytes planted under the .jpg name: the checked logo is a PNG, so this isn't served.
    storage.putDirect(`org/${firm.orgId}/branding/${logoId}.jpg`, JPG);
    expect((await request(app).get(`/api/v1/public/logos/${firm.orgId}/${logoId}.jpg`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/public/logos/${firm.orgId}/${logoId}.png`)).status).toBe(200);
  });
});
