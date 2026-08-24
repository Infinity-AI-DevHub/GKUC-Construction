import { query, getOne } from '../db.js';
import { canOcr, extractText, ocrAvailable } from './ocr.js';
import { isLocalStore, localPathFor } from './storage.js';
import { publish } from './realtime.js';

/*
 * The background reader.
 *
 * Reading a forty-page scan takes minutes, so it cannot happen while somebody waits for
 * their upload to finish. The file is stored and usable immediately; its text arrives
 * afterwards and the screen is told when it does.
 *
 * One job at a time, deliberately. Tesseract is CPU-bound and will happily use every core
 * it is given; on the single VPS this runs on, that would make the whole application
 * unresponsive while somebody's scan is read.
 */

const POLL_MS = Number(process.env.OCR_POLL_MS || 5000);
const MAX_ATTEMPTS = 3;

let running = false;
let timer = null;

/** Adds an attachment to the queue, if its type is one we can read. */
export async function enqueue(attachmentId, mime) {
  if (!canOcr(mime)) return false;
  await query(
    'INSERT INTO ocr_jobs (attachment_id,status) VALUES (?,?) ON DUPLICATE KEY UPDATE status=?, attempts=0, detail=NULL',
    [attachmentId, 'Queued', 'Queued']);
  /* Do not wait for the next poll when the machine is idle. */
  setImmediate(() => drain().catch(error => console.error('OCR queue failed', error)));
  return true;
}

async function processOne(job) {
  const attachment = await getOne(
    'SELECT id,owner_type ownerType,owner_id ownerId,storage_key storageKey,mime,filename FROM attachments WHERE id=?',
    [job.attachment_id]);

  if (!attachment) {
    await query("UPDATE ocr_jobs SET status='Skipped', detail=?, finished_at=NOW() WHERE id=?",
      ['The attachment was removed before it could be read', job.id]);
    return;
  }

  /*
   * Reading needs the file on this machine. With object storage that means fetching it
   * first; until R2 is switched on, everything is local and the path is known.
   */
  if (!isLocalStore()) {
    await query("UPDATE ocr_jobs SET status='Skipped', detail=?, finished_at=NOW() WHERE id=?",
      ['Remote object storage is in use; reading it here is not implemented yet', job.id]);
    return;
  }

  const result = await extractText(localPathFor(attachment.storageKey), attachment.mime);

  await query(
    `INSERT INTO attachment_text (attachment_id,content,source,pages,characters)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE content=VALUES(content), source=VALUES(source),
       pages=VALUES(pages), characters=VALUES(characters), extracted_at=NOW()`,
    [attachment.id, result.text, result.source, result.pages, result.text.length]);

  await query("UPDATE ocr_jobs SET status='Done', detail=NULL, finished_at=NOW() WHERE id=?", [job.id]);

  /* The screen showing that attachment can stop saying "reading…". */
  publish('ocr', {
    attachmentId: attachment.id,
    ownerType: attachment.ownerType,
    ownerId: attachment.ownerId,
    filename: attachment.filename,
    characters: result.text.length,
    pages: result.pages,
    source: result.source
  });
}

/** Works through everything queued, one job at a time. */
export async function drain() {
  if (running) return 0;
  const { ready } = await ocrAvailable();
  if (!ready) return 0;

  running = true;
  let done = 0;
  try {
    for (;;) {
      const job = await getOne(
        "SELECT id,attachment_id,attempts FROM ocr_jobs WHERE status='Queued' AND attempts < ? ORDER BY id LIMIT 1",
        [MAX_ATTEMPTS]);
      if (!job) break;

      await query("UPDATE ocr_jobs SET status='Running', attempts=attempts+1, started_at=NOW() WHERE id=?", [job.id]);
      try {
        await processOne(job);
        done += 1;
      } catch (error) {
        /*
         * A failure is recorded against the job and retried, up to a point. Past that it
         * stays Failed with the reason attached, because a document that cannot be read is
         * something a person should be able to see rather than something that quietly
         * disappears from the queue.
         */
        const attempts = job.attempts + 1;
        const finished = attempts >= MAX_ATTEMPTS;
        await query('UPDATE ocr_jobs SET status=?, detail=?, finished_at=? WHERE id=?',
          [finished ? 'Failed' : 'Queued', String(error.message).slice(0, 500),
            finished ? new Date() : null, job.id]);
        if (!finished) break;   /* let the next poll retry rather than spinning on it */
      }
    }
  } finally {
    running = false;
  }
  return done;
}

/** Starts the poller. Anything left Running from a restart is put back in the queue. */
export async function startOcrWorker() {
  const { ready, detail } = await ocrAvailable();
  if (!ready) {
    console.warn(`OCR is off: ${detail}`);
    return null;
  }
  await query("UPDATE ocr_jobs SET status='Queued' WHERE status='Running'");
  const tick = () => drain().catch(error => console.error('OCR queue failed', error));
  tick();
  timer = setInterval(tick, POLL_MS);
  timer.unref();
  return timer;
}

export const stopOcrWorker = () => { clearInterval(timer); timer = null; };
