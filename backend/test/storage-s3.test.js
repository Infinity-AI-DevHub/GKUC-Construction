import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

let server, origin, storage, temporary;
const objects = new Map();
const multipart = new Map();

before(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'gkuc-s3-test-'));
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.match(req.headers.authorization || '', /test-access\/\d{8}\/default\/s3\/aws4_request/);
    assert.ok(url.pathname.startsWith('/test-bucket'));
    const key = decodeURIComponent(url.pathname.replace(/^\/test-bucket\/?/, ''));
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      multipart.set(key, new Map());
      return res.writeHead(200, { 'content-type': 'application/xml' }).end(
        '<InitiateMultipartUploadResult><Bucket>test-bucket</Bucket><Key>' + key + '</Key><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>');
    }
    if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      const parts = [...multipart.get(key).entries()].sort((a, b) => a[0] - b[0]);
      objects.set(key, Buffer.concat(parts.map(([, body]) => body)));
      multipart.delete(key);
      return res.writeHead(200, { 'content-type': 'application/xml' }).end('<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>');
    }
    if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
      assert.ok(Number(req.headers['content-length']) > 0);
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      return req.on('end', () => {
        multipart.get(key).set(Number(url.searchParams.get('partNumber')), Buffer.concat(chunks));
        res.writeHead(200, { etag: '"part"' }).end();
      });
    }
    if (req.method === 'HEAD') return res.writeHead(key && !objects.has(key) ? 404 : 200).end();
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      return req.on('end', () => { objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { etag: '"test"' }).end(); });
    }
    if (req.method === 'GET' && objects.has(key)) {
      const body = objects.get(key);
      return res.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream' }).end(body);
    }
    if (req.method === 'DELETE') { objects.delete(key); return res.writeHead(204).end(); }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    /* Contabo uses the base endpoint and path-style buckets. */
    STORAGE_DRIVER: 's3', S3_ENDPOINT: origin, S3_BUCKET: 'test-bucket',
    S3_REGION: 'default', S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: 'test-access', S3_SECRET_ACCESS_KEY: 'test-secret',
    UPLOAD_DIR: temporary, UPLOAD_TMP_DIR: path.join(temporary, '.tmp')
  });
  storage = await import(`../src/lib/storage.js?s3-test=${Date.now()}`);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
});

test('Contabo S3 driver stores, signs, downloads and removes private objects', async () => {
  assert.equal(storage.storageDriver, 's3');
  assert.equal(await storage.objectStoreClient().config.forcePathStyle, true);
  assert.equal((await storage.checkObjectStore()).bucket, 'test-bucket');

  const source = path.join(temporary, 'source.txt');
  await writeFile(source, 'private siteops document');
  const stored = await storage.store({ folder: 'project', filename: 'evidence.txt', mime: 'text/plain',
    path: source, head: Buffer.from('private siteops document'), size: 24 });
  assert.equal(objects.get(stored.key).toString(), 'private siteops document');

  const signed = await storage.signedDownloadUrl(stored.key, 60, {
    filename: 'evidence report.txt', mime: 'text/plain', disposition: 'attachment'
  });
  assert.match(signed, /^http:\/\/127\.0\.0\.1:/);
  assert.match(signed, /X-Amz-Signature=/);
  const signedUrl = new URL(signed);
  assert.equal(signedUrl.searchParams.get('response-content-type'), 'text/plain');
  assert.match(signedUrl.searchParams.get('response-content-disposition'), /^attachment;/);

  const destination = path.join(temporary, 'downloaded.txt');
  await storage.downloadToFile(stored.key, destination);
  assert.equal(await readFile(destination, 'utf8'), 'private siteops document');

  const response = new PassThrough();
  const streamed = [];
  response.headersSent = false;
  response.setHeader = (name, value) => { response.headers ||= {}; response.headers[name] = value; };
  response.on('data', chunk => streamed.push(chunk));
  await storage.pipeStoredObject(stored.key, response);
  assert.equal(Buffer.concat(streamed).toString(), 'private siteops document');
  assert.equal(response.headers['Content-Length'], '24');

  await storage.remove(stored.key);
  assert.equal(objects.has(stored.key), false);
});

test('S3 refuses missing credentials and insecure production endpoints', async () => {
  const secret = process.env.S3_SECRET_ACCESS_KEY;
  delete process.env.S3_SECRET_ACCESS_KEY;
  const missing = await import(`../src/lib/storage.js?missing=${Date.now()}`);
  assert.throws(() => missing.objectStoreClient(), /credentials are not set/);
  process.env.S3_SECRET_ACCESS_KEY = secret;
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const insecure = await import(`../src/lib/storage.js?insecure=${Date.now()}`);
    assert.throws(() => insecure.objectStoreClient(), /HTTPS in production/);
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
  }
});


test('S3 streams multipart uploads with known lengths and preserves all bytes', async () => {
  const source = path.join(temporary, 'large.txt');
  const body = Buffer.alloc(6 * 1024 * 1024, 0x61);
  await writeFile(source, body);
  const saved = await storage.store({ folder: 'project', filename: 'large.txt', mime: 'text/plain',
    path: source, size: body.length, head: body.subarray(0, 12) });
  assert.deepEqual(objects.get(saved.key), body);
  await storage.remove(saved.key);
});

test('storage permission failures carry a safe actionable public code', async () => {
  const client = storage.objectStoreClient();
  const send = client.send;
  client.send = async () => { throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }); };
  try {
    await assert.rejects(storage.store({ folder: 'project', filename: 'denied.txt', mime: 'text/plain', buffer: Buffer.from('a valid text file') }),
      error => error.status === 503 && error.publicCode === 'STORAGE_UNAVAILABLE' && /permissions/.test(error.message));
  } finally { client.send = send; }
});
