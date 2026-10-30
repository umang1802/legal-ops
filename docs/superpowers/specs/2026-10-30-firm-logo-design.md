# Firm logo and "Powered by LexForgeX" (design)

**Date:** 30 Oct 2026. **Status:** draft for Umang's review.
**Why:** each firm should see its own brand in LexForgeX, and so should its clients on what they receive. Part of the "firm branding" decided for Phase 1 (L-05: logo, accent colour, sender name, reply-to; "Powered by LexForgeX"; no custom domains). This piece covers the logo and "Powered by LexForgeX" only.

## Decided with Umang
- **The firm uploads its own logo,** if it has one, and can replace or remove it.
- **Inside the app,** the firm's logo shows, with the LexForgeX logo as "Powered by LexForgeX".
- **On things that leave the app,** the logo also appears on printed invoices, receipts, the next-day diary, the matter history, and client emails.
- **"Powered by LexForgeX"** also appears on invoices, receipts and emails ("Yes, add it to invoices, receipts and emails too").

## Calls made by Claude (check these)
1. **PNG or JPG only, up to 1 MB.** I had floated SVG. It's dropped because Gmail and Outlook don't show SVG in emails, and an SVG served from our domain can carry script. No resizing on our side; logos are shown scaled down by CSS and HTML size attributes.
2. **Owners and admins only** (the existing `organization.manage` permission), in **Firm settings**, in a new "Logo" card at the top. Suspended firms can't change it (the existing suspension rule).
3. **No logo uploaded means the firm's name shows** wherever the logo would, as it does today.
4. **Not a switchable feature.** Branding is core, so every firm can use it.
5. **Replacing a logo keeps the old file.** Emails already sent keep showing the logo they were sent with. Removing a logo clears it from the firm, but sent emails keep theirs. The files are tiny.
6. **Out of scope:** accent colour, email sender name and reply-to. The "Firm via LexForgeX" sender name is part of the separate email-safeguards work promised to AWS.

## Where it shows

| Place | What changes |
|---|---|
| **Sidebar** (desktop, every page) | The firm's logo replaces the LexForgeX wordmark at the top, at most 40 px tall and the sidebar's width. The firm-name and role block below it stays. At the bottom of the sidebar, above the user block: a small LexForgeX mark with "Powered by LexForgeX". |
| **Mobile** | The firm's logo in the top bar where the wordmark is now, and "Powered by LexForgeX" at the bottom of the More page. |
| **Invoice and receipt printouts** | The firm's logo at the top left of the firm's heading block, at most 56 px tall. Footer line: "Powered by LexForgeX". |
| **Diary and matter history printouts** | The logo next to the firm name in the header. These are internal and already say "Printed from LexForgeX", so no extra line. |
| **Client emails** (`emailLayout`) | The header shows the logo (`alt` = the firm's name, about 40 px tall, max 200 px wide) instead of the firm name in text. The footer's "Sent via LexForgeX" becomes "Powered by LexForgeX". |
| **Login, accept-invite, reset-password, platform console** | No change: these stay LexForgeX-branded (Phase 1 spec 6.3). |

## How it works
- **Storage.** The logo goes in the existing documents S3 bucket, under `org/<orgId>/branding/<logoId>.<png|jpg>`, where `logoId` is a new random UUID per upload. No new AWS resources. Dev uses the local SeaweedFS store as documents do.
- **Upload.** The browser uploads straight to S3 with a short-lived signed PUT URL, the same pattern as documents. The bucket's CORS already allows PUT from the app. The steps:
  1. The app asks the API to start a logo upload, sending the content type and size.
  2. The API returns a signed URL valid for 5 minutes.
  3. The browser PUTs the file to that URL.
  4. The app tells the API the upload is complete.
  5. The API reads the object and checks it is at most 1 MB and really a PNG or JPG, by its first bytes, not by the name or declared type.
  6. If the checks fail, the API deletes the object and refuses the upload. If they pass, it saves the logo on the firm and records `organization.logo_updated` in the firm's audit log.
- **Removing** a logo clears it from the firm and is audited (`organization.logo_removed`).
- **Data.** New nullable columns on `organizations`: `logo_id UUID` and `logo_type` (`png`|`jpg`). This replaces the Phase 1 spec's `logo_document_id`, which pointed into the documents table; that table is for matter files, with a closed category list, and logos don't belong there.
- **Serving.** A public route, `GET /api/v1/public/logos/<orgId>/<logoId>.<png|jpg>`, needs no sign-in because email apps can't sign in. It streams the object from storage, and only from that firm's `branding/` folder.
  - **Headers:** `Cache-Control: public, max-age=31536000, immutable` (the URL changes whenever the logo changes); `Content-Type` image/png or image/jpeg; `X-Content-Type-Options: nosniff`; `Cross-Origin-Resource-Policy: cross-origin`, so web-based mail apps can load it. Helmet's default would block that.
  - **Unknown files** return 404.
- **Where the URL comes from.** The app, printouts and emails all use the same URL. It's included in `/auth/me` as `organization.logoUrl` and in `GET /organization` as `logoUrl`, or `null` when there's no logo. Emails use the absolute form, built from `APP_URL`.
- **Emails already sent** keep the HTML they were sent with (stored in `notifications`). That's why old logo files are kept (call 5).

## Firm settings: the Logo card
- **With no logo:** "Upload logo" (PNG or JPG, up to 1 MB) and a short line: "Shown in the app, on invoices and receipts, and in emails to clients."
- **With a logo:** a preview on a white background, plus "Replace" and "Remove". Remove asks for confirmation first.
- **Errors** are shown in plain words ("That file isn't a PNG or JPG", "Logos can be up to 1 MB").

## Tests that matter
- **Upload:** a PNG or JPG upload sets the logo, and `/auth/me` and `GET /organization` return its URL.
- **Refused uploads:** a file over 1 MB, or a non-image renamed `.png`, is refused and its object deleted.
- **Permissions:** a lawyer gets 403, and a suspended firm can't upload.
- **Public route:** it serves the logo with the right type and cache headers without a session. Another firm's id, a non-branding key, or an unknown file return 404, and a path like `..%2F` can't escape the firm's `branding/` folder.
- **Replacing:** the old URL still serves, so sent emails keep their logo. After removal, `logoUrl` is null.
- **`emailLayout`:** with a logo, it renders an `<img>` with the absolute URL and alt text. Without one, the firm name in text. Both cases end with "Powered by LexForgeX".
- **Browser check:**
  1. Upload a logo.
  2. Confirm it shows in the sidebar (desktop and mobile), on an invoice and a receipt with "Powered by LexForgeX", on the diary, and in a test client email (Communication shows the rendered HTML).
  3. Remove it and confirm the firm name is back.

## Not now
- Accent colour, sender name and reply-to (rest of L-05).
- Cropping or resizing tools; dark-mode logo variants.
- A logo on the login page (it stays LexForgeX).
