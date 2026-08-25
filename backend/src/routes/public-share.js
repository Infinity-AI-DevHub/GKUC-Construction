import { Router } from 'express';
import { query, getOne } from '../db.js';
import { publicLinkFor } from '../lib/drive-access.js';
import { isLocalStore, localPathFor, signedDownloadUrl } from '../lib/storage.js';
import { fileFamily } from '../lib/drive-files.js';

const router = Router();

/*
 * Files somebody chose to publish.
 *
 * The only part of this system that answers without a session, which is exactly why it is
 * kept small and separate rather than folded in with the rest of the drive. It resolves one
 * token to one file and does nothing else: no listing, no neighbouring items, no hint that
 * anything else exists. Somebody holding a link to a site photograph learns about that
 * photograph and nothing about the company.
 */

/* Tokens are 32 random bytes in base64url. Anything else is not worth a database query. */
const looksLikeToken = token => /^[A-Za-z0-9_-]{43}$/.test(String(token || ''));

/** A rough limit, so a leaked link cannot be turned into a way to hammer the server. */
const hits = new Map();
const tooMany = key => {
  const now = Date.now();
  const window = hits.get(key);
  if (!window || now > window.until) {
    hits.set(key, { count: 1, until: now + 60000 });
    return false;
  }
  window.count += 1;
  return window.count > 120;
};

const resolve = async token => {
  if (!looksLikeToken(token)) return null;
  const row = await getOne(
    'SELECT id FROM drive_items WHERE public_token=? AND kind=?', [token, 'File']);
  return row ? publicLinkFor(row.id) : null;
};

/**
 * What is behind the link, without handing over the file itself.
 *
 * Lets a page show the name, the size and a download button rather than starting a download
 * the moment somebody clicks a link, which is alarming when you do not know what it is.
 */
router.get('/s/:token/meta', async (req, res, next) => {
  try {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many requests. Wait a moment.' });
    const item = await resolve(req.params.token);
    /*
     * The same answer for a token that never existed, one that was withdrawn and one that
     * expired. Distinguishing them would let somebody with a list of guesses learn which
     * were once real.
     */
    if (!item) return res.status(404).json({ error: 'This link is not available' });

    res.json({
      name: item.name,
      size: Number(item.sizeBytes),
      family: fileFamily(item.name, item.mime),
      /* Deliberately absent: who owns it, which folder it is in, when it was uploaded,
         and anything at all about the company. */
      download: `/s/${req.params.token}/download`
    });
  } catch (error) { next(error); }
});

router.get('/s/:token/download', async (req, res, next) => {
  try {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many requests. Wait a moment.' });
    const item = await resolve(req.params.token);
    if (!item) return res.status(404).json({ error: 'This link is not available' });

    /* Counted so an owner can see whether a link is being passed further than they meant. */
    await query('UPDATE drive_items SET public_downloads=public_downloads+1 WHERE id=?', [item.id])
      .catch(() => {});

    res.setHeader('Content-Type', item.mime || 'application/octet-stream');
    /* Always an attachment. Rendering an uploaded file in the browser on this origin would
       let one carry script into the company's own domain. */
    res.setHeader('Content-Disposition',
      `attachment; filename="${String(item.name).replace(/[^\w.\- ]+/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'private, no-store');

    if (isLocalStore()) return res.sendFile(localPathFor(item.storageKey));
    return res.redirect(await signedDownloadUrl(item.storageKey));
  } catch (error) { next(error); }
});

export default router;
