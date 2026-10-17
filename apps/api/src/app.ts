import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Deps } from './deps.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestId } from './middleware/request-context.js';
import { csrfProtection, requireJson } from './middleware/security.js';
import { authRouter, sessionLoader, type RateLimits } from './modules/auth/auth.routes.js';
import {
  billingRouter,
  expensesRouter,
  feeAgreementsRouter,
  feeMilestonesRouter,
  invoicesRouter,
  paymentsRouter,
} from './modules/billing/billing.routes.js';
import { casesRouter } from './modules/cases/cases.routes.js';
import { clientsRouter } from './modules/clients/clients.routes.js';
import { courtsRouter } from './modules/courts/courts.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { hearingsRouter } from './modules/hearings/hearings.routes.js';
import { mattersRouter } from './modules/matters/matters.routes.js';
import { searchRouter } from './modules/search/search.routes.js';
import { tasksRouter } from './modules/tasks/tasks.routes.js';
import { devRouter } from './modules/dev/dev.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { templatesRouter } from './modules/templates/templates.routes.js';
import { workflowsRouter } from './modules/workflows/workflows.routes.js';
import { organizationRouter } from './modules/organizations/organizations.routes.js';

const DEFAULT_LIMITS: RateLimits = { loginPerWindow: 10, resetPerWindow: 5, windowMs: 15 * 60_000 };

export function createApp(deps: Deps, opts: { rateLimits?: Partial<RateLimits> } = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.env.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.log,
      genReqId: (req) => (req as express.Request).requestId,
      customProps: (req) => ({ requestId: (req as express.Request).requestId }),
      // Never log credentials, cookies or session/CSRF tokens (PRD §31).
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
      ],
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || deps.env.CORS_ALLOWED_ORIGINS.includes(origin)),
      credentials: true,
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/health', healthRouter(deps));

  const api = express.Router();
  api.use(requireJson);
  api.use(sessionLoader(deps));
  api.use(csrfProtection);
  api.use('/auth', authRouter(deps, { ...DEFAULT_LIMITS, ...opts.rateLimits }));
  api.use('/organization', organizationRouter(deps));
  api.use('/clients', clientsRouter(deps));
  api.use('/matters', mattersRouter(deps));
  api.use('/cases', casesRouter(deps));
  api.use('/courts', courtsRouter(deps));
  api.use('/search', searchRouter(deps));
  api.use('/hearings', hearingsRouter(deps));
  api.use('/tasks', tasksRouter(deps));
  api.use('/dashboard', dashboardRouter(deps));
  api.use('/invoices', invoicesRouter(deps));
  api.use('/payments', paymentsRouter(deps));
  api.use('/expenses', expensesRouter(deps));
  api.use('/fee-agreements', feeAgreementsRouter(deps));
  api.use('/fee-milestones', feeMilestonesRouter(deps));
  api.use('/billing', billingRouter(deps));
  api.use('/notifications', notificationsRouter(deps));
  api.use('/email-templates', templatesRouter(deps));
  api.use('/workflows', workflowsRouter(deps));
  if (deps.env.NODE_ENV !== 'production') api.use('/dev', devRouter(deps));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
