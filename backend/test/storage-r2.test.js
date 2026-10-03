import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

let server, origin, storage, temporary;
const objects = new Map();

before(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'gkuc-r2-test-'));
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = decodeURIComponent(url.pathname.replace(/^\/test-bucket\/?/, ''));
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
    /* Cloudflare may copy the S3 API with the bucket as its final path segment. */
    STORAGE_DRIVER: 'r2', R2_S3_ENDPOINT: `${origin}/test-bucket`, R2_BUCKET: 'test-bucket',
    R2_ACCESS_KEY_ID: 'test-access', R2_SECRET_ACCESS_KEY: 'test-secret',
    UPLOAD_DIR: temporary, UPLOAD_TMP_DIR: path.join(temporary, '.tmp')
  });
  storage = await import(`../src/lib/storage.js?r2-test=${Date.now()}`);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
});

test('R2 driver stores, signs, downloads and removes private objects', async () => {
  assert.equal(storage.storageDriver, 'r2');
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
