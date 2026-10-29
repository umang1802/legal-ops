import type pg from 'pg';
import type { Logger } from 'pino';
import type { Env } from './config/env.js';
import type { CourtDataProvider } from './integrations/courts/court-provider.js';
import type { DocumentStorage } from './integrations/storage/document-storage.js';
import type { EmailProvider } from './modules/notifications/providers.js';

export type Deps = { pool: pg.Pool; env: Env; log: Logger; courts: CourtDataProvider; email: EmailProvider; storage: DocumentStorage };
