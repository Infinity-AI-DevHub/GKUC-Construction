import 'dotenv/config';
import crypto from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { objectStoreClient, objectStoreBucket, checkObjectStore, storageDriver } from '../lib/storage.js';

const bucket = objectStoreBucket();
if (storageDriver !== 's3') throw new Error('Set STORAGE_DRIVER=s3 before running this diagnostic.');
await checkObjectStore();
console.log('S3 bucket connection: success (credentials hidden)');

const key = `_siteops-health/${Date.now()}-${crypto.randomUUID()}.txt`;
const body = Buffer.from('GKUC SiteOps S3 write/read/delete check');
let created = false;

try {
  await objectStoreClient().send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: 'text/plain'
  }));
  created = true;
  console.log('  WRITE: success');

  const downloaded = await objectStoreClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const read = Buffer.from(await downloaded.Body.transformToByteArray());
  if (!read.equals(body)) throw new Error('S3 returned different content from the bytes written.');
  console.log('  READ: success');
} catch (error) {
  console.error('  RESULT: failed');
  console.error(`  operation error: ${error.name || 'Error'} (${error.$metadata?.httpStatusCode || 'no HTTP status'})`);
  console.error(`  message: ${error.message}`);
  if (error.name === 'AccessDenied') {
    console.error('  Meaning: The object store received the signed request but this key is not authorised for this endpoint/bucket.');
    console.error('  Verify the endpoint, bucket and credentials allow reading, writing and deleting objects.');
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
