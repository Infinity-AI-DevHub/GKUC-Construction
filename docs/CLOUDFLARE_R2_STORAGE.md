# Cloudflare R2 storage rollout

SiteOps keeps R2 private. Uploads go directly from the backend to R2 using the S3 API.
Protected downloads pass the SiteOps permission check and stream through the backend, so
Safari, Chrome, Brave and Edge do not depend on public-bucket access or an R2 CORS rule.
Only deliberately published Drive links receive a five-minute signed URL.

## 1. Server environment

Add these values to the production `backend/.env` (or the PM2 environment). Do not commit
the real access key or secret.

```dotenv
STORAGE_DRIVER=r2
R2_S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
R2_BUCKET=YOUR_BUCKET_NAME
R2_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY
R2_PUBLIC_BASE_URL=

# Temporary incoming files and OCR downloads still need local scratch disk.
UPLOAD_DIR=/www/wwwroot/gkuc-construction/uploads
UPLOAD_TMP_DIR=/www/wwwroot/gkuc-construction/uploads/.tmp
```

Use the complete value shown as **S3 API** by Cloudflare for `R2_S3_ENDPOINT`. The API token
needs Object Read and Write access to this bucket. Restrict it to this bucket when creating
the token.

`uploads.gkucconstruction.com` should not be connected directly to this confidential bucket.
A normal R2 custom domain makes an object public to anyone with its URL, bypassing SiteOps
permissions. Leave `R2_PUBLIC_BASE_URL` empty. If the custom domain is required later, put a
Cloudflare Worker in front of it and make that Worker validate a SiteOps-issued token.

## 2. Copy existing local files

Keep the application on local storage during the first copy. On the server, first put the
R2 variables in the environment and set `STORAGE_DRIVER=r2`, but do not restart the running
application yet.

Run a dry check:

```bash
cd /www/wwwroot/gkuc-construction
pnpm --filter @gkuc/backend storage:migrate:r2
```

Review the object count and any failures, then copy:

```bash
pnpm --filter @gkuc/backend storage:migrate:r2:apply
```

The migration preserves every existing storage key, skips objects already in R2 only when
their size matches the local source, replaces size-mismatched objects, and keeps the local
files as a rollback copy. It is safe to rerun.

## 3. Switch and verify

Restart the backend with its updated environment. For PM2, use the deployment's normal
restart command with environment refresh. Then verify all of these with an authorised user:

1. Upload and open an employee attachment.
2. Upload and open a project/gallery image and its thumbnail.
3. Upload and download a tender, subcontractor quotation and BOQ workbook.
4. Upload a searchable PDF and confirm OCR completes.
5. Delete a disposable attachment and confirm it is no longer downloadable.
6. Confirm an unauthorised account cannot open the same attachment route.

Do not remove the local `uploads` directory until the R2 object count and several historical
downloads have been reconciled and a rollback window has passed.
