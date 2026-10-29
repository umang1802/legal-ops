import { describe, expect, it } from 'vitest';
import { buildCalendar, escapeText, foldLine } from './ics.js';

describe('iCalendar formatting (RFC 5545)', () => {
  it('escapes backslashes, commas, semicolons and newlines in text', () => {
    expect(escapeText('Sharma, Rao; and \\ co\nline two')).toBe('Sharma\\, Rao\\; and \\\\ co\\nline two');
  });

  it('folds lines longer than 75 octets with CRLF + space, never splitting a character', () => {
    const line = `DESCRIPTION:${'अ'.repeat(40)}`; // 3-byte characters
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  it('builds a CRLF-terminated calendar with timed and all-day events', () => {
    const ics = buildCalendar({
      name: 'LexForgeX · Firm',
      timezone: 'Asia/Kolkata',
      events: [
        { uid: 'a@lexforgex.com', start: { utc: new Date('2026-10-30T05:00:00Z') }, end: { utc: new Date('2026-10-30T06:00:00Z') }, summary: 'CS 1/2026 · A v B', updatedAt: new Date('2026-10-01T00:00:00Z') },
        { uid: 'b@lexforgex.com', start: { date: '2026-10-31' }, end: { date: '2026-11-01' }, summary: 'All day', location: 'Saket Court, Court room 3', description: 'Client: X\nOpen: https://x' },
      ],
      now: new Date('2026-10-29T10:00:00Z'),
    });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(ics).toContain('DTSTART:20261030T050000Z\r\n');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261031\r\n');
    expect(ics).toContain('DTEND;VALUE=DATE:20261101\r\n');
    expect(ics).toContain('LOCATION:Saket Court\\, Court room 3\r\n');
    expect(ics).toContain('DESCRIPTION:Client: X\\nOpen: https://x\r\n');
    expect(ics).toContain('LAST-MODIFIED:20261001T000000Z\r\n');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
});
