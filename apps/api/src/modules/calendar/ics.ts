/**
 * Minimal iCalendar (RFC 5545) writer for read-only subscription feeds. Times are emitted in UTC (or as all-day
 * dates), so no VTIMEZONE block is needed. To add a field to every event, extend IcsEvent and `eventLines`.
 */
export type IcsEvent = {
  uid: string;
  start: { utc: Date } | { date: string };
  end: { utc: Date } | { date: string };
  summary: string;
  location?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  updatedAt?: Date | undefined;
};

const CRLF = '\r\n';

export const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Folds a content line at 75 octets (UTF-8), continuing with CRLF + one space, without splitting a character. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const dateValue = (iso: string) => iso.replace(/-/g, '');
const when = (name: 'DTSTART' | 'DTEND', v: IcsEvent['start']) => ('utc' in v ? `${name}:${utcStamp(v.utc)}` : `${name};VALUE=DATE:${dateValue(v.date)}`);

function eventLines(e: IcsEvent, now: Date): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    ...(e.updatedAt ? [`LAST-MODIFIED:${utcStamp(e.updatedAt)}`] : []),
    when('DTSTART', e.start),
    when('DTEND', e.end),
    `SUMMARY:${escapeText(e.summary)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    'END:VEVENT',
  ];
}

export function buildCalendar(c: { name: string; timezone: string; events: IcsEvent[]; now?: Date }): string {
  const now = c.now ?? new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LexForgeX//Hearings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(c.name)}`,
    `X-WR-TIMEZONE:${c.timezone}`,
    // Refresh hints. Calendar apps decide for themselves; Google often takes many hours.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...c.events.flatMap((e) => eventLines(e, now)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
