import 'dotenv/config';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { checkObjectStore, objectStoreClient, UPLOAD_ROOT } from '../lib/storage.js';

const apply = process.argv.includes('--apply');
const bucket = process.env.R2_BUCKET;

if (process.env.STORAGE_DRIVER !== 'r2') {
  throw new Error('Set STORAGE_DRIVER=r2 before running the migration.');
}

const types = new Map([
  ['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.png','image/png'],['.webp','image/webp'],['.heic','image/heic'],
  ['.pdf','application/pdf'],['.doc','application/msword'],
  ['.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls','application/vnd.ms-excel'],['.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.csv','text/csv'],['.txt','text/plain']
]);

async function walk(folder) {
  const found = [];
  for (const item of await fs.readdir(folder, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (item.name === '.tmp') continue;
    const absolute = path.join(folder, item.name);
    if (item.isDirectory()) found.push(...await walk(absolute));
    else if (item.isFile()) found.push(absolute);
  }
  return found;
}

await checkObjectStore();
const files = await walk(UPLOAD_ROOT);
let copied = 0, skipped = 0, failed = 0;

console.log(`${apply ? 'Migration' : 'Dry run'}: ${files.length} local objects found in ${UPLOAD_ROOT}`);
for (const file of files) {
  const key = path.relative(UPLOAD_ROOT, file).split(path.sep).join('/');
  try {
    const local = await fs.stat(file);
    let remoteSize = null;
    try {
      const remote = await objectStoreClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      remoteSize = Number(remote.ContentLength);
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 404 && error.name !== 'NotFound') throw error;
    }
    if (remoteSize === local.size) {
      skipped += 1;
      console.log(`SKIP  ${key} (already exists with matching size)`);
      continue;
    }
    const action = remoteSize === null ? 'COPY' : 'REPLACE';
    if (!apply) {
      console.log(`${action.padEnd(7)}${key}${remoteSize === null ? '' : ` (R2 ${remoteSize} bytes; local ${local.size} bytes)`}`);
      copied += 1;
      continue;
    }
    const upload = new Upload({ client: objectStoreClient(), params: {
      Bucket: bucket, Key: key, Body: createReadStream(file),
      ContentType: types.get(path.extname(file).toLowerCase()) || 'application/octet-stream'
    }});
    await upload.done();
    copied += 1;
    console.log(`DONE  ${key}${remoteSize === null ? '' : ' (replaced size-mismatched object)'}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${key}: ${error.message}`);
  }
}

console.log(`Finished: ${copied} ${apply ? 'copied' : 'ready to copy'}, ${skipped} already present, ${failed} failed.`);
if (!apply) console.log('Run again with --apply to upload. Local files are intentionally retained as the rollback copy.');
if (failed) process.exitCode = 1;
