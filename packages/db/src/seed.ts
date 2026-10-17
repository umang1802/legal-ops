import { hash } from '@node-rs/argon2';
import type pg from 'pg';

/**
 * Development seed (PRD §36). Phase 1 creates the firm, its users and a second firm used to
 * demonstrate tenant isolation. Later phases extend this with clients, matters, hearings and invoices.
 * Dev-only password: see README. Never run against production.
 */
export const SEED_PASSWORD = 'LegalOps!dev2026';

export const SEED_USERS = [
  { email: 'partner@example.com', firstName: 'Anil', lastName: 'Sharma', role: 'owner' },
  { email: 'lawyer@example.com', firstName: 'Meera', lastName: 'Iyer', role: 'lawyer' },
  { email: 'clerk@example.com', firstName: 'Ravi', lastName: 'Kumar', role: 'staff' },
  { email: 'finance@example.com', firstName: 'Pooja', lastName: 'Nair', role: 'finance' },
] as const;

export async function seed(client: pg.Client, log: (msg: string) => void = () => {}): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed production');
  const passwordHash = await hash(SEED_PASSWORD);

  await client.query('BEGIN');
  try {
    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, legal_name, email, phone, city, state, state_code)
       VALUES ('Sharma & Associates', 'Sharma & Associates LLP', 'office@sharma.example.com',
               '+91 11 4000 0000', 'New Delhi', 'Delhi', '07')
       RETURNING id`,
    );
    const orgId = org.rows[0]!.id;

    const userIds: Record<string, string> = {};
    for (const u of SEED_USERS) {
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name, email_verified_at)
         VALUES ($1, $2, $3, $4, now()) RETURNING id`,
        [u.email, passwordHash, u.firstName, u.lastName],
      );
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role, joined_at) VALUES ($1, $2, $3, now())`,
        [orgId, user.rows[0]!.id, u.role],
      );
      userIds[u.email] = user.rows[0]!.id;
    }

    await seedPracticeData(client, orgId, userIds);

    const other = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, city, state) VALUES ('Verma Legal Chambers', 'Mumbai', 'Maharashtra') RETURNING id`,
    );
    const otherUser = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, first_name, email_verified_at)
       VALUES ('other-partner@example.com', $1, 'Kiran', now()) RETURNING id`,
      [passwordHash],
    );
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', now())`,
      [other.rows[0]!.id, otherUser.rows[0]!.id],
    );

    await client.query('COMMIT');
    log(`seeded Sharma & Associates (${SEED_USERS.length} users) + Verma Legal Chambers`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** PRD §36 demo data. Verma Property Matter is partner-only, to demonstrate assigned-only visibility. */
async function seedPracticeData(
  client: pg.Client,
  orgId: string,
  users: Record<string, string>,
): Promise<void> {
  const partner = users['partner@example.com']!;
  const lawyer = users['lawyer@example.com']!;
  const clerk = users['clerk@example.com']!;

  const insertClient = async (c: {
    type: string;
    name: string;
    email: string;
    phone: string;
    e164: string;
    city: string;
  }) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO clients (organization_id, client_type, name, email, phone, phone_e164, city, state, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Delhi', $8) RETURNING id`,
        [orgId, c.type, c.name, c.email, c.phone, c.e164, c.city, partner],
      )
    ).rows[0]!.id;
  const raj = await insertClient({
    type: 'person',
    name: 'Raj Sharma',
    email: 'raj.sharma@example.com',
    phone: '98100 12345',
    e164: '+919810012345',
    city: 'New Delhi',
  });
  const abc = await insertClient({
    type: 'company',
    name: 'ABC Industries Pvt Ltd',
    email: 'legal@abc-industries.example.com',
    phone: '011 4155 0000',
    e164: '+911141550000',
    city: 'Gurugram',
  });
  const priya = await insertClient({
    type: 'person',
    name: 'Priya Verma',
    email: 'priya.verma@example.com',
    phone: '98110 67890',
    e164: '+919811067890',
    city: 'Noida',
  });

  const court = async (name: string) =>
    (
      await client.query<{ id: string }>(
        `SELECT id FROM courts WHERE name = $1 AND organization_id IS NULL`,
        [name],
      )
    ).rows[0]!.id;
  const saket = (
    await client.query<{ id: string }>(
      `INSERT INTO courts (organization_id, name, court_type, city, state)
       VALUES ($1, 'Saket District Court', 'District Court', 'New Delhi', 'Delhi') RETURNING id`,
      [orgId],
    )
  ).rows[0]!.id;

  type MatterSeed = {
    clientId: string;
    title: string;
    ref: string;
    area: string;
    priority: string;
    staff: [string, string][];
    caseSeed: { title: string; number: string; cnr: string | null; courtId: string; type: string };
    parties: [string, string, boolean][];
  };
  const matters: MatterSeed[] = [
    {
      clientId: raj,
      title: 'Sharma v ABC',
      ref: 'SA-2026-001',
      area: 'Civil',
      priority: 'high',
      staff: [
        [lawyer, 'lead'],
        [clerk, 'support'],
      ],
      caseSeed: {
        title: 'Raj Sharma v ABC Industries Pvt Ltd',
        number: 'CS(OS) 412/2026',
        cnr: 'DLHC010004122026',
        courtId: await court('Delhi High Court'),
        type: 'Civil Suit',
      },
      parties: [
        ['Raj Sharma', 'plaintiff', true],
        ['ABC Industries Pvt Ltd', 'defendant', false],
      ],
    },
    {
      clientId: abc,
      title: 'ABC Contract Dispute',
      ref: 'SA-2026-002',
      area: 'Commercial',
      priority: 'normal',
      staff: [
        [partner, 'lead'],
        [lawyer, 'associate'],
      ],
      caseSeed: {
        title: 'ABC Industries v Zenith Logistics',
        number: 'ARB.P. 88/2026',
        cnr: 'DLHC010000882026',
        courtId: await court('Delhi High Court'),
        type: 'Arbitration Petition',
      },
      parties: [
        ['ABC Industries Pvt Ltd', 'petitioner', true],
        ['Zenith Logistics Ltd', 'respondent', false],
      ],
    },
    {
      clientId: priya,
      title: 'Verma Property Matter',
      ref: 'SA-2026-003',
      area: 'Property',
      priority: 'normal',
      staff: [[partner, 'lead']],
      caseSeed: {
        title: 'Priya Verma v State & Ors',
        number: 'CS 1187/2026',
        cnr: null,
        courtId: saket,
        type: 'Civil Suit',
      },
      parties: [
        ['Priya Verma', 'plaintiff', true],
        ['Municipal Corporation of Delhi', 'defendant', false],
      ],
    },
  ];

  const caseIds: string[] = [];
  const matterIds: string[] = [];
  for (const m of matters) {
    const matterId = (
      await client.query<{ id: string }>(
        `INSERT INTO matters (organization_id, client_id, title, reference_code, practice_area, priority, start_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, current_date - 45, $7) RETURNING id`,
        [orgId, m.clientId, m.title, m.ref, m.area, m.priority, partner],
      )
    ).rows[0]!.id;
    for (const [userId, role] of m.staff) {
      await client.query(
        `INSERT INTO matter_staff (organization_id, matter_id, user_id, role) VALUES ($1, $2, $3, $4)`,
        [orgId, matterId, userId, role],
      );
    }
    const caseId = (
      await client.query<{ id: string }>(
        `INSERT INTO cases (organization_id, matter_id, court_id, title, case_number, cnr, case_type, filing_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, current_date - 40, $8) RETURNING id`,
        [
          orgId,
          matterId,
          m.caseSeed.courtId,
          m.caseSeed.title,
          m.caseSeed.number,
          m.caseSeed.cnr,
          m.caseSeed.type,
          partner,
        ],
      )
    ).rows[0]!.id;
    caseIds.push(caseId);
    matterIds.push(matterId);
    for (const [name, side, isClient] of m.parties) {
      await client.query(
        `INSERT INTO case_parties (organization_id, case_id, name, side, is_client) VALUES ($1, $2, $3, $4, $5)`,
        [orgId, caseId, name, side, isClient],
      );
    }
    await client.query(
      `INSERT INTO timeline_events (organization_id, matter_id, client_id, event_type, title, actor_user_id, created_at)
       VALUES ($1, $2, $3, 'matter.created', 'Matter opened', $4, now() - interval '45 days'),
              ($1, $2, $3, 'case.created', $5, $4, now() - interval '40 days')`,
      [orgId, matterId, m.clientId, partner, `Case added: ${m.caseSeed.number}`],
    );
  }

  // Hearings + tasks relative to the firm's local today (PRD §36: today, tomorrow, overdue, upcoming).
  const today = `((now() AT TIME ZONE 'Asia/Kolkata')::date)`;
  const [sharmaCase, abcCase, vermaCase] = caseIds as [string, string, string];
  const [sharmaMatter, abcMatter] = matterIds as [string, string];
  const hearing = async (caseId: string, offset: number, time: string | null, room: string, type: string) =>
    client.query(
      `INSERT INTO hearings (organization_id, case_id, scheduled_date, start_time, courtroom, hearing_type, created_by)
       VALUES ($1, $2, ${today} + $3::int, $4::time, $5, $6, $7)`,
      [orgId, caseId, offset, time, room, type, partner],
    );
  await hearing(sharmaCase, 0, '10:30', '12', 'Arguments'); // today
  await hearing(abcCase, 1, '11:00', '4', 'Admission'); // tomorrow
  await hearing(vermaCase, 0, '14:15', '305', 'Evidence'); // today, partner-only matter
  await hearing(abcCase, -2, '10:00', '4', 'Mention'); // past, outcome not recorded yet
  await client.query(
    `UPDATE cases cs SET next_hearing_date = (SELECT min(h.scheduled_date) FROM hearings h
       WHERE h.case_id = cs.id AND h.status = 'scheduled' AND h.scheduled_date >= ${today})
     WHERE cs.organization_id = $1`,
    [orgId],
  );
  const task = async (
    matterId: string,
    title: string,
    assignee: string,
    dueOffset: number,
    priority = 'normal',
  ) =>
    client.query(
      `INSERT INTO tasks (organization_id, matter_id, title, assignee_id, created_by, priority, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, ((${today} + $7::int) + time '23:59') AT TIME ZONE 'Asia/Kolkata')`,
      [orgId, matterId, title, assignee, partner, priority, dueOffset],
    );
  await task(sharmaMatter, 'File rejoinder to written statement', lawyer, -2, 'high'); // overdue
  await task(sharmaMatter, 'Prepare arguments note for today', lawyer, 0, 'urgent'); // due today
  await task(abcMatter, 'Collect certified copy of order', clerk, 3); // upcoming
  await task(abcMatter, 'Brief counsel on admission points', lawyer, 1);
}
