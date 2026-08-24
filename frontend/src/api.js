const TOKEN_KEY = 'gkuc-token';

export const token = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: value => sessionStorage.setItem(TOKEN_KEY, value),
  clear: () => sessionStorage.removeItem(TOKEN_KEY)
};

/**
 * What actually went wrong, in words the person filling the form can act on.
 *
 * A failed validation answers with `error: 'Invalid data'` and an `issues` object holding
 * the real reasons per field. Only the headline was being shown, so every rejected form —
 * a leave request ending before it starts, a quantity out of range — said nothing more
 * than "Invalid data" and left the person to guess which box was wrong.
 */
function readableError(body) {
  /* "endDate" reads as "End date", so the message names the box to go and look at. */
  const label = name => name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, first => first.toUpperCase());

  const fields = body?.issues?.fieldErrors || {};
  const reasons = Object.entries(fields).flatMap(([name, list]) => (list || []).filter(Boolean)
    /* Messages written as whole sentences already say which field they mean. */
    .map(text => (/\s/.test(text.trim()) ? text : `${label(name)}: ${text}`)));
  const form = body?.issues?.formErrors?.filter(Boolean) || [];
  const all = [...form, ...reasons];
  if (all.length) return all.slice(0, 3).join('. ');
  return body?.error || 'Request failed';
}

export const api = async (path, options = {}) => {
  const stored = token.get();
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(stored ? { Authorization: `Bearer ${stored}` } : {}),
        ...options.headers
      }
    });
  } catch {
    /* The server is down or the network dropped. Saying so is more use than the browser's
       own wording, which talks about fetch rather than about the system. */
    throw new Error('Could not reach the server. Check that SiteOps is running, then try again.');
  }

  if (response.status === 204) return null;

  /* Not every reply carries JSON — a gateway error, a restart mid-request, or a crash can
     answer with nothing at all, and parsing that threw "Unexpected end of JSON input" at
     the person instead of telling them what happened. */
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (!response.ok) {
    if (body === null) throw new Error(`The server answered with an error (${response.status}).`);
    throw new Error(readableError(body));
  }
  if (body === null && text) throw new Error('The server sent a reply that could not be read.');
  return body;
};

export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });

/* Formatting shared across every module so figures read the same way everywhere. */
export const money = value => `LKR ${(Number(value || 0) / 1000000).toFixed(1)}M`;
export const rupees = value => `LKR ${Number(value || 0).toLocaleString('en-LK', { maximumFractionDigits: 0 })}`;
export const initials = name => (name || '?').split(' ').map(part => part[0]).slice(0, 2).join('');
export const shortDate = value => (value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
/* A date read back from the API arrives as UTC midnight, so it formats in UTC. */
export const inputDate = value => (value ? new Date(value).toISOString().slice(0, 10) : '');

/**
 * "Today" is the user's local calendar day, matching what the server stores. Using
 * toISOString() here would send the UTC day and record work against the wrong date
 * for anyone east of Greenwich during their morning.
 */
const pad = value => String(value).padStart(2, '0');
export const localDate = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const todayInput = () => localDate();
export const slug = value => String(value || '').toLowerCase().replaceAll(' ', '-').replaceAll('/', '-');

/** Days until a date, used for renewal and deadline copy. */
export const daysUntil = value => Math.ceil((new Date(value) - new Date(todayInput())) / 86400000);
export const dueLabel = value => {
  const remaining = daysUntil(value);
  return remaining < 0 ? `Overdue ${Math.abs(remaining)} days` : `${remaining} days`;
};

/**
 * Uploads a file against a record. Multipart, so the browser sets its own boundary —
 * the JSON content-type header used everywhere else must not be applied here.
 */
/*
 * The largest file the server will store, learned from it at sign-in.
 *
 * Held here rather than hardcoded so the figure quoted to the person matches whatever the
 * server is actually configured with. Until bootstrap has answered, the check is skipped
 * and the server remains the authority — it always was.
 */
let maxUploadMb = null;
export const setUploadLimit = value => { maxUploadMb = Number(value) || null; };

export const upload = async (ownerType, ownerId, file, meta = {}) => {
  /*
   * Refuse an oversized file here, before it is sent.
   *
   * A scanned bidding document can run to tens of megabytes, and a site office pushing one
   * up a mobile connection waits minutes to be told it was never going to be accepted.
   */
  if (maxUploadMb && file.size > maxUploadMb * 1024 * 1024) {
    throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)}MB. `
      + `Files must be ${maxUploadMb}MB or smaller — scan at a lower resolution, or split it into parts.`);
  }

  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(meta)) if (value) form.append(key, value);
  const stored = token.get();
  const response = await fetch(`/api/uploads/${ownerType}/${ownerId}`, {
    method: 'POST',
    headers: stored ? { Authorization: `Bearer ${stored}` } : {},
    body: form
  });

  /*
   * Not every refusal comes from the application.
   *
   * A file larger than the proxy allows is rejected by the proxy itself, which answers with
   * its own HTML error page. Parsing that as JSON threw "Unexpected token '<'" at whoever
   * was trying to attach a scan — a message about the shape of a reply, when what they
   * needed to know was that the file was too big.
   */
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }

  if (!response.ok) {
    if (response.status === 413) {
      throw new Error(body?.error
        || `${file.name} is too large to upload${maxUploadMb ? ` — the limit is ${maxUploadMb}MB` : ''}.`);
    }
    throw new Error(body?.error || `The upload failed (${response.status}).`);
  }
  if (!body) throw new Error('The server sent a reply that could not be read.');
  return body;
};

export const del = path => api(path, { method: 'DELETE' });

export const fileSize = bytes => (bytes >= 1048576
  ? `${(bytes / 1048576).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Opens a server-rendered document (a quotation, an invoice) in its own tab, ready to print
 * or save as a PDF.
 *
 * The document endpoint needs the session token, which a plain link cannot carry — so the
 * page is fetched here and handed to the new tab. The tab is opened first, on the click
 * itself, because a browser only trusts a window opened directly from a person's action;
 * opening it after the fetch returns would be blocked as a popup.
 */
/*
 * Attachments travel with the session, not as public links.
 *
 * The file store is no longer world-readable, so an <img src> or a plain link cannot reach
 * it — the request has to carry the bearer token. The bytes come back as a blob and the
 * caller gets an object URL, which is scoped to this page and expires with it.
 */
export const fetchAttachment = async id => {
  const stored = token.get();
  const response = await fetch(`/api/uploads/file/${id}`, {
    headers: stored ? { Authorization: `Bearer ${stored}` } : {}
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'That file could not be opened');
  }
  return URL.createObjectURL(await response.blob());
};

/** Opens an attachment in a new tab, revoking the temporary URL once it has loaded. */
export const openAttachment = async id => {
  const url = await fetchAttachment(id);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

export const openDocument = async path => {
  const tab = window.open('', '_blank');
  if (tab) tab.document.write('<p style="font:14px sans-serif;padding:20px">Preparing the document…</p>');
  try {
    const stored = token.get();
    const response = await fetch(`/api${path}`, {
      headers: stored ? { Authorization: `Bearer ${stored}` } : {}
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'That document could not be produced');
    }
    const html = await response.text();
    if (!tab) throw new Error('Allow pop-ups for this site to open the document');
    tab.document.open();
    tab.document.write(html);
    tab.document.close();
  } catch (failure) {
    tab?.close();
    throw failure;
  }
};


/**
 * A note that something in the data has changed.
 *
 * Screens are built from two sources: the bootstrap payload the workspace holds, and lists
 * each panel fetches for itself. A form that creates something refreshes the first, but had
 * no way to tell the second — so a new quotation, tender or retention was saved and then
 * simply did not appear until the page was reloaded. This lets the refresh reach both.
 */
const dataListeners = new Set();

export const onDataChanged = listener => {
  dataListeners.add(listener);
  return () => dataListeners.delete(listener);
};

export const announceDataChanged = () => {
  for (const listener of [...dataListeners]) listener();
};
