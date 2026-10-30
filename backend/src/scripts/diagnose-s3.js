import 'dotenv/config';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  checkObjectStore, storageDriver, storageConfigurationSummary, store, remove,
  downloadToFile, checksumFile, isLocalStore, scratchDir
} from '../lib/storage.js';

if (storageDriver !== 's3' || isLocalStore()) throw new Error('Set STORAGE_DRIVER=s3 before running this diagnostic.');
console.log('Effective storage configuration (no credentials)', storageConfigurationSummary());
console.log('Bucket access is only a preliminary check. Wait for RESULT: PASS.');
await mkdir(scratchDir(), { recursive: true });
const temporary = await mkdtemp(path.join(scratchDir(), 'storage-check-'));
const created = [];
let passed = false;
let phase = 'BUCKET';
try {
  console.log(`${phase}: checking…`);
  await checkObjectStore();
  console.log(`${phase}: success`);
  for (const [label, bytes] of [['SMALL', 1024], ['MULTIPART', 6 * 1024 * 1024]]) {
    const source = path.join(temporary, `${label}.txt`);
    await writeFile(source, Buffer.alloc(bytes, 0x61));
    const expected = await checksumFile(source);
    phase = `${label} WRITE`;
    console.log(`${phase}: uploading ${bytes} bytes through the application upload path…`);
    const saved = await store({ folder: 'project', filename: 'siteops-storage-check.txt',
      mime: 'text/plain', path: source, head: Buffer.alloc(12, 0x61), size: bytes });
    created.push(saved.key);
    console.log(`${phase}: success`);
    phase = `${label} READ / VERIFY`;
    console.log(`${phase}: downloading…`);
    const destination = path.join(temporary, `${label}-download.txt`);
    await downloadToFile(saved.key, destination);
    if (await checksumFile(destination) !== expected) throw new Error('Downloaded content does not match uploaded content');
    console.log(`${phase}: success (SHA-256 matches)`);
  }
  passed = true;
} catch (error) {
  console.error(`RESULT: FAIL at ${phase}`);
  console.error(`${error.name || 'Error'}: ${error.message}`);
  if (error.cause) console.error(`Storage response: ${error.cause.name} (${error.cause.$metadata?.httpStatusCode || 'no HTTP status'})`);
  console.error('Bucket access does not prove write permission. Verify the endpoint, bucket and read/write/delete permissions.');
  process.exitCode = 1;
} finally {
  for (const key of created) {
    try {
      await remove(key);
      console.log('DELETE: success');
    } catch (error) {
      console.error(`DELETE: failed; remove diagnostic object manually: ${key}. ${error.message}`);
      passed = false;
      process.exitCode = 1;
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
if (passed) console.log('RESULT: PASS — small and multipart uploads, content verification and deletion all succeeded.');
