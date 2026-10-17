import { describe, expect, it } from 'vitest';
import { internalOnlyUsed, varsForAudience } from './audience.js';

describe('audience scoping', () => {
  const vars = {
    hearing: { date: '10 Oct 2026', outcome: 'SECRET', client_summary: 'Adjourned for reply' },
    previous: { client_update: 'ok', internal_note: 'SECRET', internal_note_phrase: 'Internal note: SECRET' },
  };

  it('strips team-only values for clients without mutating the input', () => {
    const scoped = varsForAudience(vars, 'client');
    expect(scoped.hearing).toEqual({ date: '10 Oct 2026', client_summary: 'Adjourned for reply' });
    expect(scoped.previous).toEqual({ client_update: 'ok' });
    expect(vars.hearing.outcome).toBe('SECRET');
  });

  it('leaves team emails untouched', () => {
    expect(varsForAudience(vars, 'internal')).toBe(vars);
  });

  it('reports team-only variables used in a template, including spaced forms', () => {
    expect(internalOnlyUsed('Hi {{ hearing.outcome }}', null, '{{previous.internal_note_phrase}} {{hearing.date}}')).toEqual([
      'hearing.outcome',
      'previous.internal_note_phrase',
    ]);
  });
});
