import fs from 'node:fs';
import dotenv from 'dotenv';

export const storageEnvPath = new URL('../../.env', import.meta.url);

/** An explicit driver in backend/.env owns the complete storage connection.
 * PM2 retains old process variables across restarts; never combine those old
 * credentials with a newly selected provider. Other process settings are untouched.
 */
export function applyStorageEnvironment(environment, configured) {
  if (!Object.hasOwn(configured, 'STORAGE_DRIVER')) return 'process environment';
  for (const key of Object.keys(environment)) {
    if (key === 'STORAGE_DRIVER' || /^(S3_|R2_)/.test(key)) delete environment[key];
  }
  for (const [key, value] of Object.entries(configured)) {
    if (key === 'STORAGE_DRIVER' || /^(S3_|R2_)/.test(key)) environment[key] = value;
  }
  return 'backend/.env';
}

let configured = {};
try { configured = dotenv.parse(fs.readFileSync(storageEnvPath)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
export const storageConfigurationSource = applyStorageEnvironment(process.env, configured);
