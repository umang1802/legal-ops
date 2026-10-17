/**
 * Court data adapter (PRD §44). External court data is evidence/source data, never automatically
 * firm-authoritative. Every result carries provider + external id + fetched-at.
 */
export type CaseIdentifier = { cnr: string | null; caseNumber: string | null; courtName: string | null };

export type RefreshResult =
  | { status: 'not_configured' }
  | { status: 'unavailable'; reason: string }
  | {
      status: 'ok';
      provider: string;
      externalId: string;
      fetchedAt: Date;
      data: Record<string, unknown>;
    };

export interface CourtDataProvider {
  readonly name: string;
  refreshCase(identifier: CaseIdentifier): Promise<RefreshResult>;
}
