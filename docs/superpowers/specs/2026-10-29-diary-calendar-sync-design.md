# Diary, matter history and calendar sync: design

**Date:** 29 Oct 2026. **Status:** approved in chat by Umang ("Looks good for now but leave room for addition").
**Why:** Vidhimeya's pilot must-have #3 ("Diary management and calendar sync"). Clarified with Umang: "diary" means **both** a printable next-day hearings list (the clerk's board) and a matter history.

## Goals
1. **Printable daily hearings diary** for any date (default: tomorrow in the firm's timezone).
   - Grouped by court, ordered by court room and time.
   - Columns: time · court room · case no. / CNR · parties · client · purpose (stage) · lead lawyer · last date and what happened (the internal note).
   - Two scopes: the whole firm, or only my matters. The usual visibility always applies: lawyers, staff and read-only users see only assigned matters.
   - A4 portrait, black and white, printed through the browser's Print / Save as PDF.
2. **Printable matter history:**
   - matter details and cases
   - chronological hearings (date, result, internal note, client update, next date)
   - the full timeline
3. **Calendar sync:** a personal, read-only, revocable subscribe link (an iCalendar feed) for Google, Outlook and Apple.
   - It covers the user's visible hearings from 30 days ago to 180 days ahead.
   - **"Reset link"** revokes the old link immediately.
   - The feed stops working when the user is removed from the firm or deactivated, or the firm is suspended.
   - A firm setting **"Hide parties in calendar"** replaces parties and the client with the case number only.

## Leave room for additions (explicit requirement)
- **Diary columns** are defined in one ordered list in the web code (`DIARY_COLUMNS`), so adding a column (for example bench or opposing counsel) is a one-entry change. The diary API returns the full hearing record plus its previous hearing, so most new columns need no API change.
- **Calendar event fields** (title, location, description lines) are built in one function, so adding a line is a one-line change.

## Non-goals (for now)
- Two-way calendar sync (Google or Microsoft sign-in): one-way subscription only.
- Server-generated PDFs: browser print is enough.
- Automatic court-status data ("real-time tracking" is a separate, still-open question).

## Decisions
- **The diary includes internal notes**: it's an internal document. Client-facing text never appears in calendars that leave the firm, apart from the case details shown on each event.
- **The feed token** is 32 random bytes, stored only as an HMAC (like sessions), and sent in the URL path. There's one active feed per user per firm.
- **Feed times** are in UTC, computed in Postgres from the firm's timezone. Hearings without a time are all-day events. Cancelled hearings are left out, so they disappear from subscribed calendars.
- **Refresh is up to the calendar app:** Google can take up to about 24 hours, Outlook about 3 hours, Apple 15–60 minutes. The feed hints one hour (`REFRESH-INTERVAL`). The settings page says this plainly.
