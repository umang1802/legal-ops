// Per-worker env for the API under test. Uses a dedicated database, never the dev one.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://legalops:legalops@localhost:5433/legalops_test';
process.env.SESSION_SECRET = 'test-secret-0123456789-0123456789-abcdef';
process.env.APP_URL = 'http://localhost:5173';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.LOG_LEVEL = 'silent';
