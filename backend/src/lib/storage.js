import crypto from 'node:crypto';
import { readMultipart } from './multipart.js';
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
/*
 * Where half-received uploads and OCR page renders are written.
 *
 * Deliberately inside the upload directory rather than the system temp directory. On a
 * good many Ubuntu servers /tmp is a tmpfs held in RAM, so streaming a large upload there
 * would put it straight back into memory — undoing the whole reason uploads stream to disk
 * at all. Keeping scratch space beside the store guarantees it is on the same real disk.
 */
export const SCRATCH_DIR = process.env.UPLOAD_TMP_DIR
  ? path.resolve(process.env.UPLOAD_TMP_DIR)
  : null;

export const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(workspaceRoot, 'uploads');

/*
 * The application's upload ceiling, in bytes. Zero means no ceiling.
 *
 * Uploads stream to disk rather than being held in memory, so a large file costs disk and
 * time rather than the whole server's memory. That is what makes "no limit" a real option
 * rather than an invitation to be knocked over by a single request. Disk space and the
 * proxy's own client_max_body_size remain the practical bounds.
 */
const configuredMb = process.env.MAX_UPLOAD_MB;
export const MAX_UPLOAD_BYTES = configuredMb === undefined
  ? 15 * 1024 * 1024
  : Number(configuredMb) * 1024 * 1024;

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

/*
 * Where objects are filed in the store. This is a storage concern and nothing else — the
 * attachment routes keep their own list of record types they will accept, because the two
 * are not the same thing: 'gallery' is a place on disk, not something you attach a document
 * to, and treating one list as both made /api/uploads/gallery/:id fall over with a 500.
 */
export const FOLDERS = ['task', 'project', 'employee', 'report', 'vehicle', 'equipment', 'gallery'];

export const isAllowedType = mime => ALLOWED.has(mime);

/*
 * What the bytes say, not what the uploader claims.
 *
 * The content-type on a multipart part is written by the client, so a Windows executable
 * renamed holiday.jpg and labelled image/jpeg passed every check and was then handed back
 * to colleagues by a system they trust. Each accepted format is verified against its own
 * signature instead; the text formats have none, so they are checked for the control bytes
 * that a binary would carry.
 */
const SIGNATURES = {
  'image/jpeg': buffer => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  'image/png': buffer => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': buffer => buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP',
  /* HEIC and its relatives are ISO base media files: a size, then 'ftyp', then a brand. */
  'image/heic': buffer => buffer.subarray(4, 8).toString('latin1') === 'ftyp'
    && /^(heic|heix|hevc|heim|heis|mif1|msf1)/.test(buffer.subarray(8, 12).toString('latin1')),
  'application/pdf': buffer => buffer.subarray(0, 5).toString('latin1') === '%PDF-',
  /* The modern Office formats are zip containers; the legacy ones are OLE compound files. */
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': isZip,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': isZip,
  'application/msword': isOle,
  'application/vnd.ms-excel': isOle,
  'text/csv': isText,
  'text/plain': isText
};

function isZip(buffer) {
  const magic = buffer.subarray(0, 4);
  return magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    || magic.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    || magic.equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
}

function isOle(buffer) {
  return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

/* No signature to match, so the test is the absence of the bytes text does not contain. */
function isText(buffer) {
  const sample = buffer.subarray(0, 4096);
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

/** True when the file's own bytes agree with the type it was sent as. */
export function contentMatchesType(buffer, mime) {
  const check = SIGNATURES[mime];
  /* An accepted type with no verifier would be a hole, so refuse rather than assume. */
  return typeof check === 'function' && buffer.length >= 12 && check(buffer);
}
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
  /*
   * Moves a file already on disk into the store without reading it.
   *
   * A rename is instant and costs no memory, but only works within one filesystem — the
   * temporary directory is often a separate one — so a cross-device move falls back to a
   * copy, which streams rather than loading the file.
   */
  async putFile(key, sourcePath) {
    const destination = path.join(UPLOAD_ROOT, key);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.rename(sourcePath, destination);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fs.copyFile(sourcePath, destination);
      await fs.rm(sourcePath, { force: true });
    }
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
  /*
   * R2 signs each request over a hash of the payload, so the file has to be read to be
   * signed — this one does load it into memory, unlike the local driver.
   *
   * That is acceptable today because the local driver is the one in use, and it is flagged
   * rather than hidden: before switching STORAGE_DRIVER to r2 with large uploads allowed,
   * this wants replacing with S3 multipart upload, which signs and sends in parts.
   */
  async putFile(key, sourcePath, mime) {
    const buffer = await fs.readFile(sourcePath);
    const url = await this.put(key, buffer, mime);
    await fs.rm(sourcePath, { force: true });
    return url;
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

/**
 * A short-lived URL for one object, signed with the same credentials as the writes.
 *
 * The protected download routes need to hand the browser something it can fetch directly —
 * the alternative is streaming every site photograph back through the application. The link
 * carries its own expiry, so the bucket itself stays private and a URL that leaks stops
 * working within minutes rather than never.
 */
export function signedDownloadUrl(key, seconds = 300) {
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw Object.assign(new Error('Object storage is selected but its credentials are not set'), { status: 500 });
  }
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = `/${R2_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${R2_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(seconds),
    'X-Amz-SignedHeaders': 'host'
  });
  /* The signature covers the query string, so it has to be built in sorted order. */
  const canonicalQuery = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();
  let signingKey = hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp);
  for (const part of ['auto', 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const driver = process.env.STORAGE_DRIVER === 'r2' ? r2Driver : localDriver;
export const storageDriver = driver.name;

/**
 * Stores one file and returns the record the database keeps: key, public URL and metadata.
 *
 * Takes either a buffer (small, in-memory content the application generated itself) or a
 * `path` to a file already written to disk by the upload reader, plus the `head` bytes for
 * type verification. The path form never loads the file into memory.
 */
export async function store({ folder, filename, mime, buffer, path: sourcePath, head, size }) {
  if (!FOLDERS.includes(folder)) throw Object.assign(new Error('Unknown upload folder'), { status: 400 });
  if (!isAllowedType(mime)) {
    throw Object.assign(new Error(`Unsupported file type. Allowed: ${allowedExtensions().join(', ')}`), { status: 415 });
  }

  const bytes = buffer ? buffer.length : size;
  if (!bytes) throw Object.assign(new Error('The file is empty'), { status: 400 });

  /* Verified from the first bytes, which the reader kept as the file went past. */
  if (!contentMatchesType(buffer || head, mime)) {
    throw Object.assign(
      new Error('The file contents do not match the type it was sent as, so it was not stored'),
      { status: 415 });
  }
  if (MAX_UPLOAD_BYTES && bytes > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`Files must be ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB or smaller`), { status: 413 });
  }

  const key = buildKey(folder, filename, mime);
  const url = sourcePath
    ? await driver.putFile(key, sourcePath, mime)
    : await driver.put(key, buffer, mime);
  return { key, url, filename: safeName(filename), mime, size: bytes };
}

/**
 * SHA-256 of a file on disk, read in chunks.
 *
 * The gallery fingerprints every photo on arrival so the file behind a record can later be
 * shown to be the file that was received. Hashing has to stream like everything else here,
 * or the one part of the upload path that still loaded the whole file into memory would be
 * the evidence trail.
 */
export async function checksumFile(sourcePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(sourcePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * Reads an uploaded file into memory. Only for content that has to be parsed whole —
 * a spreadsheet being imported — never for stored documents.
 */
export const readUploadedFile = sourcePath => fs.readFile(sourcePath);

/** Scratch space on the same disk as the store. */
export const scratchDir = () => SCRATCH_DIR || path.join(UPLOAD_ROOT, '.tmp');

export const remove = key => driver.remove(key);

/*
 * Where a stored object actually lives, so a route can serve it behind a permission check
 * rather than leaving the whole store open to anyone who knows a URL.
 */
export const localPathFor = key => path.join(UPLOAD_ROOT, key);
export const isLocalStore = () => driver === localDriver;

/**
 * Reads an upload out of a multipart request. Node parses the body itself, so the
 * product carries no third-party multipart dependency.
 */
/**
 * Reads an upload request.
 *
 * File parts are streamed to temporary files, so the request costs disk rather than memory
 * and its size is not bounded by what this process can hold. Each file comes back with the
 * path it was written to and the first bytes of its content, which is all `store()` needs
 * to verify the type without reading the file again.
 *
 * The caller must call `discard()` when finished, so a request that fails validation
 * leaves nothing behind.
 */
export async function readUpload(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    throw Object.assign(new Error('Expected a file upload'), { status: 400 });
  }

  const { fields, files, discard } = await readMultipart(req, {
    maxBytes: MAX_UPLOAD_BYTES,
    tmpDir: scratchDir()
  });
  const named = name => files.find(part => part.name === name) || null;

  const shape = part => part && ({
    filename: part.filename,
    mime: part.type || 'application/octet-stream',
    path: part.path,
    head: part.head,
    size: part.size
  });

  const file = named('file') || files[0] || null;
  if (!file) {
    await discard();
    throw Object.assign(new Error('No file was attached'), { status: 400 });
  }

  /* A gallery upload carries the original and a small preview made in the browser, so the
     grid does not have to pull full-size site photos to draw a thumbnail. */
  return { file: shape(file), thumbnail: shape(named('thumbnail')), fields, discard };
}

