import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/*
 * A streaming multipart reader.
 *
 * The previous reader collected the whole request in memory before parsing it, which is
 * why an upload ceiling existed at all: without one, the bytes a person sent became the
 * memory this process consumed, twice over once the buffer was copied for parsing. Two
 * people attaching large scans at the same time could take the server down for everyone.
 *
 * File parts are written straight to a temporary file as they arrive, so memory stays flat
 * whatever the size. Ordinary form fields are small by nature and are still kept in memory.
 *
 * Written by hand rather than pulled from npm, in keeping with the rest of this codebase:
 * the parsing that matters here is finding a boundary in a byte stream, which is a
 * well-defined job and one worth being able to read.
 */

/** Fields are text; a huge one is a client fault, not a document, and is refused. */
const MAX_FIELD_BYTES = 1024 * 1024;

const CRLF = Buffer.from('\r\n');
const DASH = Buffer.from('--');

const boundaryOf = contentType => {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const value = (match?.[1] || match?.[2] || '').trim();
  return value || null;
};

/** Parses one part's headers into a name, a filename and a content type. */
function describe(headerBlock) {
  const headers = headerBlock.toString('latin1').split('\r\n').filter(Boolean);
  const part = { name: null, filename: null, type: 'application/octet-stream' };
  for (const line of headers) {
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (/^content-disposition$/i.test(key)) {
      /* RFC 6266 allows quoted or bare values; browsers send quoted. */
      part.name = /name="([^"]*)"/i.exec(value)?.[1] ?? null;
      const filename = /filename\*?=(?:UTF-8'')?"?([^";]*)"?/i.exec(value)?.[1];
      if (filename !== undefined) part.filename = decodeURIComponent(filename);
    } else if (/^content-type$/i.test(key)) {
      part.type = value;
    }
  }
  return part;
}

/**
 * Reads a multipart request, writing file parts to temporary files.
 *
 * Returns `{ fields, files }` where each file carries the path it was written to. The
 * caller is responsible for moving or discarding those files — `discard()` is provided so
 * a request that fails validation does not leave anything behind.
 */
export async function readMultipart(req, { maxBytes = 0, tmpDir = os.tmpdir() } = {}) {
  const boundary = boundaryOf(req.headers['content-type']);
  if (!boundary) throw Object.assign(new Error('Expected a file upload'), { status: 400 });

  const marker = Buffer.concat([DASH, Buffer.from(boundary)]);
  await fsp.mkdir(tmpDir, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(tmpDir, 'upload-'));

  const fields = {};
  const files = [];
  let handle = null;
  let current = null;
  let written = 0;
  let total = 0;
  let buffer = Buffer.alloc(0);
  let inPart = false;
  let fieldChunks = [];

  const discard = async () => {
    try { await handle?.close(); } catch { /* already closed */ }
    await fsp.rm(dir, { recursive: true, force: true });
  };

  const openFile = async part => {
    const target = path.join(dir, `${crypto.randomUUID()}.part`);
    handle = await fsp.open(target, 'w');
    current = { ...part, path: target, size: 0, head: null };
    written = 0;
  };

  const closePart = async () => {
    if (!current) {
      if (inPart) {
        const value = Buffer.concat(fieldChunks).toString('utf8');
        if (fieldName) fields[fieldName] = value;
      }
      fieldChunks = [];
      return;
    }
    await handle.close();
    handle = null;
    current.size = written;
    files.push(current);
    current = null;
  };

  let fieldName = null;

  const consumeBody = async chunk => {
    if (current) {
      /* The first bytes are kept so the type can be verified without re-reading the file. */
      if (!current.head) current.head = Buffer.from(chunk.subarray(0, Math.min(chunk.length, 64)));
      else if (current.head.length < 64) {
        current.head = Buffer.concat([current.head, chunk]).subarray(0, 64);
      }
      await handle.write(chunk);
      written += chunk.length;
    } else if (inPart) {
      fieldChunks.push(chunk);
      if (fieldChunks.reduce((sum, part) => sum + part.length, 0) > MAX_FIELD_BYTES) {
        throw Object.assign(new Error('A form field was too large'), { status: 413 });
      }
    }
  };

  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (maxBytes && total > maxBytes) {
        throw Object.assign(new Error(`Files must be ${Math.round(maxBytes / 1048576)}MB or smaller`), { status: 413 });
      }
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

      for (;;) {
        const at = buffer.indexOf(marker);
        if (at === -1) break;

        /*
         * Everything before the boundary belongs to the part being read. The two bytes
         * immediately before it are the CRLF that terminates the part, and are not data.
         */
        if (inPart && at > 0) {
          const end = buffer.subarray(0, at).subarray(0, Math.max(0, at - CRLF.length));
          if (end.length) await consumeBody(end);
        }
        await closePart();
        inPart = false;
        fieldName = null;

        const afterMarker = buffer.subarray(at + marker.length);
        /* "--" after the boundary marks the end of the whole body. */
        if (afterMarker.subarray(0, 2).equals(DASH)) {
          buffer = Buffer.alloc(0);
          return { fields, files, discard, dir };
        }

        const headerEnd = afterMarker.indexOf('\r\n\r\n');
        /* Headers split across chunks: wait for the rest rather than guess. */
        if (headerEnd === -1) { buffer = buffer.subarray(at); break; }

        const part = describe(afterMarker.subarray(0, headerEnd));
        inPart = true;
        if (part.filename !== null && part.filename !== '') {
          await openFile(part);
        } else {
          fieldName = part.name;
          fieldChunks = [];
        }
        buffer = afterMarker.subarray(headerEnd + 4);
      }

      /*
       * Keep back enough to catch a boundary that straddles two chunks, and write out the
       * rest. Without this the parser would either miss a boundary or hold the whole
       * upload in memory again.
       */
      /*
       * Only flush while actually inside a part. Between parts the buffer holds a boundary
       * and the headers that follow it, and those headers can straddle a chunk — flushing
       * then discarded them, because there was nothing to write them to. The part was
       * silently lost, which on a small enough chunk size meant every upload was.
       */
      const keep = marker.length + 4;
      if (inPart && buffer.length > keep) {
        await consumeBody(buffer.subarray(0, buffer.length - keep));
        buffer = Buffer.from(buffer.subarray(buffer.length - keep));
      }
    }
    await closePart();
    return { fields, files, discard, dir };
  } catch (error) {
    await discard();
    /* Drain what is still coming so the refusal reaches a client that is still sending;
       hanging up early arrives as a connection reset instead of a reason. */
    req.resume?.();
    throw error;
  }
}

export { boundaryOf };
