export function greeting(timeZone: string, now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone }).format(now),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function longDate(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(now);
}

export function initials(first: string, last?: string | null): string {
  return `${first[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase();
}

/** 'YYYY-MM-DD' (a calendar date, no timezone) -> '12 Oct 2026'. */
export function formatDate(date: string | null | undefined, opts: { weekday?: boolean } = {}): string {
  if (!date) return '—';
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(opts.weekday ? { weekday: 'short' } : {}),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(iso),
  );
}

export function fullName(u: { firstName: string; lastName: string | null } | null | undefined): string {
  return u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—';
}

/** '14:05' -> '2:05 pm'. */
export function formatTime(time: string | null | undefined): string {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  const suffix = h! >= 12 ? 'pm' : 'am';
  return `${((h! + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 'Today' / 'Tomorrow' / 'Yesterday' / 'Mon, 12 Oct 2026' relative to the firm's today. */
export function relativeDay(date: string, today: string, opts: { short?: boolean } = {}): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  if (date === addDays(today, -1)) return 'Yesterday';
  if (opts.short) {
    const [y, m, d] = date.split('-').map(Number);
    return new Intl.DateTimeFormat('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: '2-digit' } : {}),
      timeZone: 'UTC',
    })
      .format(new Date(Date.UTC(y!, m! - 1, d!)))
      .replace(/,/g, '');
  }
  return formatDate(date, { weekday: true });
}

/** The firm's local date right now. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
