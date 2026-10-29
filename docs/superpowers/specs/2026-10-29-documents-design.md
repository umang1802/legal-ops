# Documents: bulk upload, storage and access (design)

**Date:** 29 Oct 2026. **Status:** approved in chat by Umang ("go with 500 MB, build it").
**Why:** Vidhimeya pilot must-have #4, "Bulk upload documents". Two uses, both confirmed: bulk case papers when a matter is first brought into LexForgeX, and court orders added after each hearing.

## Goals
- Upload many files at once to a matter: multi-select or a whole folder, with per-file progress, per-file retry, and failures that don't block the rest.
- Each file: optional case, optional hearing, and a category (one batch default that can be changed per file).
- Attach an order to a hearing from the Record outcome sheet, and from the hearing page.
- List per matter with filters (category, case, hearing) and file-name search; view inline or download.
- The printable matter history lists the matter's documents.
- **Limits:**
  - **500 MB per file.** Allowed types: PDF, Word (doc, docx), Excel (xls, xlsx), images (JPG, PNG, HEIC/HEIF) and plain text. Anything else is refused.

## Storage
- **A private S3 bucket**, encrypted at rest with SSE-S3 (the bucket default; the API sends no encryption header).
- **Uploads go straight from the browser to S3** as an S3 multipart upload: 16 MB parts, each with a signed URL valid for 1 hour, and 3 parts in flight at a time. Files never pass through the API server, which has 1 GB of RAM.
- **Every file uses multipart**, even small ones, so there is one code path.
- **On completion**, the API calls `CompleteMultipartUpload`, then `HeadObject`. If the stored size differs from what was declared, or is over 500 MB, the object is deleted and the document marked failed. Signed part URLs don't limit size, so this check is the enforcement.
- **Downloads** use a 5-minute signed GET. `inline` opens PDFs and images in the browser; otherwise the file downloads. Each download is recorded in the audit log.
- **Object key:** `org/<orgId>/matters/<matterId>/<documentId>/<safe file name>`.
- **Development:** SeaweedFS (the `s3` service in `docker-compose.yml`; the MinIO image is no longer public), through the same S3 client with a custom endpoint and path-style addressing. `pnpm dev:storage` creates the bucket and its CORS rule.
- **Bucket settings**, in the runbook:
  - CORS from the app's origin for `PUT`, with `ETag` exposed
  - a lifecycle rule that aborts incomplete multipart uploads after 1 day
  - Block Public Access on

## Data
- The existing `documents` table from migration 0001 holds matter, case and hearing, name, category, mime type, size, storage key, status (`pending → available | failed | deleted`) and soft-delete fields. Migration 0013 adds `upload_id` for the multipart upload ID, plus the closed category set.
- **Categories:** `pleadings`, `orders`, `evidence`, `correspondence`, `authority` (vakalatnama and authority letters), `client_documents`, `other`. The labels live in one map in `@legalops/types`.

## Access
- **Visibility follows the matter** (`matterVisible`); anything else returns 404.
- **Uploading** needs `documents.upload` (owner, admin, lawyer, staff). **Viewing and downloading** need `documents.view`, which includes read-only users.
- **Deleting is a soft delete**, allowed for the uploader or a firm admin (owner or admin). Owners and admins can restore. Each delete and restore is recorded in the audit log and the matter timeline.
- **Suspended firms** can still list and download, because those are GETs. Uploads are blocked by the existing suspension middleware.

## Not now
- Searching inside documents (OCR), virus scanning, sharing with clients, versioning, and a cross-matter "all documents" page.
