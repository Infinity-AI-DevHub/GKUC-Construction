import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { today } from '../db.js';
import { fileURLToPath } from 'node:url';

/**
 * Object storage behind one small interface so the application never knows where a file
 * physically lives. `local` writes into the uploads folder and is the default; `r2`
 * targets Cloudflare R2 over its S3-compatible API. Switching is an environment change,
 * not a code change — nothing above this module deals in file paths.
 */

const workspaceRoot = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
export const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(workspaceRoot, 'uploads');

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024;

/** Only formats a construction office actually files. Anything executable is rejected. */
const ALLOWED = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/heic', 'heic'],
  ['application/pdf', 'pdf'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['text/csv', 'csv'], ['text/plain', 'txt']
]);

export const FOLDERS = ['task', 'project', 'employee', 'report', 'vehicle', 'equipment'];

export const isAllowedType = mime => ALLOWED.has(mime);
export const allowedExtensions = () => [...new Set(ALLOWED.values())];

const safeName = name => (name || 'file')
  .normalize('NFKD')
  .replace(/[^\w.\- ]+/g, '')
  .replace(/\s+/g, '-')
  .slice(-60) || 'file';

/** Storage keys are opaque and unguessable so a leaked URL cannot be walked. */
const buildKey = (folder, filename, mime) => {
  const stamp = today();
  const extension = ALLOWED.get(mime) || path.extname(filename).replace('.', '').toLowerCase() || 'bin';
  const base = safeName(path.basename(filename, path.extname(filename)));
  return `${folder}/${stamp}/${crypto.randomUUID()}-${base}.${extension}`;
};

const localDriver = {
  name: 'local',
  async put(key, buffer) {
    const destination = path.join(UPLOAD_ROOT, key);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, buffer);
    return `/uploads/${key}`;
  },
  async remove(key) {
    await fs.rm(path.join(UPLOAD_ROOT, key), { force: true });
  }
};

/**
 * Cloudflare R2. Enabled by setting STORAGE_DRIVER=r2 with the R2_* variables; it signs
 * requests itself rather than pulling in the AWS SDK for the two calls we make.
 */
const r2Driver = {
  name: 'r2',
  async put(key, buffer, mime) {
    const response = await signedR2Request('PUT', key, buffer, mime);
    if (!response.ok) throw new Error(`R2 upload failed (${response.status})`);
    return process.env.R2_PUBLIC_BASE_URL ? `${process.env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}` : `/uploads/${key}`;
  },
  async remove(key) {
    await signedR2Request('DELETE', key);
  }
};

async function signedR2Request(method, key, body = Buffer.alloc(0), mime = 'application/octet-stream') {
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const url = `https://${host}/${R2_BUCKET}/${key}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, `/${R2_BUCKET}/${key}`, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  const hmac = (key_, data) => crypto.createHmac('sha256', key_).update(data).digest();
  let signingKey = hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp);
  for (const part of ['auto', 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return fetch(url, {
    method,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(method === 'PUT' ? { 'content-type': mime, 'content-length': String(body.length) } : {})
    },
    body: method === 'PUT' ? body : undefined
  });
}

const driver = process.env.STORAGE_DRIVER === 'r2' ? r2Driver : localDriver;
export const storageDriver = driver.name;

/** Stores one file and returns the record the database keeps: key, public URL and metadata. */
export async function store({ folder, filename, mime, buffer }) {
  if (!FOLDERS.includes(folder)) throw Object.assign(new Error('Unknown upload folder'), { status: 400 });
  if (!isAllowedType(mime)) {
    throw Object.assign(new Error(`Unsupported file type. Allowed: ${allowedExtensions().join(', ')}`), { status: 415 });
  }
  if (!buffer.length) throw Object.assign(new Error('The file is empty'), { status: 400 });
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`Files must be ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB or smaller`), { status: 413 });
  }
  const key = buildKey(folder, filename, mime);
  const url = await driver.put(key, buffer, mime);
  return { key, url, filename: safeName(filename), mime, size: buffer.length };
}

export const remove = key => driver.remove(key);

/**
 * Reads an upload out of a multipart request. Node parses the body itself, so the
 * product carries no third-party multipart dependency.
 */
export async function readUpload(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    throw Object.assign(new Error('Expected a file upload'), { status: 400 });
  }
  /* Buffered rather than streamed so the size ceiling is enforced before any parsing work. */
  const chunks = [];
  let received = 0;
  let tooBig = false;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES + 8192) {
      /* Stop keeping the data, but keep reading it. Memory stays bounded either way, and
         draining the rest is what lets the refusal reach a client that is still sending —
         hanging up early reaches it as a connection reset instead of a reason. */
      tooBig = true;
      chunks.length = 0;
      continue;
    }
    if (!tooBig) chunks.push(chunk);
  }
  if (tooBig) {
    throw Object.assign(new Error(`Files must be ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB or smaller`), { status: 413 });
  }
  const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw Object.assign(new Error('No file was attached'), { status: 400 });
  return {
    file: { filename: file.name, mime: file.type || 'application/octet-stream', buffer: Buffer.from(await file.arrayBuffer()) },
    fields: Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string'))
  };
}
