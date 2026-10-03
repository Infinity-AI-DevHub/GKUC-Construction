import 'dotenv/config';
import crypto from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { objectStoreClient } from '../lib/storage.js';

const bucket = process.env.R2_BUCKET || '';
const endpoint = process.env.R2_S3_ENDPOINT
  || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
const accessKey = process.env.R2_ACCESS_KEY_ID || '';
const secret = process.env.R2_SECRET_ACCESS_KEY || '';

console.log('R2 configuration (secrets hidden)');
console.log(`  endpoint host: ${endpoint ? new URL(endpoint).host : 'MISSING'}`);
console.log(`  bucket: ${bucket || 'MISSING'}`);
console.log(`  access key: ${accessKey ? `${accessKey.slice(0, 4)}… (${accessKey.length} characters)` : 'MISSING'}`);
console.log(`  secret key: ${secret ? `set (${secret.length} characters)` : 'MISSING'}`);
console.log(`  public base URL: ${process.env.R2_PUBLIC_BASE_URL ? 'set (ignored)' : 'empty'}`);

if (!endpoint || !bucket || !accessKey || !secret) {
  throw new Error('Complete the missing R2 variables before running this diagnostic.');
}

const key = `_siteops-health/${Date.now()}-${crypto.randomUUID()}.txt`;
const body = Buffer.from('GKUC SiteOps R2 write/read/delete check');
let created = false;

try {
  await objectStoreClient().send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: 'text/plain'
  }));
  created = true;
  console.log('  WRITE: success');

  const downloaded = await objectStoreClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const read = Buffer.from(await downloaded.Body.transformToByteArray());
  if (!read.equals(body)) throw new Error('R2 returned different content from the bytes written.');
  console.log('  READ: success');
} catch (error) {
  console.error('  RESULT: failed');
  console.error(`  operation error: ${error.name || 'Error'} (${error.$metadata?.httpStatusCode || 'no HTTP status'})`);
  console.error(`  message: ${error.message}`);
  if (error.name === 'AccessDenied') {
    console.error('  Meaning: Cloudflare received the signed request but this key is not authorised for this endpoint/bucket.');
    console.error('  Verify the endpoint account and bucket jurisdiction, then verify the token is Object Read & Write for this exact bucket.');
  }
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await objectStoreClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      console.log('  DELETE: success');
    } catch (error) {
      console.error(`  DELETE: failed — ${error.name}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
