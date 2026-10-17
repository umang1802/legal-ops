import { migrate, resetSchema } from '@legalops/db';
import pg from 'pg';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://legalops:legalops@localhost:5433/legalops_test';

export default async function setup(): Promise<void> {
  const url = new URL(TEST_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test'))
    throw new Error(`Refusing to run tests against non-test database "${dbName}"`);

  const admin = new pg.Client({
    connectionString: Object.assign(new URL(TEST_URL), { pathname: '/postgres' }).toString(),
  });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const client = new pg.Client({ connectionString: TEST_URL });
  await client.connect();
  await resetSchema(client);
  await migrate(client);
  await client.end();
}
