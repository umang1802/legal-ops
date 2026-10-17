import type { CourtDataProvider, RefreshResult } from './court-provider.js';

/** V1 default: no court integration. Reports honestly instead of pretending to sync. */
export class NoopCourtProvider implements CourtDataProvider {
  readonly name = 'none';
  async refreshCase(): Promise<RefreshResult> {
    return { status: 'not_configured' };
  }
}
