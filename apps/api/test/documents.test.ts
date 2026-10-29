import { DOCUMENT_PART_BYTES, MAX_DOCUMENT_BYTES } from '@legalops/types';
import { describe, expect, it } from 'vitest';
import { buildApp, loginAs, pool, practiceFixture, type Session, storage, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) => s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const del = (s: Session, path: string) => s.agent.delete(`/api/v1${path}`).set('X-CSRF-Token', s.csrf);

/** Start an upload, pretend the browser sent `uploadSize` bytes, complete it. */
async function upload(s: Session, body: Record<string, unknown>, uploadSize = body.sizeBytes as number) {
  const start = await post(s, '/documents/uploads', body);
  if (start.status !== 201) return { start, done: null };
  storage.simulateBrowserUpload(uploadSize);
  const parts = start.body.data.partUrls.map((_: string, i: number) => ({ partNumber: i + 1, etag: `"etag-${i + 1}"` }));
  const done = await post(s, `/documents/${start.body.data.documentId}/complete`, { parts });
  return { start, done };
}

describe('documents', () => {
  it('uploads in 16 MiB parts, then lists the document on its matter, with a timeline entry', async () => {
    const { main } = await practiceFixture(app);
    const clerk = await loginAs(app, 'clerk@a.test');
    const size = 40 * 1024 * 1024;
    const { start, done } = await upload(clerk, { matterId: main.matterId, category: 'pleadings', name: 'Plaint.pdf', sizeBytes: size });
    expect(start.status).toBe(201);
    expect(start.body.data.partSize).toBe(DOCUMENT_PART_BYTES);
    expect(start.body.data.partUrls).toHaveLength(3);
    expect(done!.status).toBe(200);
    expect(done!.body.data).toMatchObject({ name: 'Plaint.pdf', category: 'pleadings', mimeType: 'application/pdf', sizeBytes: size, status: 'available', uploadedBy: { firstName: 'clerk' } });

    const list = await clerk.agent.get('/api/v1/documents').query({ matterId: main.matterId });
    expect(list.body.data.map((d: { name: string }) => d.name)).toEqual(['Plaint.pdf']);
    const tl = await pool.query(`SELECT title FROM timeline_events WHERE matter_id = $1 AND event_type = 'document.uploaded'`, [main.matterId]);
    expect(tl.rows[0].title).toBe('Document added: Plaint.pdf');
  });

  it('a document still uploading isn’t listed; abort marks it failed', async () => {
    const { owner, main } = await practiceFixture(app);
    const start = await post(owner, '/documents/uploads', { matterId: main.matterId, name: 'Big.pdf', sizeBytes: 1000 });
    expect((await owner.agent.get('/api/v1/documents').query({ matterId: main.matterId })).body.data).toEqual([]);
    expect((await post(owner, `/documents/${start.body.data.documentId}/abort`)).status).toBe(204);
    expect(storage.uploads.get(storage.lastUploadId!)!.aborted).toBe(true);
    const row = (await pool.query(`SELECT status FROM documents WHERE id = $1`, [start.body.data.documentId])).rows[0];
    expect(row.status).toBe('failed');
  });

  it('rejects disallowed types and files over 500 MB before any upload starts', async () => {
    const { owner, main } = await practiceFixture(app);
    const exe = await post(owner, '/documents/uploads', { matterId: main.matterId, name: 'setup.exe', sizeBytes: 10 });
    expect(exe.status).toBe(422);
    expect(JSON.stringify(exe.body)).toMatch(/isn’t allowed/);
    expect((await post(owner, '/documents/uploads', { matterId: main.matterId, name: 'huge.pdf', sizeBytes: MAX_DOCUMENT_BYTES + 1 })).status).toBe(422);
    expect((await post(owner, '/documents/uploads', { matterId: main.matterId, name: 'noext', sizeBytes: 10 })).status).toBe(422);
  });

  it('a file whose stored size doesn’t match what was declared is deleted and marked failed', async () => {
    const { owner, main } = await practiceFixture(app);
    const { start, done } = await upload(owner, { matterId: main.matterId, name: 'a.pdf', sizeBytes: 1000 }, 9_000_000);
    expect(done!.status).toBe(422);
    expect(storage.removed).toHaveLength(1);
    const row = (await pool.query(`SELECT status FROM documents WHERE id = $1`, [start.body.data.documentId])).rows[0];
    expect(row.status).toBe('failed');
  });

  it('only the uploader can complete their upload', async () => {
    const { owner, main } = await practiceFixture(app);
    const start = await post(owner, '/documents/uploads', { matterId: main.matterId, name: 'a.pdf', sizeBytes: 10 });
    storage.simulateBrowserUpload(10);
    const l1 = await loginAs(app, 'l1@a.test');
    expect((await post(l1, `/documents/${start.body.data.documentId}/complete`, { parts: [{ partNumber: 1, etag: '"x"' }] })).status).toBe(404);
  });

  it('attaches an order to a hearing (case filled in from the hearing); refuses a hearing from another matter', async () => {
    const { owner, main, privateMatter, today } = await practiceFixture(app);
    const h = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: today });
    const { done } = await upload(owner, { matterId: main.matterId, hearingId: h.body.data.id, category: 'orders', name: 'Order.pdf', sizeBytes: 500 });
    expect(done!.body.data).toMatchObject({ hearingId: h.body.data.id, caseId: main.caseId, hearingDate: today, category: 'orders' });
    expect((await owner.agent.get('/api/v1/documents').query({ hearingId: h.body.data.id })).body.data).toHaveLength(1);

    const wrong = await post(owner, '/documents/uploads', { matterId: privateMatter.matterId, hearingId: h.body.data.id, name: 'x.pdf', sizeBytes: 5 });
    expect(wrong.status).toBe(422);
    const privCase = (await pool.query(`SELECT id FROM cases WHERE matter_id = $1`, [privateMatter.matterId])).rows[0].id;
    expect((await post(owner, '/documents/uploads', { matterId: main.matterId, caseId: privCase, name: 'x.pdf', sizeBytes: 5 })).status).toBe(422);
  });

  it('visibility follows the matter; finance can view and download but not upload', async () => {
    const { owner, main } = await practiceFixture(app);
    const { done } = await upload(owner, { matterId: main.matterId, name: 'Evidence.jpg', category: 'evidence', sizeBytes: 2048 });
    const id = done!.body.data.id;

    const l2 = await loginAs(app, 'l2@a.test'); // lawyer, not on this matter
    expect((await post(l2, '/documents/uploads', { matterId: main.matterId, name: 'x.pdf', sizeBytes: 5 })).status).toBe(404);
    expect((await l2.agent.get('/api/v1/documents').query({ matterId: main.matterId })).status).toBe(404);
    expect((await l2.agent.get(`/api/v1/documents/${id}/download`)).status).toBe(404);

    const fin = await loginAs(app, 'finance@a.test');
    expect((await fin.agent.get('/api/v1/documents').query({ matterId: main.matterId })).body.data).toHaveLength(1);
    const dl = await fin.agent.get(`/api/v1/documents/${id}/download`).query({ inline: '1' });
    expect(dl.status).toBe(200);
    expect(dl.body.data.url).toMatch(/inline=true&name=Evidence\.jpg$/);
    expect(dl.headers['cache-control']).toBe('no-store');
    expect((await post(fin, '/documents/uploads', { matterId: main.matterId, name: 'x.pdf', sizeBytes: 5 })).status).toBe(403);
    const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'document.downloaded' AND entity_id = $1`, [id]);
    expect(audit.rowCount).toBe(1);
  });

  it('only the uploader or an owner/admin can delete; owners can restore', async () => {
    const { owner, main } = await practiceFixture(app);
    const clerk = await loginAs(app, 'clerk@a.test');
    const { done } = await upload(clerk, { matterId: main.matterId, name: 'Notes.docx', sizeBytes: 300 });
    const id = done!.body.data.id;
    const l1 = await loginAs(app, 'l1@a.test');
    expect((await del(l1, `/documents/${id}`)).status).toBe(403);
    expect((await del(owner, `/documents/${id}`)).status).toBe(204);
    expect((await owner.agent.get('/api/v1/documents').query({ matterId: main.matterId })).body.data).toEqual([]);
    const withDeleted = await owner.agent.get('/api/v1/documents').query({ matterId: main.matterId, includeDeleted: 'true' });
    expect(withDeleted.body.data[0]).toMatchObject({ status: 'deleted' });
    expect((await post(clerk, `/documents/${id}/restore`)).status).toBe(403);
    expect((await post(owner, `/documents/${id}/restore`)).status).toBe(200);
    expect((await owner.agent.get('/api/v1/documents').query({ matterId: main.matterId })).body.data).toHaveLength(1);
    expect(storage.removed).toEqual([]); // soft delete never removes the file
  });

  it('filters by category and searches file names', async () => {
    const { owner, main } = await practiceFixture(app);
    await upload(owner, { matterId: main.matterId, name: 'Written statement.pdf', category: 'pleadings', sizeBytes: 10 });
    await upload(owner, { matterId: main.matterId, name: 'Interim order 12 Oct.pdf', category: 'orders', sizeBytes: 10 });
    const q = (query: Record<string, string>) => owner.agent.get('/api/v1/documents').query({ matterId: main.matterId, ...query });
    expect((await q({ category: 'orders' })).body.data.map((d: { name: string }) => d.name)).toEqual(['Interim order 12 Oct.pdf']);
    expect((await q({ search: 'statement' })).body.data.map((d: { name: string }) => d.name)).toEqual(['Written statement.pdf']);
    expect((await q({ search: '100%' })).body.data).toEqual([]);
  });
});
