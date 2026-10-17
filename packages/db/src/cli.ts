import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { MIGRATIONS_DIR, migrate, resetSchema } from './migrate.js';
import { seed } from './seed.js';

const command = process.argv[2];
const url = process.env.DATABASE_URL ?? 'postgres://legalops:legalops@localhost:5433/legalops';
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  switch (command) {
    case 'migrate':
      await migrate(client, console.log);
      console.log('migrations up to date');
      break;
    case 'reset':
      await resetSchema(client);
      await migrate(client, console.log);
      await seed(client, console.log);
      break;
    case 'seed':
      await seed(client, console.log);
      break;
    case 'invariants': {
      const sql = await readFile(path.resolve(MIGRATIONS_DIR, '../tests/invariants.sql'), 'utf8');
      const notices: string[] = [];
      client.on('notice', (n) => notices.push(n.message ?? ''));
      await client.query(sql);
      const passed = notices.filter((n) => n.startsWith('PASS')).length;
      console.log(`DB invariants: ${passed} passed`);
      break;
    }
    default:
      console.error('usage: cli.ts migrate|reset|seed|invariants');
      process.exitCode = 1;
  }
} finally {
  await client.end();
}
